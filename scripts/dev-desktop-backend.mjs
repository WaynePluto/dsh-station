/**
 * Go 托管的开发后端：先准备介质，再把生命周期交给发行版同一 launcher。
 * stdout 只发送 desktop-link 状态，stdin 只桥接控制命令，普通日志脱敏后写 stderr。
 */
import { spawn, spawnSync } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const DESKTOP_LINE_PREFIX = '@@DSH_STATION '
const MAX_COMMAND_CHARS = 4096

/** 慢准备开始前先公布精确 origin；此时没有 token，也不声明已就绪。 */
export function developmentBootstrapStatus(pid = process.pid) {
  return {
    type: 'status', protocol: 1, phase: 'config', pid,
    detail: '正在准备开发运行时与插件',
    urls: { local: 'http://127.0.0.1:3180/', admin: 'http://127.0.0.1:31809/_admin', dsh: 'http://127.0.0.1:3180/' },
    remoteEnabled: false, remoteState: 'idle',
  }
}

export function redactDevelopmentLog(text, secrets = []) {
  let result = String(text)
    .replace(/([?&]token=)[^&\s"'<>)]*/giu, '$1[redacted]')
    .replace(/("?(?:dshToken|DSH_STATION_\w*TOKEN|DSH_STATION_JWT_SECRET)"?\s*[:=]\s*"?)[^\s",}]*/giu, '$1[redacted]')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret !== '') result = result.replaceAll(secret, '[redacted]')
  }
  return result
}

/** 仅回收 wrapper 自己创建的进程树；准备进程可能还在 pnpm install/build。 */
export function terminateDevelopmentChild(child) {
  if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    if (result.error !== undefined || result.status !== 0) child.kill('SIGKILL')
  } else {
    try { process.kill(-child.pid, 'SIGKILL') }
    catch { child.kill('SIGKILL') }
  }
}

/** 参数注入仅供测试；命令行不开放替换 launcher 或准备入口。 */
export async function runDevelopmentBackend({
  argv = ['--desktop'], root = ROOT,
  input = process.stdin, output = process.stdout, errors = process.stderr,
  signals = process, spawnChild = spawn, terminate = terminateDevelopmentChild,
  prepareEntry = join(root, 'scripts', 'dev-desktop-prepare.mjs'),
  launcherEntry = join(root, 'packages', 'launcher', 'dist', 'index.js'),
} = {}) {
  const secrets = new Set([process.env.DSH_STATION_NOTIFY_TOKEN, process.env.DSH_STATION_DSH_TOKEN,
    process.env.DSH_STATION_JWT_SECRET].filter(Boolean))
  const emit = message => output.write(`${DESKTOP_LINE_PREFIX}${JSON.stringify(message)}\n`)
  const log = text => errors.write(`${redactDevelopmentLog(text, secrets)}\n`)
  if (argv.length !== 1 || argv[0] !== '--desktop') {
    emit({ type: 'exit', protocol: 1, message: '开发后端仅支持 --desktop，由桌面壳托管。' })
    return 1
  }
  emit(developmentBootstrapStatus())
  let active
  let launcher = false
  let stopping = false
  let pendingRemote = false
  let stopTimer
  let commandBuffer = ''
  let droppingCommand = false
  let launcherExitReported = false
  const send = type => {
    if (active?.stdin?.writable) active.stdin.write(`${JSON.stringify({ type })}\n`)
  }
  const stop = () => {
    if (stopping) return
    stopping = true
    if (launcher) {
      send('stop')
      stopTimer = setTimeout(() => terminate(active), 7500)
      stopTimer.unref()
    } else {
      emit({ ...developmentBootstrapStatus(), phase: 'stopping', detail: '已取消开发准备' })
      terminate(active)
    }
  }
  const command = line => {
    let parsed
    try { parsed = JSON.parse(line) } catch { return }
    if (parsed?.type === 'stop') stop()
    else if (parsed?.type === 'start-remote' && !stopping) {
      if (launcher) send('start-remote')
      else pendingRemote = true
    } else if ((parsed?.type === 'stop-remote' || parsed?.type === 'restart-remote') && !stopping && launcher) {
      // 开发桥只转发远程控制，启停与去重仍由同一 launcher 负责。
      send(parsed.type)
    }
  }
  const onData = chunk => {
    for (const part of String(chunk).split(/(?<=\n)/u)) {
      const ended = part.endsWith('\n')
      if (!droppingCommand) {
        commandBuffer += part
        if (commandBuffer.length > MAX_COMMAND_CHARS) { commandBuffer = ''; droppingCommand = true }
        else if (ended) { command(commandBuffer); commandBuffer = '' }
      }
      if (ended) droppingCommand = false
    }
  }
  const start = (entry, args, env, ipc) => {
    const child = spawnChild(process.execPath, [entry, ...args], {
      cwd: root, env, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe', ...ipc ? ['ipc'] : []],
    })
    active = child
    child.stdin.on('error', () => undefined)
    let prepared
    child.on('message', value => { prepared = value })
    createInterface({ input: child.stdout }).on('line', line => {
      if (!ipc && line.startsWith(DESKTOP_LINE_PREFIX)) {
        try {
          const message = JSON.parse(line.slice(DESKTOP_LINE_PREFIX.length))
          if (message.protocol === 1 && (message.type === 'status' || message.type === 'exit')) {
            if (typeof message.dshToken === 'string') secrets.add(message.dshToken)
            if (typeof message.detail === 'string') message.detail = redactDevelopmentLog(message.detail, secrets)
            if (typeof message.message === 'string') message.message = redactDevelopmentLog(message.message, secrets)
            if (typeof message.remoteError === 'string') message.remoteError = redactDevelopmentLog(message.remoteError, secrets)
            if (message.type === 'exit' || message.phase === 'failed') launcherExitReported = true
            emit(message)
            return
          }
        } catch { /* 非法状态行只作脱敏日志，不改变生命周期。 */ }
      }
      log(line)
    })
    createInterface({ input: child.stderr }).on('line', log)
    return new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (active === child) active = undefined
        accept({ code: code ?? (signal === null ? 0 : 1), prepared })
      })
    })
  }
  input.setEncoding('utf8')
  input.on('data', onData)
  input.once('end', stop)
  input.once('error', stop)
  signals.once('SIGINT', stop)
  signals.once('SIGTERM', stop)
  input.resume()
  try {
    const result = await start(prepareEntry, [], process.env, true)
    if (stopping) return 0
    if (result.code !== 0) throw new Error(`开发后端准备失败（退出码 ${String(result.code)}），请查看 stderr 日志。`)
    const prepared = result.prepared
    if (prepared === null || typeof prepared !== 'object'
      || !['configPath', 'runtime', 'dshHome'].every(key => typeof prepared[key] === 'string' && isAbsolute(prepared[key]))) {
      throw new Error('开发准备没有返回有效的运行时与配置路径。')
    }
    launcher = true
    const launched = start(launcherEntry, ['--desktop', '--config', prepared.configPath], {
      ...process.env, DSH_HOME: prepared.dshHome, DSH_STATION_DEV_RUNTIME: prepared.runtime,
    }, false)
    if (pendingRemote) send('start-remote')
    const exit = await launched
    if (exit.code !== 0 && !stopping && !launcherExitReported) {
      emit({ type: 'exit', protocol: 1, message: `launcher 已退出（退出码 ${String(exit.code)}），请查看 stderr 日志。` })
    }
    return stopping ? 0 : exit.code
  } catch (error) {
    terminate(active)
    if (stopping) return 0
    const message = redactDevelopmentLog(error instanceof Error ? error.message : String(error), secrets)
    log(message)
    emit({ type: 'exit', protocol: 1, message })
    return 1
  } finally {
    clearTimeout(stopTimer)
    input.removeListener('data', onData)
    input.removeListener('end', stop)
    input.removeListener('error', stop)
    input.pause()
    signals.removeListener('SIGINT', stop)
    signals.removeListener('SIGTERM', stop)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDevelopmentBackend({ argv: process.argv.slice(2) })
}
