/**
 * @dsh-station/launcher —— 被控机上的双击入口。
 *
 * 职责（见 docs/06-packaging.md §3）：
 *   - 检测 Node 版本
 *   - 确保自有 dsh profile 存在（D14），spawn 内嵌的 dsh（D13）
 *   - spawn 本机 relay：每台机器都既能当入口又能被打开（D16），本机控制台也是
 *     给本机设置远程入口的唯一地方，所以它不可关闭
 */

/**
 * 其余职责：
 *   - spawn connector；挂到哪台入口机器上由 membership.json 决定（D16）
 *   - 首次运行不在终端问密码：管理员由 relay 的浏览器设置向导创建（只对 127.0.0.1
 *     开放），launcher 只负责在没有管理员时把那个地址显眼地打出来
 *   - 在终端打印访问地址，不自动开浏览器（D6）
 *   - Ctrl+C 时按 connector → relay → dsh 的顺序关闭；Windows 上用 taskkill /T /F 杀进程树
 */

import process from 'node:process'
import { join } from 'node:path'
import { Command } from 'commander'
import type { DshRestartStatus, MembershipHub } from '@dsh-station/protocol'
import { renderBanner } from './banner.js'
import { createDesktopLink, type DesktopLink, type DesktopPhase, type DesktopUrls } from './desktop-link.js'
import { acquireInstanceLock, type InstanceLock } from './instance-lock.js'
import { CONNECTOR_CHILD, DSH_CHILD, RELAY_CHILD } from './children.js'
import { loadLauncherConfig } from './config.js'
import { connectorArguments, resolveConnectorEntry } from './connector.js'
import {
  dshArguments,
  dshTokenFromLine,
  DSH_READY_TIMEOUT_MS,
  DSH_TOKEN_ENV_NAME,
  DSH_TOKEN_TIMEOUT_MS,
  launcherDirectory,
  preparePnpmShim,
  resolveBundledModulesDirectory,
  resolveDshBin,
  skippedBundleFromLine,
  resolveDshInstallAnchor,
  resolvePnpmCli,
  resolvePnpmVersion,
  waitForDsh,
  withBundledPnpmPath,
} from './dsh.js'
import {
  dshRestartStatusFilePath,
  watchMembershipTrust,
  writeDshRestartStatus,
  type TrustChange,
} from './dsh-restart.js'
import { resolveDshPluginOverlays, SHELL_PLUGIN_PACKAGE_NAMES } from './dsh-plugins.js'
import { LauncherError } from './errors.js'
import { JWT_SECRET_ENV_NAME, jwtSecretFilePath, loadOrCreateJwtSecret } from './jwt-secret.js'
import { isSelfHub, membershipFilePath, readMembership } from './membership.js'
import { assertSupportedNodeVersion } from './node-version.js'
import { DISTRIBUTION_PACKAGE_NAMES } from './plugin-catalog.js'
import { DSH_STATION_PROFILE_BUNDLES, ensureProfile, profileDirectory, resolveDshHome } from './profile.js'
import { resolvePluginMediaDirectory, synchronizePluginDistributions } from './plugin-lifecycle.js'
import { relayArguments, resolveRelayEntry } from './relay.js'
import { relayAdminInitialized } from './relay-admin.js'
import { createSupervisor, type ChildExit } from './supervisor.js'
import { lanAddress, trustedHostsFor } from './trusted-hosts.js'
import { LAUNCHER_VERSION } from './version.js'



function say(message: string): void {
  console.log(`[dsh-station] ${message}`)
}

function describeHosts(values: readonly string[]): string {
  return values.join('、')
}

function reportFailure(error: unknown): void {
  if (error instanceof LauncherError) {
    console.error(`\n[dsh-station] ${error.message}`)
    if (error.hint !== undefined) console.error(`           ${error.hint}`)
    console.error('')
    return
  }
  console.error(error)
}

function reportChildExit(exit: ChildExit): void {
  const how = exit.signal === null ? `退出码 ${String(exit.code ?? '未知')}` : `收到信号 ${exit.signal}`
  console.error(`\n[dsh-station] ${exit.name} 意外退出（${how}），正在停止 dsh-station。`)
  // 启动期间退出的子进程几乎总是配置错误，而且它自己的
  // 消息会准确说明问题；launcher 摘要从来不会。
  if (exit.recent.length === 0) {
    console.error(`[dsh-station] ${exit.name} 没有输出任何日志，上面也就没有更多线索。`)
    console.error('')
    return
  }
  console.error(`[dsh-station] ${exit.name} 最后 ${String(exit.recent.length)} 行输出：`)
  for (const line of exit.recent) console.error(`           ${line}`)
  console.error('')
}

/**
 * 启动 dsh、这台机器的 relay 和 connector，打印地址块，
 * 并持续运行到用户中断或某个子进程退出。
 * @param argv - 不含 node/脚本前缀的命令行参数。
 * @returns 进程退出码。
 */
export async function run(argv: readonly string[]): Promise<number> {
  const program = new Command()
    .name('dsh-station')
    .description('启动 dsh、本机控制台与 dsh-station 隧道连接器')
    .version(LAUNCHER_VERSION)
    .option('--config <path>', '配置文件路径（默认读取当前目录的 dsh-station.config.json）')
    .option('--desktop', '由桌面壳托管：向 stdout 输出结构化状态行，从 stdin 接收控制命令')
    .allowExcessArguments(false)
    .parse([...argv], { from: 'user' })
  const options = program.opts<{ config?: string; desktop?: boolean }>()

  const desktop: DesktopLink = createDesktopLink(argv)
  /** 桌面状态：URL 与管理员状态一旦确定就随每次阶段上报携带。 */
  let desktopUrls: DesktopUrls | undefined
  let desktopAdminReady: boolean | undefined
  /** 本机模式（D25）：桌面壳托管时默认不启动 relay/connector，远程按需启用。CLI 全量。 */
  const localMode = desktop.enabled
  /** 本机模式下已捕获的 dsh token：start-remote 时给 connector，emit 时给壳代发。 */
  let dshTokenValue: string | undefined
  const emit = (phase: DesktopPhase, detail?: string): void => {
    desktop.emit({
      type: 'status',
      protocol: 1,
      phase,
      pid: process.pid,
      ...detail === undefined ? {} : { detail },
      ...desktopUrls === undefined ? {} : { urls: desktopUrls },
      ...desktopAdminReady === undefined ? {} : { adminReady: desktopAdminReady },
      ...dshTokenValue === undefined ? {} : { dshToken: dshTokenValue },
      remoteEnabled: remoteStarted,
    })
  }

  const { config, path: configPath } = loadLauncherConfig({
    cwd: process.cwd(),
    configPath: options.config,
  })
  say(configPath === undefined ? '没有找到配置文件，使用默认配置。' : `已读取配置 ${configPath}`)

  const lock: InstanceLock = acquireInstanceLock(config.home)
  /** 本机模式下远程服务是否已按需启用（D25）；emit 的每次 status 都携带。 */
  let remoteStarted = false
  desktopUrls = {
    // 本机模式：local 先指 dsh 直连地址（壳用它代发 token 交换）；启用远程后切回 relay。
    local: localMode
      ? `http://127.0.0.1:${String(config.dsh.port)}/`
      : `http://127.0.0.1:${String(config.relay.port)}/`,
    admin: `http://127.0.0.1:${String(config.relay.port)}/_admin`,
    dsh: `http://127.0.0.1:${String(config.dsh.port)}/`,
  }
  emit('config', configPath ?? undefined)

  const membershipPath = membershipFilePath(config.home)
  const membership = readMembership(membershipPath)
  // relay 启动时会把本机挂到它自己身上（自动维护的自挂条目），
  // 它支撑本机与局域网地址直达 dsh，但不是操作员设置的远程入口：
  // banner 与 trusted hosts 都按「没有远程入口」处理。
  const hub: MembershipHub | undefined = isSelfHub(membership?.hub) ? undefined : membership?.hub

  const dshHome = resolveDshHome()
  const { bootstrap } = ensureProfile({
    home: dshHome,
    profile: config.dsh.profile,
    bundles: DSH_STATION_PROFILE_BUNDLES,
  })
  say(bootstrap === 'created'
    ? `已创建 dsh profile ${profileDirectory(dshHome, config.dsh.profile)}`
    : `使用已有的 dsh profile ${profileDirectory(dshHome, config.dsh.profile)}`)

  const dshBin = resolveDshBin()
  const pnpmCli = resolvePnpmCli()
  const pnpmShimDirectory = preparePnpmShim(join(config.home, 'runtime', 'pnpm-bin'), pnpmCli)
  const dshEnvironment = withBundledPnpmPath(process.env, pnpmCli, pnpmShimDirectory)
  // 插件同步在 relay 启动之后进行（见下方 emit('relay') 处的说明）。

  // Mode A：relay 原样转发浏览器的 Host，因此 dsh 必须信任
  // 浏览器可能用来访问这台机器的每个 authority（铁律 7）。
  const lan = lanAddress()
  // 域名模式下这台机器的公网入口是 https://<slug>.<域名>，
  // 由本机 relay 自己服务；不配置 domain 时它不存在。
  const publicAuthority = config.relay.domain === undefined
    ? undefined
    : `${config.relay.slug}.${config.relay.domain}`
  const trustedHosts = trustedHostsFor({
    lanAddress: lan,
    ...publicAuthority === undefined ? {} : { publicAuthority },
    hubAuthority: hub?.browserAuthority,
  })
  say(`dsh 信任的地址：${trustedHosts.join('、')}`)

  // 所有四项都在启动任何子进程前解析：不完整的包
  // 必须在尚无运行中进程可清理时报告。
  const dshPatchFiles = resolveDshPluginOverlays()
  const relayEntry = resolveRelayEntry()
  const connectorEntry = resolveConnectorEntry()
  say(`dsh 插件：壳级注入 ${SHELL_PLUGIN_PACKAGE_NAMES.join('、')}；第三方 Bundle ${String(DISTRIBUTION_PACKAGE_NAMES.length)} 个`)

  // 从不写入日志：此密钥会签名每个控制台会话。
  // 本机模式（D25）延后到启用远程时再创建：只用 dsh 的用户不需要这个文件。
  const loadJwtSecret = (): NodeJS.ProcessEnv => {
    const jwtSecret = loadOrCreateJwtSecret(
      jwtSecretFilePath(config.home),
      message => console.warn(`[dsh-station] ${message}`),
    )
    return { ...process.env, [JWT_SECRET_ENV_NAME]: jwtSecret }
  }

  let shuttingDown = false
  // membership 监视器创建后赋值；shutdown 先释放它，退出路径上不再触发 dsh 重启。
  let stopTrustWatcher: (() => void) | undefined
  // 由下面的 executor 同步赋值；之所以可选只是因为
  // 编译器看不出来这一点。
  let settle: ((code: number) => void) | undefined
  const finished = new Promise<number>((resolvePromise) => { settle = resolvePromise })
  const supervisor = createSupervisor({
    onUnexpectedExit: (exit) => {
      reportChildExit(exit)
      emit('failed', `${exit.name} 意外退出`)
      void shutdown(1)
    },
  })
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    emit('stopping')
    // stdin 是活跃 handle：不先关掉，事件循环会在所有子进程回收后仍挂住
    // （进程迟迟不退，桌面壳只能等宽限期后强杀）。
    desktop.close()
    stopTrustWatcher?.()
    // 按反向启动顺序停止：connector 在它拨号的 relay 消失前停止拨号，
    // dsh 随后退出，最先启动的隧道枢纽 relay 最后回收。
    await supervisor.stopAll()
    lock.release()
    settle?.(code)
  }
  // 在第一个子进程存在前就注册：启动期间的 Ctrl+C 也必须
  // 停止子进程，而不是让它们成为孤儿。
  const onSignal = (): void => { void shutdown(0) }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  // dsh 0.1.2 自己认证浏览器：它打印每进程登录 token，没有该 token 换取的
  // cookie 的每个 /api 请求都是 401。connector 将它报告给 relay，relay 通过
  // dsh 自己的交换流程将已经认证的浏览器送入一次。token 每个进程都不同，
  // 因此按名重启 dsh 后必须重新捕获，并连带重启 connector 让它上报新值。
  let noteDshToken: ((token: string) => void) | undefined
  let dshToken: Promise<string | undefined> = new Promise((resolvePromise) => {
    noteDshToken = resolvePromise
  })
  let dshTokenSeen = false
  const startDshChild = (hosts: readonly string[]): void => {
    dshTokenSeen = false
    dshToken = new Promise((resolvePromise) => { noteDshToken = resolvePromise })
    supervisor.start({
      name: DSH_CHILD,
      command: process.execPath,
      args: dshArguments({
        dshBin,
        profile: config.dsh.profile,
        port: config.dsh.port,
        trustedHosts: hosts,
        patchFiles: dshPatchFiles,
        extraArgs: config.dsh.extraArgs,
      }),
      env: dshEnvironment,
      onLine: (line) => {
        // dsh 0.1.7 对损坏 Bundle 是「stderr 诊断 + 跳过」而非启动失败；
        // dsh-station 依赖全部插件在位，这里把静默降级转成响亮警告。
        const skipped = skippedBundleFromLine(line)
        if (skipped !== undefined) {
          console.error(`[dsh-station] dsh 跳过了一个插件 Bundle（页面将缺少对应功能）：${skipped}`)
        }
        if (dshTokenSeen) return
        const token = dshTokenFromLine(line)
        if (token === undefined) return
        dshTokenSeen = true
        dshTokenValue = token
        noteDshToken?.(token)
      },
    })
  }
  // relay 先于插件同步与 dsh 启动：桌面壳在 relay 端口开始监听时即 302 放行
  // 初始导航，插件同步（首次或介质内容变化时约 15 秒）与 dsh 就绪前的等待
  // 由 relay 自己的重试页承担。relay 不依赖 profile/插件状态，先起没有
  // 顺序风险；connector 仍等 dsh 的登录 token。
  // 本机模式（D25）跳过：relay 与 connector 由「启用远程服务」按需补起。
  const startRelayChild = (): void => {
    supervisor.start({
      name: RELAY_CHILD,
      command: process.execPath,
      args: relayArguments(relayEntry, {
        host: config.relay.host,
        port: config.relay.port,
        slug: config.relay.slug,
        ...config.relay.domain === undefined ? {} : { domain: config.relay.domain },
        data: config.relay.data,
        home: config.home,
      }),
      env: loadJwtSecret(),
    })
  }
  if (!localMode) {
    emit('relay')
    startRelayChild()
  }

  if (config.dsh.profile === 'dsh-station-web') {
    emit('plugins')
    // 同步可能失败（介质缺失、pnpm 报错），而 relay 已经在跑：
    // 失败必须走 shutdown 收掉它，不能把异常抛给顶层退出路径留下孤儿。
    try {
      const mediaDirectory = resolvePluginMediaDirectory({ launcherDirectory: launcherDirectory() })
      const pluginSync = await synchronizePluginDistributions({
        home: dshHome,
        profile: config.dsh.profile,
        mediaDirectory,
        installAnchor: resolveDshInstallAnchor(),
        runtimeModulesDirectory: resolveBundledModulesDirectory(pnpmCli),
        profileCreated: bootstrap === 'created',
        packageManager: { command: process.execPath, args: [pnpmCli], version: resolvePnpmVersion(pnpmCli) },
        onOutput: text => process.stdout.write(text),
      })
      say(`插件介质：${mediaDirectory}`)
      if (pluginSync.migrated) say('已把旧受管 Bundle 迁移为可卸载的第三方插件。')
      if (pluginSync.skippedRemoved.length > 0) say(`${pluginSync.skippedRemoved.join('、')} 已被卸载，本次不自动补回。`)
    } catch (error) {
      reportFailure(error)
      await shutdown(1)
      return finished
    }
  }

  emit('dsh')
  startDshChild(trustedHosts)

  const ready = await waitForDsh({
    port: config.dsh.port,
    giveUp: () => shuttingDown || !supervisor.isRunning(DSH_CHILD),
  })
  if (!ready) {
    if (!shuttingDown) {
      console.error(`\n[dsh-station] dsh 在 60 秒内没有在 127.0.0.1:${String(config.dsh.port)} 上就绪。`)
      console.error('           上面 [dsh] 开头的输出是它的原始日志；常见原因是端口被占用，或 profile 里的插件装不上。')
    }
    await shutdown(1)
    return finished
  }

  // 端口会在插件树稳定前响应，而 token 行稍后才出现；
  // 如果 token 始终没到，机器仍提供除
  // dsh 自己的登录交换外的所有服务，因此这里等待但不失败。
  const token = await Promise.race([
    dshToken,
    new Promise<undefined>((resolvePromise) => {
      setTimeout(() => resolvePromise(undefined), DSH_TOKEN_TIMEOUT_MS).unref()
    }),
  ])
  if (token === undefined && !shuttingDown) {
    console.warn('[dsh-station] 没有从 dsh 的输出里读到登录 token；通过 relay 访问时可能会看到 dsh 自己的 401。')
  }

  const startConnectorChild = (loginToken: string | undefined): void => {
    supervisor.start({
      name: CONNECTOR_CHILD,
      command: process.execPath,
      args: connectorArguments(connectorEntry, {
        home: config.home,
        dshPort: config.dsh.port,
      }),
      ...loginToken === undefined ? {} : { env: { ...process.env, [DSH_TOKEN_ENV_NAME]: loginToken } },
    })
  }
  if (!localMode) startConnectorChild(token)

  // membership 变化改变 dsh 必须信任的地址集合时自动重启 dsh，并连带重启
  // connector 上报新 token；relay 与本机地址不变，无需重启。进度写入
  // 状态文件，本机控制台的「远程入口」页会读取并展示它。
  const restartStatusPath = dshRestartStatusFilePath(config.home)
  const writeRestartStatus = (status: Omit<DshRestartStatus, 'at'>): void => {
    try {
      writeDshRestartStatus(restartStatusPath, { ...status, at: Date.now() })
    } catch (error) {
      console.warn(`[dsh-station] 写入 dsh 重启状态失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const describeChange = (change: TrustChange): string => [
    ...change.added.length === 0 ? [] : [`新增信任 ${describeHosts(change.added)}`],
    ...change.removed.length === 0 ? [] : [`移除信任 ${describeHosts(change.removed)}`],
  ].join('，')

  let restartBusy = false
  let queuedChange: TrustChange | undefined
  const restartForTrust = async (change: TrustChange): Promise<void> => {
    emit('restarting', '远程入口变更，正在重启 dsh')
    say(`远程入口变更（${describeChange(change)}），正在自动重启 dsh；期间本机的 dsh 短暂不可用。`)
    writeRestartStatus({ state: 'restarting', added: [...change.added], removed: [...change.removed] })
    try {
      await supervisor.stop(DSH_CHILD)
      if (shuttingDown) return
      startDshChild(change.next)
      const readyAgain = await waitForDsh({
        port: config.dsh.port,
        giveUp: () => shuttingDown || !supervisor.isRunning(DSH_CHILD),
      })
      // 重启后自行退出的 dsh 走 supervisor 的意外退出路径（整个程序停下并
      // 打印它的输出）；这里只兜住“进程还在却迟迟不就绪”。
      if (!readyAgain) {
        throw new Error(`dsh 重启后没有在 ${String(DSH_READY_TIMEOUT_MS / 1000)} 秒内就绪`)
      }
      if (shuttingDown) return
      const freshToken = await Promise.race([
        dshToken,
        new Promise<undefined>((resolvePromise) => {
          setTimeout(() => resolvePromise(undefined), DSH_TOKEN_TIMEOUT_MS).unref()
        }),
      ])
      if (freshToken === undefined) {
        console.warn('[dsh-station] 重启后没有从 dsh 的输出里读到登录 token；通过 relay 访问时可能会看到 dsh 自己的 401。')
      }
      await supervisor.stop(CONNECTOR_CHILD)
      if (shuttingDown) return
      startConnectorChild(freshToken)
      writeRestartStatus({ state: 'done', added: [...change.added], removed: [...change.removed] })
      say('dsh 已自动重启完成，信任地址已更新。')
      emit('ready')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeRestartStatus({
        state: 'failed',
        added: [...change.added],
        removed: [...change.removed],
        error: message,
      })
      console.error(`[dsh-station] 自动重启 dsh 失败：${message}`)
      console.error('           请右键托盘图标选择「重启」（或手动重启本程序）后重试。')
    }
  }
  const applyTrustChange = (change: TrustChange): void => {
    if (shuttingDown) return
    if (restartBusy) {
      // 重启进行中到达的变更只保留最新的：这轮结束后按它再重启一次。
      queuedChange = change
      return
    }
    restartBusy = true
    void (async () => {
      try {
        await restartForTrust(change)
      } finally {
        restartBusy = false
        const queued = queuedChange
        queuedChange = undefined
        if (queued !== undefined) applyTrustChange(queued)
      }
    })()
  }
  stopTrustWatcher = watchMembershipTrust({
    path: membershipPath,
    initial: trustedHosts,
    compute: (next) => {
      const nextHub = isSelfHub(next?.hub) ? undefined : next?.hub
      return trustedHostsFor({
        lanAddress: lan,
        ...publicAuthority === undefined ? {} : { publicAuthority },
        hubAuthority: nextHub?.browserAuthority,
      })
    },
    onChange: applyTrustChange,
    onError: error => console.warn(`[dsh-station] ${error instanceof Error ? error.message : String(error)}`),
  }).close

  // 拒绝配置的 relay 会在几毫秒内退出；此时打印
  // banner 会把唯一有用的错误行埋掉。
  // 本机模式（D25）不打印 banner：relay 未监听，地址块只会误导。
  if (!localMode && !shuttingDown) {
    // 在这里询问而不是启动时询问：新机器上 relay 会自己创建
    // 数据库，因此更早的回答会对一个尚不存在的文件说“没有管理员”。
    // 不可读数据库与缺失数据库含义相同：
    // 仍需在浏览器中完成设置。
    const adminReady = relayAdminInitialized(config.relay.data)
    console.log(renderBanner({
      dshPort: config.dsh.port,
      relayPort: config.relay.port,
      relayHost: config.relay.host,
      machine: config.relay.slug,
      lanAddress: lan,
      ...publicAuthority === undefined ? {} : { publicUrl: `https://${publicAuthority}` },
      hub,
      adminReady,
    }))
    desktopAdminReady = adminReady
  } else if (localMode) {
    say('本机模式：远程服务未启动；从桌面壳托盘「启用远程服务」按需启用。')
  }

  /**
   * 按需启用远程服务（D25，幂等）：补起 relay 与 connector，本机入口切回
   * relay。connector 自带指数退避重连，relay 冷启动期间的首拨失败会自行
   * 恢复；进程退出即回收，下次启动仍是本机模式，不记忆该状态。
   */
  const startRemoteServices = (): void => {
    if (remoteStarted || shuttingDown) return
    remoteStarted = true
    emit('remote', '正在启用远程服务（relay + connector）')
    say('正在启用远程服务（relay + connector）……')
    startRelayChild()
    startConnectorChild(dshTokenValue)
    desktopUrls = {
      local: `http://127.0.0.1:${String(config.relay.port)}/`,
      admin: `http://127.0.0.1:${String(config.relay.port)}/_admin`,
      dsh: `http://127.0.0.1:${String(config.dsh.port)}/`,
    }
    desktopAdminReady = relayAdminInitialized(config.relay.data)
    say(`远程入口：http://127.0.0.1:${String(config.relay.port)}/`)
    emit('ready', '远程服务已启用')
  }

  // 控制命令在全部启动函数就绪后注册（避免启动早期命令触发未初始化闭包）；
  // 壳异常退出时由 Job Object 回收整棵后台进程树，早于注册的停止需求不悬空。
  desktop.listen((command) => {
    if (command.type === 'stop') void shutdown(0)
    else if (command.type === 'start-remote') startRemoteServices()
  })

  emit('ready')
  return finished
}

// 版本门禁在启动子进程或打开数据库前运行：
// 在旧 Node 上，这些失败会显示完全没有说明
// 真正原因的错误。
try {
  assertSupportedNodeVersion()
} catch (error) {
  reportFailure(error)
  process.exit(1)
}

const startupFailureLink = createDesktopLink(process.argv.slice(2))
try {
  process.exitCode = await run(process.argv.slice(2))
} catch (error) {
  reportFailure(error)
  if (startupFailureLink.enabled) {
    startupFailureLink.emit({
      type: 'exit',
      protocol: 1,
      message: error instanceof LauncherError ? error.message : String(error),
    })
  }
  process.exitCode = 1
}

