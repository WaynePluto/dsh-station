import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import pino, { type Logger } from 'pino'
import { createAuthRequestListener } from './admin/auth-app.js'
import { createAdminConsoleRequestListener } from './admin/console-app.js'
import { createSetupRequestListener } from './admin/setup-app.js'
import { NativeTheme } from './admin/native-theme.js'
import { ThemeEvents } from './admin/theme-events.js'
import { BrowserAuthenticator } from './auth/browser.js'
import { BrowserCookiePolicy } from './auth/cookies.js'
import { DeviceAuthenticator } from './auth/device.js'
import { isLegacyPasswordHash } from './auth/password.js'
import type { AuthenticationService } from './auth/service.js'
import { resolveRelayConfig, type RelayConfig, type RelayConfigInput } from './config.js'
import { ensureSelfMembership } from './membership/index.js'
import {
  createBrowserServer,
  MAIN_LISTENER,
  type BrowserListenerOptions,
} from './http/browser-listener.js'
import { MemberPortListeners } from './http/member-ports.js'
import type { RelayStore } from './store/store.js'
import { TunnelServer } from './tunnel/server.js'

export { MANIFEST_PATH } from './http/public-assets.js'

export interface RelayServer {
  readonly config: RelayConfig
  readonly logger: Logger
  readonly httpServer: HttpServer
  readonly tunnel: TunnelServer
  readonly browserAuth: BrowserAuthenticator | undefined
  /** 每台成员机器增加一个 listener；hub 自身仍使用主端口。 */
  readonly memberPorts: MemberPortListeners
  listen(): Promise<AddressInfo>
  close(): Promise<void>
}

/**
 * 构建 relay HTTP server、隧道和浏览器认证层。
 * @param input relay 配置；构建任何对象前会先校验。
 * @param options 已打开的 relay store，以及可选 logger 和浏览器
 * 认证服务。复用 store 而不是重新打开，使单个 SQLite handle 持有数据库。
 * @returns 组装完成的 relay server。
 */
export function createRelayServer(
  input: RelayConfigInput,
  options: { store: RelayStore; logger?: Logger; authentication?: AuthenticationService },
): RelayServer {
  const config = resolveRelayConfig(input)
  const logger = options.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' })
  if ((config.browserAuth === undefined) !== (options.authentication === undefined)) {
    throw new Error('browserAuth config and authentication service must be provided together')
  }

  // 即使没有认证服务也要构建：管理控制台仍需要 loopback-only 开发模式下的 CSRF cookie 策略。
  const cookies = new BrowserCookiePolicy(
    config.browserAuth?.cookieMode === 'domain-https' && config.publicDomain !== undefined
      ? { mode: 'domain-https', domain: config.publicDomain }
      : { mode: 'lan-http' },
  )
  const browserAuth = config.browserAuth === undefined || options.authentication === undefined
    ? undefined
    : new BrowserAuthenticator({ service: options.authentication, cookies })
  const authRequestListener = browserAuth === undefined
    ? undefined
    : createAuthRequestListener({ authenticator: browserAuth, publicScheme: config.publicScheme })

  let memberPorts: MemberPortListeners | undefined
  // 配置端口可能为 0；只有绑定地址才知道控制台实际位于哪里。
  let mainListenPort = config.port

  const tunnel = new TunnelServer({
    devices: new DeviceAuthenticator({
      store: options.store,
      logger,
      // 直接响应注册事件，才能让成员端口保持同步而无需轮询设备表。
      onEnrolled: (device) => {
        void memberPorts?.ensure(device.machineId).catch((error: unknown) => {
          logger.error(
            { err: error, machineId: device.machineId, slug: device.slug },
            'failed to open the browser port for a newly enrolled machine',
          )
        })
      },
    }),
    logger,
    // 「请求上线」送达后即完成使命；正常会话上线时清掉过期标记。
    clearWakeup: (machineId) => {
      options.store.clearWakeup(machineId)
    },
    ...config.streamConnectTimeoutMs === undefined
      ? {}
      : { streamConnectTimeoutMs: config.streamConnectTimeoutMs },
  })

  const setupWizard = createSetupRequestListener({
    cookies,
    store: options.store,
    authenticator: browserAuth,
    logger,
  })
  // store 不提供删除用户的方式，因此初始设置状态是单向门。
  let initialized = options.store.countUsers() !== 0
  function relayInitialized(): boolean {
    if (!initialized && options.store.countUsers() !== 0) initialized = true
    return initialized
  }

  const nativeTheme = new NativeTheme(config.home, logger)
  const themeEvents = new ThemeEvents(nativeTheme, options.store, config)
  const adminConsole = createAdminConsoleRequestListener({
    cookies,
    store: options.store,
    registry: tunnel.registry,
    config,
    logger,
    nativeTheme,
    themeEvents,
    memberPort: machineId => memberPorts?.portOf(machineId),
    onDeviceRevoked: (machineId) => {
      void memberPorts?.release(machineId).catch((error: unknown) => {
        logger.error({ err: error, machineId }, 'failed to close the browser port of a revoked machine')
      })
    },
    mainListenPort: () => mainListenPort,
  })

  const browserListenerOptions: BrowserListenerOptions = {
    config,
    logger,
    cookies,
    browserAuth,
    authRequestListener,
    setupWizard,
    adminConsole,
    tunnel,
    relayInitialized,
    mainListenPort: () => mainListenPort,
  }
  const createListener = (route: Parameters<typeof createBrowserServer>[0]): HttpServer =>
    createBrowserServer(route, browserListenerOptions)

  const httpServer = createListener(MAIN_LISTENER)
  memberPorts = new MemberPortListeners({
    store: options.store,
    config,
    logger,
    createServer: slug => createListener({ memberSlug: slug }),
  })
  const members = memberPorts

  return {
    config,
    logger,
    httpServer,
    tunnel,
    browserAuth,
    memberPorts: members,
    listen: async () => {
      nativeTheme.start()
      const address = await new Promise<AddressInfo>((resolve, reject) => {
        const onError = (error: Error): void => reject(error)
        httpServer.once('error', onError)
        httpServer.listen(config.port, config.host, () => {
          httpServer.off('error', onError)
          const listenAddress = httpServer.address()
          if (listenAddress === null || typeof listenAddress === 'string') {
            reject(new Error('relay did not receive a TCP listen address'))
            return
          }
          mainListenPort = listenAddress.port
          if (config.browserAuth?.cookieMode === 'lan-http') {
            logger.warn(
              'HIGH RISK: lan-http authentication sends passwords and session cookies without TLS; development use only',
            )
          }
          // scrypt 切换前写入的哈希已无法验证，启动时明确提示而不是让它表现成神秘的登录失败。
          const legacy = options.store.listUsers()
            .filter((user: { passwordHash: string }) => isLegacyPasswordHash(user.passwordHash))
          if (legacy.length !== 0) {
            logger.warn(
              { users: legacy.map((user: { username: string }) => user.username) },
              'these accounts still hold a pre-scrypt password hash and cannot log in; reset each one with `dsh-station-relay passwd`',
            )
          }
          logger.info(
            { host: config.host, port: listenAddress.port, publicDomain: config.publicDomain },
            'relay listening',
          )
          resolve(listenAddress)
        })
      })
      // 先于成员端口同步：directSlug 路由与本机地址都依赖 connector
      // 注册，而 connector 要等 membership 里出现自挂条目才会拨号。
      // 写不进文件只降级本机直达链路，控制台照常服务，因此记录后继续。
      if (config.directSlug !== undefined) {
        try {
          ensureSelfMembership({
            store: options.store,
            home: config.home,
            slug: config.directSlug,
            relayPort: address.port,
            logger,
          })
        } catch (error) {
          logger.error(
            { err: error, home: config.home, slug: config.directSlug },
            'could not self-join this machine to its own relay; its own address will not open dsh until the file is writable',
          )
        }
      }
      // 早期运行中注册的成员机器会在此恢复 listener，因此书签中的端口在 relay 重启后仍能工作。
      await members.syncFromStore()
      return address
    },
    close: async () => {
      themeEvents.close()
      nativeTheme.close()
      browserAuth?.close()
      tunnel.close()
      await members.closeAll()
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error === undefined ? resolve() : reject(error))
        httpServer.closeAllConnections()
      })
    },
  }
}
