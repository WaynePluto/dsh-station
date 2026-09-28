import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { LauncherError } from './errors.js'

/** dsh 绝不暴露到 IPv4 loopback 之外；relay 是唯一入口（铁律 4）。 */
export const DSH_BIND_HOST = '127.0.0.1'

/** launcher 放弃前，dsh 最长可以多久在端口上响应。 */
export const DSH_READY_TIMEOUT_MS = 60_000

/**
 * 将 dsh 的浏览器登录 token 传给 connector 的环境变量。
 *
 * 使用环境变量而不是 argv：token 用于对 dsh 认证浏览器，
 * 而机器上的每个进程都能读取 argv。
 */
export const DSH_TOKEN_ENV_NAME = 'DSH_STATION_DSH_TOKEN'

/**
 * dsh 端口响应后继续等待 token 行的最长时间。
 *
 * dsh 会在插件树仍在稳定时绑定端口，并在之后才打印 URL
 * 行，因此就绪后还要继续等待一小段时间。
 */
export const DSH_TOKEN_TIMEOUT_MS = 30_000

/**
 * 从 dsh 输出的一行中提取浏览器登录 token。
 *
 * dsh 会打印 `dsh web: http://127.0.0.1:3080/?token=<token>`（可选地
 * 在插件树稳定后跟随 ` (LAN: ...)` 部分）。dsh 0.1.2 会为每个进程生成
 * token，并拒绝没有该 token 换取的 cookie 的所有 `/api` 请求，
 * 因此这一行是获取 token 的唯一方式。
 * @param line - dsh 子进程写出的一行。
 * @returns token；该行不携带 token 时为 undefined。
 */
export function dshTokenFromLine(line: string): string | undefined {
  const match = /dsh web:\s*(\S+)/u.exec(line)
  const candidate = match?.[1]
  if (candidate === undefined) return undefined
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return undefined
  }
  const token = url.searchParams.get('token')
  return token === null || token === '' ? undefined : token
}

/**
 * dsh 0.1.7 起 Bundle 解析、清单或 patch 装载失败不再启动即败，而是把
 * `dsh: skipping profile bundle "<包名>": <原因>` 写到 stderr 后跳过该 Bundle
 * （上游 `packages/boot/app-boot/src/profile.ts`）。对依赖全部插件在位的
 * dsh-station 来说这是静默降级，launcher 检测到该行时必须响亮提示。
 * @param line - dsh 子进程写出的一行。
 * @returns 跳过诊断的说明文本；该行不是跳过诊断时为 undefined。
 */
export function skippedBundleFromLine(line: string): string | undefined {
  const match = /: skipping profile bundle (\S+): (.+)$/u.exec(line)
  return match === null ? undefined : `${match[1]} ${match[2] ?? ''}`
}

/** 加载此模块的目录；所有同级查找的锚点。 */
export function launcherDirectory(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/** 仅受管开发 wrapper 设置；发行版/CLI 未设置时沿用原解析行为。 */
export const DEV_RUNTIME_ENV_NAME = 'DSH_STATION_DEV_RUNTIME'

function isWithin(directory: string, path: string): boolean {
  const suffix = relative(directory, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

/** 三个入口共享同一个显式锚点；缺失时禁止向源码 node_modules 或全局包回退。 */
function resolveRuntimeModule(specifier: string, suffix?: readonly string[]): string {
  const configured = process.env[DEV_RUNTIME_ENV_NAME]
  const modulePath = (anchor: string | URL): string => {
    const found = createRequire(anchor).resolve(specifier)
    return suffix === undefined ? found : join(dirname(found), ...suffix)
  }
  if (configured === undefined) return modulePath(import.meta.url)
  try {
    if (!isAbsolute(configured)) throw new Error('开发运行时必须使用绝对路径')
    const runtime = realpathSync(configured)
    const sourceRoot = resolve(launcherDirectory(), '..', '..', '..')
    if (isWithin(sourceRoot, runtime)) throw new Error('开发运行时必须位于源码工作区之外')
    const anchor = join(runtime, 'package.json')
    const manifest = JSON.parse(readFileSync(anchor, 'utf8')) as { name?: unknown }
    if (manifest.name !== 'dsh-station-development-runtime') throw new Error('不是受控的隔离开发运行时')
    const found = realpathSync(modulePath(anchor))
    if (!isWithin(join(runtime, 'node_modules'), found)) throw new Error('开发模块解析越过了隔离运行时边界')
    return found
  } catch (error) {
    throw new LauncherError(`无法从 ${DEV_RUNTIME_ENV_NAME} 解析 ${specifier}。`, {
      hint: '请通过 pnpm dev:desktop 重新准备隔离开发运行时；不会回退到源码工作区的同名包。',
      cause: error,
    })
  }
}

/**
 * 内嵌 dsh 入口点的绝对路径。
 *
 * 通过 Node 解析而不是手动拼接：绿色包和
 * 开发 checkout 将 `node_modules` 放在不同位置，字面路径
 * 会在布局变化时静默指向过期副本。
 * @returns `@deepseek-ai/dsh/lib/bin.js` 的路径。
 * @throws LauncherError 包中缺少内嵌 dsh 时抛出。
 */
export function resolveDshBin(): string {
  try {
    return resolveRuntimeModule('@deepseek-ai/dsh/lib/bin.js')
  } catch (error) {
    if (error instanceof LauncherError) throw error
    throw new LauncherError(
      '找不到随包携带的 dsh（@deepseek-ai/dsh）。',
      { hint: '这个绿色包的 node_modules 不完整，请重新解压一份完整的包。', cause: error })
  }
}

/** dsh 的安装 manifest；官方插件管理器用它区分安装自带包与 profile 依赖。 */
export function resolveDshInstallAnchor(): string {
  try {
    return resolveRuntimeModule('@deepseek-ai/dsh/package.json')
  } catch (error) {
    if (error instanceof LauncherError) throw error
    throw new LauncherError(
      '找不到随包携带的 dsh package.json。',
      { hint: '这个绿色包的 node_modules 不完整，请重新解压一份完整的包。', cause: error },
    )
  }
}

/** 随 launcher 分发的 pnpm CLI，用于无全局 pnpm 的绿色包插件管理。 */
export function resolvePnpmCli(): string {
  try {
    return resolveRuntimeModule('pnpm', ['bin', 'pnpm.cjs'])
  } catch (error) {
    if (error instanceof LauncherError) throw error
    throw new LauncherError(
      '找不到随包携带的 pnpm。',
      { hint: '这个绿色包无法安装或升级插件，请重新解压一份完整的包。', cause: error },
    )
  }
}

/** pnpm 所在的随包 node_modules，也是插件运行时依赖的离线来源。 */
export function resolveBundledModulesDirectory(pnpmCli = resolvePnpmCli()): string {
  return dirname(dirname(dirname(pnpmCli)))
}

/** 读取随包 pnpm 的版本，供旧 profile 判断是否需要重建 node_modules。 */
export function resolvePnpmVersion(pnpmCli = resolvePnpmCli()): string {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(dirname(pnpmCli)), 'package.json'), 'utf8')) as { version?: unknown }
    if (typeof manifest.version !== 'string' || manifest.version === '') throw new TypeError('pnpm version 无效')
    return manifest.version
  } catch (error) {
    throw new LauncherError(
      '无法读取随包 pnpm 的版本。',
      { hint: '这个绿色包的 pnpm 文件不完整，请重新解压一份完整的包。', cause: error },
    )
  }
}

const PNPM_WRAPPER_SOURCE = `import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, parse } from 'node:path'
import { spawnSync } from 'node:child_process'

function packageName(directory) {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    return typeof manifest.name === 'string' ? manifest.name : undefined
  } catch {
    return undefined
  }
}

function installDirectory(value) {
  if (!isAbsolute(value) || !existsSync(value) || !statSync(value).isDirectory()) return value
  if (parse(value).root.toLowerCase() === parse(process.cwd()).root.toLowerCase()) return value
  const name = packageName(value)
  const media = join(process.cwd(), '.dsh-station-plugin-media')
  if (name === undefined || !existsSync(media)) return value
  for (const entry of readdirSync(media, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(media, entry.name)
    if (packageName(candidate) === name) return candidate
  }
  return value
}

const [pnpmCli, ...original] = process.argv.slice(2)
if (pnpmCli === undefined) process.exit(1)
const args = original[0] === 'add'
  ? original.map((value, index) => index > 0 ? installDirectory(value) : value)
  : original
const result = spawnSync(process.execPath, [pnpmCli, ...args], { env: process.env, stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
`

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** 创建供 dsh 原生插件管理器调用的 pnpm 代理，将绝对本地目录改成可跨盘物化的 file: spec。 */
export function preparePnpmShim(directory: string, pnpmCli = resolvePnpmCli()): string {
  mkdirSync(directory, { recursive: true })
  const wrapper = join(directory, 'pnpm-wrapper.mjs')
  writeFileSync(wrapper, PNPM_WRAPPER_SOURCE, 'utf8')
  if (process.platform === 'win32') {
    const command = join(directory, 'pnpm.cmd')
    writeFileSync(command, `@echo off\r\n"${process.execPath}" "${wrapper}" "${pnpmCli}" %*\r\n`, 'utf8')
  } else {
    const command = join(directory, 'pnpm')
    writeFileSync(command, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(wrapper)} ${shellQuote(pnpmCli)} "$@"\n`, 'utf8')
    chmodSync(command, 0o755)
  }
  return directory
}

/** 将 pnpm 代理和随包 shim 加入 dsh 子进程 PATH，供原生插件管理页调用。 */
export function withBundledPnpmPath(
  environment: NodeJS.ProcessEnv,
  pnpmCli = resolvePnpmCli(),
  shimDirectory?: string,
): NodeJS.ProcessEnv {
  const modulesDirectory = resolveBundledModulesDirectory(pnpmCli)
  const binDirectory = join(modulesDirectory, '.bin')
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  const inherited = environment[pathKey] ?? ''
  return {
    ...environment,
    [pathKey]: [shimDirectory, binDirectory, inherited].filter(Boolean).join(delimiter),
  }
}

/**
 * 构建 dsh 子进程的 argv。
 * Mode A（铁律 7）要求 dsh 只绑定 loopback，并信任浏览器可能使用的 authority，因为 relay 原样转发 Host。
 * dsh-station 插件作为 `--patch` overlay 传入，位于 `--profile` 之后、web app 参数之前。
 * 不预加载 proxy：唯一来源是 `@dsh-station/dsh-plugin-proxy` 的 Settings → Proxy 页面；否则关闭设置后仍走环境 proxy，页面却显示直连（docs/dsh/models.md）。
 * @param options - dsh 入口点、profile、patch overlay、端口、trusted hosts 和额外参数。
 * @returns 要传给 `node` 的参数。
 */
export function dshArguments(options: {
  readonly dshBin: string
  readonly profile: string
  readonly port: number
  readonly trustedHosts: readonly string[]
  /** 来自 `resolveDshPluginOverlays` 的插件 overlay；应用于 profile 层之后。 */
  readonly patchFiles?: readonly string[] | undefined
  readonly extraArgs?: readonly string[] | undefined
}): string[] {
  return [
    options.dshBin,
    '--profile', options.profile,
    ...(options.patchFiles ?? []).flatMap(file => ['--patch', file]),
    '--no-open',
    '--host', DSH_BIND_HOST,
    '--port', String(options.port),
    '--trusted-host', ...options.trustedHosts,
    ...options.extraArgs ?? [],
  ]
}

/** 对本地端口的一次 TCP 连接尝试。 */
async function probe(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = connect({ host: DSH_BIND_HOST, port })
    const finish = (answered: boolean): void => {
      socket.destroy()
      resolvePromise(answered)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * 等待 dsh 在其端口上接受连接。
 *
 * TCP accept 是就绪信号：dsh 只有在插件
 * 树加载完成后才绑定端口，而 HTTP probe 还会依赖
 * 不属于 launcher 职责的路由。
 * @param options - 端口、总超时、轮询间隔以及一个
 * 提前中止等待的谓词（子进程已退出时使用）。
 * @returns dsh 已响应时为 true，超时或提前中止时为 false。
 */
export async function waitForDsh(options: {
  readonly port: number
  readonly timeoutMs?: number | undefined
  readonly intervalMs?: number | undefined
  readonly giveUp?: (() => boolean) | undefined
}): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? DSH_READY_TIMEOUT_MS)
  const interval = options.intervalMs ?? 250
  while (Date.now() < deadline) {
    if (options.giveUp?.() === true) return false
    // eslint-disable-next-line no-await-in-loop -- 轮询按定义是顺序执行的
    if (await probe(options.port, 1_000)) return true
    // eslint-disable-next-line no-await-in-loop -- 同上
    await delay(interval)
  }
  return false
}
