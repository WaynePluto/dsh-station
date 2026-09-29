import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktopArguments } from './dev-desktop.mjs'
import { developmentBootstrapStatus, DESKTOP_LINE_PREFIX, redactDevelopmentLog, runDevelopmentBackend } from './dev-desktop-backend.mjs'
import { developmentLauncherConfig, ensureBackendBuild, prepareDesktopBackend } from './dev-desktop-prepare.mjs'
import { ensurePluginBuild, packageBuildStamp } from './dev-plugin-build.mjs'
import { developmentProfileOptions } from './dev-profile.js'
import { DSH_STATION_PROFILE_BUNDLES } from '../packages/launcher/src/profile.js'
import { DESKTOP_LINE_PREFIX as LAUNCHER_LINE_PREFIX } from '../packages/launcher/src/desktop-link.js'
import { resolvePluginMediaDirectory } from '../packages/launcher/src/plugin-lifecycle.js'

const temporary: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'station-dev-desktop-'))
  temporary.push(path)
  return path
}
function write(root: string, path: string, content = '') {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}
function capture(stream: PassThrough) {
  let text = ''
  stream.on('data', chunk => { text += String(chunk) })
  return () => text
}
function bridge() {
  const input = new PassThrough()
  const output = new PassThrough()
  const errors = new PassThrough()
  const stdout = capture(output)
  const stderr = capture(errors)
  return { input, output, errors, stdout, stderr, signals: new EventEmitter() }
}
function wire(text: string) {
  return text.trim().split('\n').filter(Boolean).map(line => {
    expect(line.startsWith(DESKTOP_LINE_PREFIX)).toBe(true)
    return JSON.parse(line.slice(DESKTOP_LINE_PREFIX.length))
  })
}

describe('desktop shell invocation', () => {
  it('defaults to an independently managed development shell, including selfcheck', () => {
    expect(desktopArguments([], 'repo')).toEqual(['--dev-root', 'repo'])
    expect(desktopArguments(['--', '--selfcheck'], 'repo')).toEqual(['--dev-root', 'repo', '--selfcheck'])
  })
  it('only attaches explicitly, without taking ownership of pnpm dev', () => {
    expect(desktopArguments(['--attach'])).toEqual(['--attach', '--relay-url', 'http://127.0.0.1:31809/'])
    expect(desktopArguments(['--', '--relay-url=http://127.0.0.1:9999/'])).toEqual(['--attach', '--relay-url', 'http://127.0.0.1:9999/'])
  })
  it.each(['https://127.0.0.1:31809/', 'http://user:secret@127.0.0.1:31809/', 'http://127.0.0.1:31809/path'])('rejects unsafe attach URL %s', value => {
    expect(() => desktopArguments(['--relay-url', value])).toThrow()
  })
  it('does not permit forwarding a conflicting dev-root', () => {
    expect(() => desktopArguments(['--', '--dev-root', 'other'])).toThrow()
  })
})

describe('development preparation', () => {
  it('prepares runtime before loading local-config and leaves profile state to launcher', async () => {
    const root = directory()
    const runtime = join(root, 'isolated')
    const descriptor = {
      runtime,
      dshBin: write(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      installAnchor: write(runtime, 'node_modules/@deepseek-ai/dsh/package.json', '{}'),
      pnpmCli: write(runtime, 'node_modules/pnpm/bin/pnpm.cjs'),
    }
    const local = {
      DSH_BIN: descriptor.dshBin, DSH_INSTALL_ANCHOR: descriptor.installAnchor, PNPM_CLI: descriptor.pnpmCli,
      DSH_STATION_HOME: join(root, '.dsh-station-dev'), DSH_HOME_DEV: join(root, '.dsh-dev'),
      DSH_PORT: 3180, RELAY_PORT: 31809, DSH_PROFILE: 'dsh-station-web',
      RELAY_DATABASE: join(root, '.dsh-station-dev', 'relay.db'),
    }
    const state = write(local.DSH_HOME_DEV, 'profiles/dsh-station-web/package.json', '{"userChoice":"removed"}')
    const calls: string[] = []
    const prepared = await prepareDesktopBackend({ root,
      prepareRuntime: async () => { calls.push('runtime'); write(root, '.dev/runtime.json', JSON.stringify(descriptor)) },
      loadLocalConfig: async () => { calls.push('config'); expect(calls[0]).toBe('runtime'); return local },
      buildPlugins: async () => { calls.push('plugins') },
      buildBackend: async () => { calls.push('backend') },
    })
    expect(calls).toEqual(['runtime', 'config', 'plugins', 'backend'])
    expect(prepared).toMatchObject({ runtime, dshHome: local.DSH_HOME_DEV })
    expect(JSON.parse(readFileSync(prepared.configPath, 'utf8'))).toEqual(developmentLauncherConfig(local))
    expect(readFileSync(state, 'utf8')).toBe('{"userChoice":"removed"}')
    expect(developmentProfileOptions(local.DSH_HOME_DEV)).toEqual({
      home: local.DSH_HOME_DEV, profile: local.DSH_PROFILE, bundles: DSH_STATION_PROFILE_BUNDLES,
    })
  })

  it('stops immediately if runtime preparation fails', async () => {
    const loadLocalConfig = vi.fn()
    await expect(prepareDesktopBackend({ root: directory(), prepareRuntime: () => { throw new Error('runtime failed') }, loadLocalConfig }))
      .rejects.toThrow('runtime failed')
    expect(loadLocalConfig).not.toHaveBeenCalled()
  })

  it('matches the actual development homes, ports and profile contract', async () => {
    const local = await import('./local-config.mjs')
    const config = developmentLauncherConfig(local)
    expect(config.home).toBe(join(homedir(), '.dsh-station-dev'))
    expect(local.DSH_HOME_DEV).toBe(join(homedir(), '.dsh-dev'))
    expect(config.dsh).toEqual({ port: 3180, profile: 'dsh-station-web' })
    expect(developmentBootstrapStatus().urls.admin).toContain(`:${config.relay.port}/`)
    expect(developmentBootstrapStatus().urls.dsh).toContain(`:${config.dsh.port}/`)
  })

  it('the unchanged launcher resolver finds .dev/plugins from the built entry', () => {
    const root = directory()
    write(root, '.dev/plugins/catalog.json', '{}')
    expect(resolvePluginMediaDirectory({ launcherDirectory: join(root, 'packages/launcher/dist') }))
      .toBe(join(root, '.dev/plugins'))
  })
})

function buildFixture() {
  const root = directory()
  for (const file of ['package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'scripts/dev-desktop-prepare.mjs',
    'scripts/dev-plugin-build.mjs', 'scripts/plugin-distributions.mjs']) write(root, file, '{}')
  for (const name of ['launcher', 'relay', 'connector', 'protocol', 'plugin-ui']) {
    write(root, `packages/${name}/package.json`, '{}')
    write(root, `packages/${name}/src/index.ts`, name)
  }
  const component = { name: '@dsh-station/dsh-plugin-example', rowId: 'example' }
  const manifest = JSON.stringify({ name: component.name, main: 'dist/index.js', exports: { './client': './dist/client.js' }, dsh: { client: {} } })
  write(root, 'packages/plugins/example/package.json', manifest)
  write(root, 'packages/plugins/example/src/index.ts', 'host')
  write(root, 'plugin-catalog.json', JSON.stringify({ distributions: [{ name: component.name, components: [component] }] }))
  const plugins = () => {
    for (const path of ['packages/plugins/example', '.dev/plugins/example']) {
      write(root, `${path}/package.json`, manifest)
      write(root, `${path}/dist/index.js`, 'host')
      write(root, `${path}/dist/client.js`, 'client')
    }
    write(root, '.dev/plugins/catalog.json', JSON.stringify({ schemaVersion: 1, plugins: [
      { name: component.name, directory: 'example', components: [component] },
    ] }))
  }
  const backend = () => {
    for (const file of ['launcher/dist/index.js', 'relay/dist/cli.js', 'relay/dist/index.js', 'connector/dist/cli.js', 'connector/dist/index.js']) {
      write(root, `packages/${file}`)
    }
  }
  return { root, plugins, backend }
}

describe('shared build caches', () => {
  it('invalidates backend cache on relay edits and missing connector dist; never installs packages', async () => {
    const { root, backend } = buildFixture()
    const run = vi.fn(async () => backend())
    const options = { root, pnpmCli: '/installed/pnpm.cjs', run, log: vi.fn() }
    expect(await ensureBackendBuild(options)).toBe(true)
    expect(await ensureBackendBuild(options)).toBe(false)
    write(root, 'packages/relay/src/index.ts', 'edited')
    expect(await ensureBackendBuild(options)).toBe(true)
    rmSync(join(root, 'packages/connector/dist/cli.js'))
    expect(await ensureBackendBuild(options)).toBe(true)
    expect(run).toHaveBeenCalledTimes(3)
    expect(run.mock.calls[0]?.[0]).toEqual(['/installed/pnpm.cjs', '--filter', '@dsh-station/launcher', '--filter', '@dsh-station/relay', '--filter', '@dsh-station/connector', 'build'])
  })

  it('reuses plugin cache and rebuilds missing browser artifacts, locale edits and catalog changes', async () => {
    const { root, plugins } = buildFixture()
    const runRootScript = vi.fn(async () => plugins())
    const options = { root, runRootScript, log: vi.fn() }
    expect(await ensurePluginBuild(options)).toBe(true)
    expect(await ensurePluginBuild(options)).toBe(false)
    rmSync(join(root, '.dev/plugins/example/dist/client.js'))
    expect(await ensurePluginBuild(options)).toBe(true)
    write(root, 'packages/plugins/example/locale/zh.json', '{}')
    expect(await ensurePluginBuild(options)).toBe(true)
    const path = join(root, 'plugin-catalog.json')
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n`)
    expect(await ensurePluginBuild(options)).toBe(true)
    expect(runRootScript).toHaveBeenCalledTimes(8)
  })

  it('does not stamp failed builds or hash dist outputs', async () => {
    const { root } = buildFixture()
    const before = packageBuildStamp(join(root, 'packages/plugins/example'))
    write(root, 'packages/plugins/example/dist/index.js', 'output')
    expect(packageBuildStamp(join(root, 'packages/plugins/example'))).toBe(before)
    await expect(ensurePluginBuild({ root, runRootScript: async () => { throw new Error('build failed') } })).rejects.toThrow('build failed')
    expect(existsSync(join(root, 'node_modules/.cache/dsh-station/dev-plugin-build.json'))).toBe(false)
  })
})

describe('development backend wire and cleanup', () => {
  it('uses the existing desktop-link wire prefix and protocol', () => {
    expect(DESKTOP_LINE_PREFIX).toBe(LAUNCHER_LINE_PREFIX)
    expect(developmentBootstrapStatus()).toMatchObject({ type: 'status', protocol: 1, phase: 'config', remoteEnabled: false })
    expect(developmentBootstrapStatus()).not.toHaveProperty('dshToken')
  })

  it('emits credential-free config synchronously before preparation, reports failure and never starts launcher', async () => {
    const root = directory()
    const io = bridge()
    const prepareEntry = write(root, 'fail.mjs', 'console.error("failed ?token=hidden"); process.exit(7)')
    const done = runDevelopmentBackend({ ...io, root, prepareEntry, launcherEntry: join(root, 'must-not-start.mjs') })
    expect(wire(io.stdout())).toEqual([developmentBootstrapStatus()])
    expect(await done).toBe(1)
    expect(wire(io.stdout()).at(-1)).toMatchObject({ type: 'exit', protocol: 1 })
    expect(io.stderr()).not.toContain('hidden')
  })

  it('hands the same launcher config/env and queued command to the child while keeping tokens out of logs', async () => {
    const root = directory()
    const io = bridge()
    const prepared = { configPath: join(root, 'config.json'), runtime: join(root, 'runtime'), dshHome: join(root, '.dsh-dev') }
    const prepareEntry = write(root, 'prepare.mjs', `setTimeout(() => process.send(${JSON.stringify(prepared)}, () => process.disconnect()), 80)`)
    const launcherEntry = write(root, 'launcher.mjs', `
      import { createInterface } from 'node:readline'
      console.error(JSON.stringify({ argv: process.argv.slice(2), home: process.env.DSH_HOME, runtime: process.env.DSH_STATION_DEV_RUNTIME }))
      console.log('dsh web: http://127.0.0.1:3180/?token=private-login')
      console.log('@@DSH_STATION ' + JSON.stringify({type:'status', protocol:1, phase:'ready', pid:process.pid, dshToken:'private-login'}))
      createInterface({input:process.stdin}).on('line', line => {
        console.error('command:' + JSON.parse(line).type)
        if (JSON.parse(line).type === 'stop') process.exit(0)
      })
    `)
    const done = runDevelopmentBackend({ ...io, root, prepareEntry, launcherEntry })
    io.input.write('{"type":"start-remote"}\n')
    try {
      await vi.waitFor(() => expect(io.stderr()).toContain('command:start-remote'))
      io.input.write('{"type":"stop"}\n')
      expect(await done).toBe(0)
      const settings = JSON.parse(io.stderr().split('\n').find(line => line.startsWith('{')) ?? '')
      expect(settings).toEqual({ argv: ['--desktop', '--config', prepared.configPath], home: prepared.dshHome, runtime: prepared.runtime })
      expect(wire(io.stdout()).find(message => message.phase === 'ready').dshToken).toBe('private-login')
      expect(io.stderr()).not.toContain('private-login')
    } finally { io.input.write('{"type":"stop"}\n'); await done }
  })

  it.each(['stop-remote', 'restart-remote'])('forwards %s through the development bridge without stopping launcher', async (type) => {
    const root = directory()
    const io = bridge()
    const prepared = { configPath: join(root, 'config.json'), runtime: join(root, 'runtime'), dshHome: join(root, '.dsh-dev') }
    const prepareEntry = write(root, 'prepare.mjs', `process.send(${JSON.stringify(prepared)}, () => process.disconnect())`)
    const launcherEntry = write(root, 'launcher.mjs', `
      import { createInterface } from 'node:readline'
      console.error('launcher-ready')
      createInterface({input:process.stdin}).on('line', line => {
        const {type} = JSON.parse(line)
        console.error('command:' + type)
        if (type === 'stop') process.exit(0)
      })
    `)
    const done = runDevelopmentBackend({ ...io, root, prepareEntry, launcherEntry })
    try {
      await vi.waitFor(() => expect(io.stderr()).toContain('launcher-ready'))
      io.input.write('{bad json}\n{"type":"unknown"}\n' + 'x'.repeat(5000) + '\n')
      // 分块、CRLF 和连续命令都走生产 parser，不直接调用 launcher 控制器。
      io.input.write('{"type":"' + type.slice(0, 4))
      io.input.write(type.slice(4) + '"}\r\n{"type":"start-remote"}\n')
      await vi.waitFor(() => expect(io.stderr()).toContain('command:start-remote'))
      expect(io.stderr().split('\n').filter(line => line.startsWith('command:')))
        .toEqual([`command:${type}`, 'command:start-remote'])
      io.input.write('{"type":"stop"}\n' + JSON.stringify({ type }) + '\n')
      expect(await done).toBe(0)
      expect(io.stderr().split('\n').filter(line => line.startsWith('command:')))
        .toEqual([`command:${type}`, 'command:start-remote', 'command:stop'])
    } finally { io.input.write('{"type":"stop"}\n'); await done }
  })

  it('cancels a slow preparation and its grandchild on stdin EOF without leaving a process', async () => {
    const root = directory()
    const io = bridge()
    const prepareEntry = write(root, 'prepare.mjs', `
      import { spawn } from 'node:child_process'
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore', windowsHide:true})
      console.error('grandchild:' + child.pid)
      setInterval(() => {}, 1000)
    `)
    const done = runDevelopmentBackend({ ...io, root, prepareEntry })
    try {
      await vi.waitFor(() => expect(io.stderr()).toContain('grandchild:'))
      const pid = Number(/grandchild:(\d+)/u.exec(io.stderr())?.[1])
      io.input.end()
      expect(await done).toBe(0)
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 })
      expect(wire(io.stdout()).at(-1)).toMatchObject({ phase: 'stopping' })
    } finally { io.input.end(); await done }
  })

  it('ignores oversized stdin commands and handles spawn failure as a structured exit', async () => {
    const io = bridge()
    const done = runDevelopmentBackend({ ...io, root: join(directory(), 'does-not-exist') })
    io.input.write(`${'x'.repeat(5000)}\n`)
    expect(await done).toBe(1)
    expect(wire(io.stdout()).at(-1)).toMatchObject({ type: 'exit' })
  })

  it.runIf(process.env.DSH_STATION_INTEGRATION === '1')('controls real remote children through the development bridge', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const home = directory()
    const io = bridge()
    const runtimeInfo = JSON.parse(readFileSync(join(root, '.dev/runtime.json'), 'utf8'))
    const listeners = [createServer(), createServer()]
    let ports: number[]
    try {
      // 同时保留两个随机端口，避免两次分配复用同一个端口。
      ports = await Promise.all(listeners.map(async listener => {
        await new Promise<void>((accept, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', accept) })
        const address = listener.address()
        if (address === null || typeof address === 'string') throw new Error('missing test port')
        return address.port
      }))
    } finally {
      await Promise.all(listeners.map(listener => new Promise<void>(accept => listener.close(() => accept()))))
    }
    const [dshPort, relayPort] = ports
    const prepared = {
      configPath: write(home, 'config.json', JSON.stringify({
        home: join(home, 'station'), dsh: { port: dshPort }, relay: { host: '127.0.0.1', port: relayPort },
      })),
      runtime: runtimeInfo.runtime, dshHome: join(home, 'dsh'),
    }
    // 只替换准备结果以隔离 home/端口；命令桥、状态桥和 launcher 均执行生产代码。
    const prepareEntry = write(home, 'prepare.mjs', `process.send(${JSON.stringify(prepared)}, () => process.disconnect())`)
    const done = runDevelopmentBackend({ ...io, root, prepareEntry })
    const states = () => wire(io.stdout()).filter(message => message.type === 'status')
    const latest = () => states().at(-1)
    try {
      await vi.waitFor(() => expect(latest()?.phase).toBe('ready'), { timeout: 60000 })
      expect(latest()?.remoteState).toBe('idle')
      const token = latest()?.dshToken
      expect(typeof token === 'string' && token !== '').toBe(true)
      /* eslint-disable no-await-in-loop -- 按生命周期顺序发送命令，并逐轮验证端口与认证。 */
      for (const type of ['start-remote', 'stop-remote', 'start-remote', 'restart-remote', 'stop-remote']) {
        const offset = states().length
        io.input.write(JSON.stringify({ type }) + '\n')
        const expectedState = type === 'stop-remote' ? 'idle' : 'ready'
        await vi.waitFor(() => {
          expect(states().length > offset).toBe(true)
          expect(latest()?.remoteState).toBe(expectedState)
          expect(latest()?.phase).toBe('ready')
        }, { timeout: 45000 })
        const remoteStates = states().slice(offset).map(message => message.remoteState)
        expect(remoteStates).toEqual(type === 'stop-remote' ? ['stopping', 'idle']
          : type === 'restart-remote' ? ['stopping', 'starting', 'ready'] : ['starting', 'ready'])
        expect(latest()?.dshToken === token).toBe(true)
        const remoteEnabled = type !== 'stop-remote'
        expect(latest()?.remoteEnabled).toBe(remoteEnabled)
        const relayListening = await fetch(`http://127.0.0.1:${relayPort}/`, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
          .then(async response => { await response.body?.cancel(); return true }, () => false)
        expect(relayListening).toBe(remoteEnabled)
        const response = await fetch(`http://127.0.0.1:${dshPort}/?token=${token}`, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
          .catch(() => { throw new Error('local dsh authentication request failed') })
        await response.body?.cancel()
        expect(response.status).toBe(303)
        const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
        const page = await fetch(`http://127.0.0.1:${dshPort}/`, { headers: { Cookie: cookies }, redirect: 'manual', signal: AbortSignal.timeout(3000) })
        await page.body?.cancel()
        expect(page.status).toBe(200)
      }
      /* eslint-enable no-await-in-loop */
    } finally { io.input.write('{"type":"stop"}\n'); await done }
    expect(await done).toBe(0)
  }, 120000)

  it('redacts URL tokens and inherited notification secrets', () => {
    expect(redactDevelopmentLog('http://127.0.0.1/?token=hello&x=1 dshToken="world" notify-secret', ['notify-secret']))
      .toBe('http://127.0.0.1/?token=[redacted]&x=1 dshToken="[redacted]" [redacted]')
  })
})
