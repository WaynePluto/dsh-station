import { Buffer } from 'node:buffer'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Logger } from 'pino'
import {
  TUNNEL_CONTROL_PATH,
  TUNNEL_STREAM_PATH,
} from '@dsh-station/protocol'
import { AUTH_PATH_PREFIX } from '../admin/auth-app.js'
import {
  ADMIN_PATH_PREFIX,
  type AdminConsoleRequestListener,
  type AdminConsoleSession,
} from '../admin/console-app.js'
import { PAGE_CSP, type PageAppearance } from '../admin/shared.js'
import {
  isSetupPath,
  renderSetupRequiredPage,
  SETUP_PATH_PREFIX,
} from '../admin/setup-app.js'
import { readThemePreference, resolveThemeSwitch, THEME_PATH } from '../admin/theme.js'
import { ADMIN_THEME_EVENTS_PATH } from '../admin/theme-client.js'
import type { BrowserAuthenticator } from '../auth/browser.js'
import type { BrowserCookiePolicy } from '../auth/cookies.js'
import { isLoopbackBrowserRequest } from '../auth/loopback.js'
import type { RelayConfig } from '../config.js'
import { proxyHttpRequest } from './proxy.js'
import { servePublicAsset } from './public-assets.js'
import { redirectToLogin, rejectSocket, sendHttp } from './responses.js'
import { checkBrowserRequest, isPublicDomainHost } from './security.js'
import { proxyWebSocketUpgrade } from './upgrade.js'
import type { TunnelServer } from '../tunnel/server.js'

/** 一个 listener 为哪台机器提供服务；成员端口会把目标固定为 memberSlug。 */
export interface BrowserListenerRoute {
  readonly memberSlug: string | undefined
}

/** 主端口不固定目标，由 Host 和配置中的 directSlug 解析机器。 */
export const MAIN_LISTENER: BrowserListenerRoute = { memberSlug: undefined }

type RequestListener = (request: IncomingMessage, response: ServerResponse) => Promise<void>

type BrowserTunnel = Pick<
  TunnelServer,
  'registry' | 'handleControlUpgrade' | 'handleStreamUpgrade'
>

/**
 * 浏览器 listener 需要的业务依赖。该模块只负责 HTTP/upgrade 分派，
 * 认证、隧道、设置向导和控制台仍由调用方构建并通过回调注入。
 */
export interface BrowserListenerOptions {
  readonly config: RelayConfig
  readonly logger: Logger
  readonly cookies: BrowserCookiePolicy
  readonly browserAuth: BrowserAuthenticator | undefined
  readonly authRequestListener: RequestListener | undefined
  readonly setupWizard: RequestListener
  readonly adminConsole: AdminConsoleRequestListener
  readonly tunnel: BrowserTunnel
  readonly relayInitialized: () => boolean
  readonly mainListenPort: () => number
}

function requestPath(req: IncomingMessage): URL | undefined {
  try {
    return new URL(req.url ?? '/', 'http://relay.invalid')
  } catch {
    return undefined
  }
}

/**
 * 成员端口上的控制台统一回到主端口，保持单一控制台 origin 和 CSRF cookie。
 * 无法解析原始 Host 时退回原路径，沿用普通浏览器重定向的安全默认值。
 */
function adminConsoleUrl(
  req: IncomingMessage,
  config: RelayConfig,
  mainPort: number,
  consolePath: string,
): string {
  const host = req.headers.host
  if (host === undefined) return consolePath
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return consolePath
  }
  const defaultPort = config.publicScheme === 'https' ? 443 : 80
  const authority = mainPort === defaultPort ? hostname : `${hostname}:${String(mainPort)}`
  return `${config.publicScheme}://${authority}${consolePath}`
}

function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PATH_PREFIX || pathname.startsWith(`${ADMIN_PATH_PREFIX}/`)
}

function sendSetupRequired(
  res: ServerResponse,
  appearance: PageAppearance,
  mainListenPort: () => number,
): void {
  const body = renderSetupRequiredPage(
    `http://127.0.0.1:${String(mainListenPort())}${SETUP_PATH_PREFIX}`,
    appearance,
  )
  res.writeHead(503, {
    'cache-control': 'no-store',
    'content-security-policy': PAGE_CSP,
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/**
 * 构建一个完整的浏览器 HTTP/upgrade listener。
 * @param route 此 listener 固定服务的机器；主端口传入 MAIN_LISTENER。
 * @param options 已构建的认证、控制台、设置向导和隧道依赖。
 * @returns 尚未开始监听的 server。
 */
export function createBrowserServer(
  route: BrowserListenerRoute,
  options: BrowserListenerOptions,
): http.Server {
  const {
    config,
    logger,
    cookies,
    browserAuth,
    authRequestListener,
    setupWizard,
    adminConsole,
    tunnel,
    relayInitialized,
    mainListenPort,
  } = options

  async function handleBrowserRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = requestPath(req)
    if (path === undefined) {
      sendHttp(res, 400, 'bad request')
      return
    }
    const requestCookies = cookies.forRequest(req)
    if (path.pathname === TUNNEL_CONTROL_PATH || path.pathname === TUNNEL_STREAM_PATH) {
      // connector 始终拨号主端口；成员端口只承载面向一台机器的浏览器流量。
      if (route.memberSlug !== undefined) {
        sendHttp(res, 404, 'not found')
        return
      }
      sendHttp(res, 426, 'WebSocket upgrade required')
      return
    }
    // 目标是固定配置，因此成员端口的控制台重定向不会泄露机器状态。
    if (route.memberSlug !== undefined && isAdminPath(path.pathname)) {
      res.writeHead(302, {
        location: adminConsoleUrl(req, config, mainListenPort(), path.pathname),
        'cache-control': 'no-store',
        'content-length': 0,
      })
      res.end()
      return
    }

    if (servePublicAsset(path.pathname, req.method, res)) return

    // 外观切换在认证和初始设置门控前响应，登录页和设置向导都需要它。
    if (path.pathname === THEME_PATH) {
      const result = resolveThemeSwitch({ method: req.method, url: path, cookies: requestCookies })
      if (result.kind === 'error') {
        sendHttp(res, result.status, result.message)
        return
      }
      res.writeHead(303, {
        location: result.location,
        'cache-control': 'no-store',
        'content-length': 0,
        'set-cookie': result.setCookie,
      })
      res.end()
      return
    }

    /** 此请求的页面使用的外观，并返回到当前 URL。 */
    const appearance: PageAppearance = {
      theme: readThemePreference(requestCookies, req.headers.cookie),
      returnTo: req.url ?? '/',
    }

    // 账号存在前：设置向导只接管管理页、登录页和 /_setup 自身（且仅 loopback）；
    // 本机业务请求按「loopback socket + loopback Host 免登录」的既有语义直接放行，
    // 首次打开不需要先创建管理员——只有使用远程能力（管理页）时才被引导完成设置。
    const setupPending = browserAuth !== undefined && !relayInitialized()
    const setupOwned = setupPending
      ? isSetupPath(path.pathname)
        || isAdminPath(path.pathname)
        || path.pathname.startsWith(`${AUTH_PATH_PREFIX}/`)
      : isSetupPath(path.pathname)
    if (setupPending || isSetupPath(path.pathname)) {
      if (browserAuth === undefined) {
        sendHttp(res, 404, 'not found')
        return
      }
      if (!isLoopbackBrowserRequest(req)) {
        if (setupPending) {
          sendSetupRequired(res, appearance, mainListenPort)
          return
        }
        res.writeHead(302, {
          location: ADMIN_PATH_PREFIX,
          'cache-control': 'no-store',
          'content-length': 0,
        })
        res.end()
        return
      }
      if (setupOwned) {
        await setupWizard(req, res)
        return
      }
      // setupPending 的本机业务请求继续走下方流程：
      // authorize 对 loopback 请求直接豁免，不需要账号。
    }

    // 成员端口保留认证页面，使登录后仍能回到原本要访问的机器。
    if (path.pathname.startsWith(`${AUTH_PATH_PREFIX}/`)) {
      if (authRequestListener === undefined) {
        sendHttp(res, 503, 'browser authentication is not configured')
        return
      }
      await authRequestListener(req, res)
      return
    }

    let setCookieHeaders: readonly string[] = []
    let session: AdminConsoleSession = { userId: null, username: null, setCookieHeaders: [] }
    if (browserAuth === undefined) {
      if (!isLoopbackBrowserRequest(req)) {
        sendHttp(res, 503, 'browser authentication is not configured')
        return
      }
    } else {
      const authorization = await browserAuth.authorize(req)
      if (!authorization.ok) {
        if (path.pathname === ADMIN_THEME_EVENTS_PATH) { sendHttp(res, 401, authorization.message); return }
        if (req.method === 'GET' || req.method === 'HEAD') redirectToLogin(req, res)
        else sendHttp(res, authorization.status, authorization.message)
        return
      }
      setCookieHeaders = authorization.setCookieHeaders
      session = authorization.exempt
        ? { userId: null, username: null, setCookieHeaders }
        : {
            userId: authorization.principal.userId,
            username: authorization.principal.username,
            sessionId: authorization.principal.sessionId,
            setCookieHeaders,
          }
    }

    // relay 拥有 /_admin，在认证后响应且绝不路由进隧道。
    if (isAdminPath(path.pathname)) {
      await adminConsole(req, res, session)
      return
    }
    if (setCookieHeaders.length !== 0) res.setHeader('set-cookie', setCookieHeaders)

    if (
      (req.method === 'GET' || req.method === 'HEAD')
      && path.pathname === '/'
      && isPublicDomainHost(req.headers.host, config)
    ) {
      res.writeHead(302, {
        location: ADMIN_PATH_PREFIX,
        'cache-control': 'no-store',
        'content-length': 0,
      })
      res.end()
      return
    }

    // 必须先完成认证，再检查原始 Host、Origin 和 sec-fetch-site。
    const check = checkBrowserRequest(req, config, route.memberSlug)
    if (!check.ok) {
      sendHttp(res, check.status, check.message)
      return
    }
    await proxyHttpRequest({
      req,
      res,
      slug: check.slug,
      registry: tunnel.registry,
      logger,
      appearance,
      setCookieHeaders,
    })
  }

  async function handleBrowserUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    let setCookieHeaders: readonly string[] = []
    // 没有管理员的 relay 无法授权浏览器 socket：远程 socket 依旧拒绝，
    // 本机 loopback 的 WebSocket（内置窗口的 /api/remote.mux）按免登录语义放行。
    const setupPending = browserAuth !== undefined && !relayInitialized()
    if (setupPending) {
      if (!isLoopbackBrowserRequest(req)) {
        rejectSocket(socket, 503, 'relay setup is not complete')
        return
      }
    } else if (browserAuth === undefined) {
      if (!isLoopbackBrowserRequest(req)) {
        rejectSocket(socket, 503, 'browser authentication is not configured')
        return
      }
    } else {
      const authorization = await browserAuth.authorize(req)
      if (!authorization.ok) {
        rejectSocket(socket, authorization.status, authorization.message)
        return
      }
      setCookieHeaders = authorization.setCookieHeaders
    }

    const check = checkBrowserRequest(req, config, route.memberSlug)
    if (!check.ok) {
      rejectSocket(socket, check.status, check.message)
      return
    }
    await proxyWebSocketUpgrade({
      req,
      browserSocket: socket,
      browserHead: head,
      slug: check.slug,
      registry: tunnel.registry,
      logger,
      setCookieHeaders,
    })
  }

  const server = http.createServer((req, res) => {
    void handleBrowserRequest(req, res).catch((error: unknown) => {
      logger.error({ err: error, path: req.url }, 'unhandled relay HTTP request error')
      if (!res.headersSent) sendHttp(res, 500, 'internal server error')
      else res.destroy(error instanceof Error ? error : undefined)
    })
  })

  server.on('upgrade', (req, socket, head) => {
    const path = requestPath(req)
    if (path === undefined) {
      rejectSocket(socket, 404, 'not found')
      return
    }
    if (path.pathname === TUNNEL_CONTROL_PATH || path.pathname === TUNNEL_STREAM_PATH) {
      if (route.memberSlug !== undefined) {
        rejectSocket(socket, 404, 'not found')
        return
      }
      if (path.pathname === TUNNEL_CONTROL_PATH) {
        tunnel.handleControlUpgrade(req, socket, head)
        return
      }
      const token = path.searchParams.get('token')
      if (token === null || token === '') {
        rejectSocket(socket, 403, 'forbidden')
        return
      }
      tunnel.handleStreamUpgrade(req, socket, head, token)
      return
    }
    if (
      path.pathname.startsWith(`${AUTH_PATH_PREFIX}/`)
      || isAdminPath(path.pathname)
      || isSetupPath(path.pathname)
      || path.pathname === THEME_PATH
    ) {
      rejectSocket(socket, 404, 'not found')
      return
    }

    socket.pause()
    void handleBrowserUpgrade(req, socket, head).catch((error: unknown) => {
      logger.error({ err: error, path: req.url }, 'unhandled relay WebSocket upgrade error')
      if (!socket.destroyed) rejectSocket(socket, 503, 'tunnel unavailable')
    })
  })

  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 5_000
  return server
}
