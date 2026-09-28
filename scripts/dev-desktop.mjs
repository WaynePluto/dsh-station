/**
 * 桌面开发入口只准备、缓存 Go 壳；开发后端由壳以 --dev-root 托管。
 * 显式 --attach / --relay-url 仅附着已运行的栈，不自动启动 pnpm dev。
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_RELAY_URL = 'http://127.0.0.1:31809/'
const DESKTOP_DIR = join(root, 'packages', 'desktop')
const DESKTOP_CACHE = join(root, 'node_modules', '.cache', 'dsh-station',
  process.platform === 'win32' ? 'desktop-dev.exe' : 'desktop-dev')
const say = message => process.stdout.write(`${message}\n`)

/** -- 之后保留壳参数；显式调试参数无论放在哪一侧都采用相同语义。 */
export function parseArguments(argv) {
  let relayUrl = DEFAULT_RELAY_URL
  let attach = false
  let forwarding = false
  const forward = []
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === '--') { forwarding = true; continue }
    if (value === '--attach') { attach = true; continue }
    if (value === '--dev-root' || value.startsWith('--dev-root=')) {
      throw new Error('dev:desktop 自行设置 --dev-root，不能覆盖仓库路径。')
    }
    if (value === '--relay-url' || value.startsWith('--relay-url=')) {
      relayUrl = value === '--relay-url' ? argv[++index] : value.slice('--relay-url='.length)
      if (relayUrl === undefined) throw new Error('--relay-url 需要一个地址。')
      attach = true
      continue
    }
    if (forwarding) forward.push(value)
    else throw new Error(`未知参数：${value}（壳参数请放在 -- 之后）`)
  }
  const url = new URL(relayUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === ''
    || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('relay 地址必须是无凭据、无路径的 http://127.0.0.1:<端口>/。')
  }
  return { attach, relayUrl: url.href, forward }
}

export function desktopArguments(argv, repository = root) {
  const { attach, relayUrl, forward } = parseArguments(argv)
  return [...attach ? ['--attach', '--relay-url', relayUrl] : ['--dev-root', repository], ...forward]
}

/** 与 prepare-desktop.mjs 保持相同资源检查，避免多启动一次 Node。 */
function prepareDesktopResource() {
  const source = join(root, 'packaging', 'win-launcher', 'rsrc_windows_amd64.syso')
  const target = join(DESKTOP_DIR, 'rsrc_windows_amd64.syso')
  if (!existsSync(source)) throw new Error(`[desktop] 缺少 Windows 图标与 DPI 资源：${source}`)
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target) && readFileSync(source).equals(readFileSync(target))) return
  copyFileSync(source, target)
}

function desktopSourceMtime() {
  let newest = 0
  for (const entry of readdirSync(DESKTOP_DIR)) {
    if (!entry.endsWith('.go') && !entry.endsWith('.syso') && entry !== 'go.mod' && entry !== 'go.sum') continue
    newest = Math.max(newest, statSync(join(DESKTOP_DIR, entry)).mtimeMs)
  }
  return newest
}

function ensureDesktopBinary() {
  if (existsSync(DESKTOP_CACHE) && statSync(DESKTOP_CACHE).mtimeMs > desktopSourceMtime()) return
  mkdirSync(dirname(DESKTOP_CACHE), { recursive: true })
  say('[desktop] 桌面壳源码有更新，重新构建……')
  const guiSubsystem = process.platform === 'win32' ? ['-ldflags', '-H=windowsgui'] : []
  const build = spawnSync('go', ['-C', DESKTOP_DIR, 'build',
    '-tags=production,wv2runtime.error', ...guiSubsystem, '-o', DESKTOP_CACHE, '.',
  ], { cwd: root, stdio: 'inherit', windowsHide: true })
  if (build.error !== undefined) throw build.error
  if (build.status !== 0) throw new Error(`[desktop] go build 失败（退出码 ${String(build.status)}）。`)
}

export async function runDesktop(argv) {
  const args = desktopArguments(argv)
  prepareDesktopResource()
  ensureDesktopBinary()
  say(args.includes('--attach')
    ? '[dsh-station] 显式 attach 调试：仅附着现有后端，不接管其生命周期。'
    : '[dsh-station] 启动受管开发桌面；后端由同一 launcher 启动，远程服务按需启用。')
  const shell = spawn(DESKTOP_CACHE, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  const stop = () => {
    if (shell.pid === undefined || shell.exitCode !== null || shell.signalCode !== null) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(shell.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else shell.kill('SIGTERM')
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    return await new Promise((accept, reject) => {
      shell.once('error', reject)
      shell.once('exit', code => accept(code ?? 1))
    })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runDesktop(process.argv.slice(2)) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
