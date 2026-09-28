import process from 'node:process'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { THEME_FILE_ENV_NAME, THEME_FILE_NAME } from '@dsh-station/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopCommandHandler, DesktopMessage } from '../src/desktop-link.js'
import type { TrustWatcherOptions } from '../src/dsh-restart.js'
import type { ChildExit, ChildSpec, SupervisorOptions } from '../src/supervisor.js'

const harness = vi.hoisted(() => ({
  messages: [] as DesktopMessage[],
  handler: undefined as DesktopCommandHandler | undefined,
  unexpectedExit: undefined as SupervisorOptions['onUnexpectedExit'] | undefined,
  trustChange: undefined as TrustWatcherOptions['onChange'] | undefined,
  signal: undefined as AbortSignal | undefined,
  running: new Set<string>(),
  failStart: undefined as string | undefined,
  start: vi.fn<(spec: ChildSpec) => void>(),
  stop: vi.fn<(name: string) => Promise<boolean>>(),
  stopAll: vi.fn<() => Promise<void>>(),
  wait: vi.fn<(options: { port: number; signal: AbortSignal }) => Promise<void>>(),
  waitDsh: vi.fn<() => Promise<boolean>>(),
  release: vi.fn(),
  close: vi.fn(),
  stopWatcher: vi.fn(),
  restartStatus: vi.fn(),
}))

vi.mock('../src/desktop-link.js', () => ({
  createDesktopLink: (argv: string[]) => ({
    enabled: argv.includes('--desktop'),
    emit: (message: DesktopMessage) => { harness.messages.push(message) },
    listen: (handler: DesktopCommandHandler) => { harness.handler = handler },
    close: harness.close,
  }),
}))
vi.mock('../src/config.js', () => ({ loadLauncherConfig: () => ({ config: {
  home: 'test-home',
  dsh: { profile: 'test-profile', port: 3080, extraArgs: [] },
  relay: { host: '0.0.0.0', port: 30809, slug: 'test-machine', data: 'test-data' },
} }) }))
vi.mock('../src/instance-lock.js', () => ({ acquireInstanceLock: () => ({ release: harness.release }) }))
vi.mock('../src/membership.js', () => ({
  membershipFilePath: () => 'membership.json', readMembership: () => undefined, isSelfHub: () => false,
}))
vi.mock('../src/profile.js', () => ({
  resolveDshHome: () => 'test-dsh-home', ensureProfile: () => ({ bootstrap: 'existing' }),
  profileDirectory: () => 'test-profile', DSH_STATION_PROFILE_BUNDLES: [],
}))
vi.mock('../src/dsh.js', () => ({
  resolveDshBin: () => 'dsh.js', resolvePnpmCli: () => 'pnpm.js', preparePnpmShim: () => 'shim',
  withBundledPnpmPath: () => ({}), dshArguments: () => [], dshTokenFromLine: (line: string) => line,
  skippedBundleFromLine: () => undefined, waitForDsh: harness.waitDsh,
  DSH_TOKEN_TIMEOUT_MS: 100, DSH_READY_TIMEOUT_MS: 60_000, DSH_TOKEN_ENV_NAME: 'DSH_STATION_DSH_TOKEN',
}))
vi.mock('../src/dsh-plugins.js', () => ({ resolveDshPluginOverlays: () => [], SHELL_PLUGIN_PACKAGE_NAMES: [] }))
vi.mock('../src/plugin-lifecycle.js', () => ({}))
vi.mock('../src/plugin-catalog.js', () => ({ DISTRIBUTION_PACKAGE_NAMES: [] }))
vi.mock('../src/relay.js', () => ({ resolveRelayEntry: () => 'relay.js', relayArguments: () => [] }))
vi.mock('../src/connector.js', () => ({ resolveConnectorEntry: () => 'connector.js', connectorArguments: () => [] }))
vi.mock('../src/jwt-secret.js', () => ({
  loadOrCreateJwtSecret: () => 'test-secret', jwtSecretFilePath: () => 'jwt-secret', JWT_SECRET_ENV_NAME: 'JWT_SECRET',
}))
vi.mock('../src/trusted-hosts.js', () => ({ lanAddress: () => '192.168.1.2', trustedHostsFor: () => ['127.0.0.1'] }))
vi.mock('../src/dsh-restart.js', () => ({
  watchMembershipTrust: (options: TrustWatcherOptions) => {
    harness.trustChange = options.onChange
    return { close: harness.stopWatcher }
  },
  dshRestartStatusFilePath: () => 'restart.json', writeDshRestartStatus: harness.restartStatus,
}))
vi.mock('../src/relay-admin.js', () => ({ relayAdminInitialized: () => false }))
vi.mock('../src/banner.js', () => ({ renderBanner: () => 'banner' }))
vi.mock('../src/supervisor.js', () => ({ createSupervisor: (options: SupervisorOptions) => {
  harness.unexpectedExit = options.onUnexpectedExit
  return {
    start: harness.start, stopAll: harness.stopAll,
    isRunning: (name: string) => harness.running.has(name), stop: harness.stop,
  }
} }))
vi.mock('../src/remote-ready.js', () => ({ waitForRemote: harness.wait }))

let imported: Promise<unknown> | undefined
let moduleSettled = false
let completeProbe: (() => void) | undefined
let rejectProbe: ((error: Error) => void) | undefined
let finishStop: (() => void) | undefined
let finishDsh: (() => void) | undefined
const originalArgv = process.argv
const originalExitCode = process.exitCode
let signalListeners: Map<'SIGINT' | 'SIGTERM', NodeJS.SignalsListener[]>

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.messages = []
  harness.handler = undefined
  harness.signal = undefined
  harness.trustChange = undefined
  harness.failStart = undefined
  harness.running.clear()
  imported = undefined
  moduleSettled = false
  completeProbe = undefined
  rejectProbe = undefined
  finishStop = undefined
  finishDsh = undefined
  signalListeners = new Map((['SIGINT', 'SIGTERM'] as const).map(signal => [signal, process.listeners(signal)]))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  let dshGeneration = 0
  harness.start.mockImplementation((spec) => {
    if (spec.name === harness.failStart) throw new Error(`${spec.name} spawn failed`)
    harness.running.add(spec.name)
    if (spec.name === 'dsh') spec.onLine?.(`test-token-${String(++dshGeneration)}`)
  })
  harness.stop.mockImplementation(async name => harness.running.delete(name))
  harness.stopAll.mockImplementation(async () => { harness.running.clear() })
  harness.waitDsh.mockResolvedValue(true)
  harness.wait.mockImplementation(({ signal }) => {
    harness.signal = signal
    return new Promise<void>((resolve, reject) => { completeProbe = resolve; rejectProbe = reject })
  })
})

afterEach(async () => {
  finishDsh?.()
  finishStop?.()
  harness.handler?.({ type: 'stop' })
  completeProbe?.()
  await imported
  for (const [signal, previous] of signalListeners) {
    for (const listener of process.listeners(signal)) {
      if (!previous.includes(listener)) process.removeListener(signal, listener)
    }
  }
  process.argv = originalArgv
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
})

async function launch(desktop = true): Promise<void> {
  process.argv = [process.execPath, 'launcher.js', ...(desktop ? ['--desktop'] : [])]
  imported = import('../src/index.js').then(() => { moduleSettled = true; return undefined })
  await vi.waitFor(() => expect(harness.handler).toBeDefined())
}

function started(): string[] {
  return harness.start.mock.calls.map(([spec]) => spec.name)
}

function lastStatus() {
  return harness.messages.findLast(message => message.type === 'status')
}

function startRemote(): void {
  harness.handler?.({ type: 'start-remote' })
}

function childExit(name: string, signal: ChildExit['signal'] = null): void {
  harness.running.delete(name)
  harness.unexpectedExit?.({ name, code: signal === null ? 1 : null, signal, recent: [] })
}

function changeTrust(): void {
  harness.trustChange?.({ next: ['127.0.0.1', 'new.example'], added: ['new.example'], removed: [] })
}

function deferConnectorStop(): void {
  harness.stop.mockImplementation(name => {
    if (name !== 'connector') return Promise.resolve(harness.running.delete(name))
    return new Promise<boolean>((resolve) => {
      finishStop = () => resolve(harness.running.delete(name))
    })
  })
}

function expectLocalSurvives(reason: string): void {
  expect(lastStatus()).toMatchObject({
    phase: 'ready', remoteState: 'failed', remoteEnabled: false, remoteError: reason,
    urls: { local: 'http://127.0.0.1:3080/' }, dshToken: 'test-token-1',
  })
  expect(harness.running.has('dsh')).toBe(true)
  expect(harness.stop).not.toHaveBeenCalledWith('dsh')
  expect(harness.stopAll).not.toHaveBeenCalled()
  expect(harness.close).not.toHaveBeenCalled()
  expect(harness.stopWatcher).not.toHaveBeenCalled()
  expect(harness.release).not.toHaveBeenCalled()
  expect(moduleSettled).toBe(false)
}

describe('desktop remote startup', () => {
  it('passes the workstation projection path to local and restarted dsh only', async () => {
    await launch()
    const initial = harness.start.mock.calls.find(([spec]) => spec.name === 'dsh')?.[0]
    expect(initial?.env?.[THEME_FILE_ENV_NAME]).toBe(resolvePath('test-home', THEME_FILE_NAME))
    expect(isAbsolute(initial?.env?.[THEME_FILE_ENV_NAME] ?? '')).toBe(true)
    changeTrust()
    await vi.waitFor(() => expect(harness.start.mock.calls.filter(([spec]) => spec.name === 'dsh')).toHaveLength(2))
    const restarted = harness.start.mock.calls.filter(([spec]) => spec.name === 'dsh')[1]?.[0]
    expect(restarted?.env?.[THEME_FILE_ENV_NAME]).toBe(initial?.env?.[THEME_FILE_ENV_NAME])
  })
  it('keeps local mode until readiness and deduplicates pending and completed requests', async () => {
    await launch()
    expect(started()).toEqual(['dsh'])
    expect(harness.messages.every(message => message.type === 'status' && message.remoteState === 'idle' && !message.remoteEnabled)).toBe(true)
    expect(lastStatus()).toMatchObject({ phase: 'ready', remoteState: 'idle', dshToken: 'test-token-1' })
    startRemote()
    startRemote()
    expect(started()).toEqual(['dsh', 'relay', 'connector'])
    expect(harness.start.mock.calls.at(-1)?.[0].env?.DSH_STATION_DSH_TOKEN).toBe('test-token-1')
    expect(harness.wait).toHaveBeenCalledTimes(1)
    expect(lastStatus()).toMatchObject({ phase: 'remote', remoteState: 'starting', remoteEnabled: false, urls: { local: 'http://127.0.0.1:3080/' } })
    completeProbe?.()
    await vi.waitFor(() => expect(lastStatus()).toMatchObject({
      phase: 'ready', remoteState: 'ready', remoteEnabled: true, urls: { local: 'http://127.0.0.1:30809/' },
    }))
    expect(lastStatus()?.remoteError).toBeUndefined()
    startRemote()
    expect(started()).toEqual(['dsh', 'relay', 'connector'])
    expect(harness.wait).toHaveBeenCalledTimes(1)
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('test-token'))
  })

  it.each(['relay', 'connector'])('isolates synchronous %s startup failure without retrying', async (name) => {
    await launch()
    harness.failStart = name
    startRemote()
    await vi.waitFor(() => expect(harness.stop).toHaveBeenCalledWith('relay'))
    expectLocalSurvives(`启用远程服务失败：${name} spawn failed`)
    expect(harness.running).toEqual(new Set(['dsh']))
    expect(harness.stop.mock.calls.flat()).toEqual(name === 'relay' ? ['relay'] : ['connector', 'relay'])
    expect(harness.wait).not.toHaveBeenCalled()
    const calls = started()
    startRemote()
    expect(started()).toEqual(calls)
    expectLocalSurvives(`启用远程服务失败：${name} spawn failed`)
  })

  it('isolates readiness timeout, cancels probing, and keeps the control channel usable', async () => {
    await launch()
    startRemote()
    rejectProbe?.(new Error('本机 relay → connector → dsh 在 20 秒内未就绪；最后结果：HTTP 502'))
    await vi.waitFor(() => expect(harness.stop).toHaveBeenCalledWith('relay'))
    expectLocalSurvives('启用远程服务失败：本机 relay → connector → dsh 在 20 秒内未就绪；最后结果：HTTP 502')
    expect(harness.running).toEqual(new Set(['dsh']))
    expect(harness.signal?.aborted).toBe(true)
    startRemote()
    expect(harness.wait).toHaveBeenCalledTimes(1)
    harness.handler?.({ type: 'stop' })
    await imported
    expect(harness.close).toHaveBeenCalledTimes(1)
    expect(harness.release).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBe(0)
  })

  it.each(['relay', 'connector'])('isolates an unexpected %s exit during startup and ignores late success', async (name) => {
    await launch()
    startRemote()
    childExit(name)
    expect(harness.signal?.aborted).toBe(true)
    completeProbe?.()
    await vi.waitFor(() => expect(harness.stop).toHaveBeenCalledWith('relay'))
    expectLocalSurvives(`启用远程服务失败：${name} 意外退出（退出码 1）`)
    expect(harness.stop.mock.calls.flat()).toEqual(['connector', 'relay'])
    expect(harness.running).toEqual(new Set(['dsh']))
  })

  it('keeps the first failure across another child exit, a late rejection, and repeated commands', async () => {
    await launch()
    startRemote()
    deferConnectorStop()
    childExit('connector', 'SIGTERM')
    await vi.waitFor(() => expect(harness.stop).toHaveBeenCalledWith('connector'))
    childExit('relay')
    rejectProbe?.(new Error('cancelled'))
    startRemote()
    finishStop?.()
    await vi.waitFor(() => expect(harness.stop).toHaveBeenCalledWith('relay'))
    expectLocalSurvives('启用远程服务失败：connector 意外退出（收到信号 SIGTERM）')
    expect(harness.stop.mock.calls.flat()).toEqual(['connector', 'relay'])
    expect(started()).toEqual(['dsh', 'relay', 'connector'])
  })

  it.each(['resolve', 'reject'])('cancels on stop and ignores late probe %s and child exits', async (outcome) => {
    await launch()
    startRemote()
    harness.handler?.({ type: 'stop' })
    harness.handler?.({ type: 'stop' })
    startRemote()
    expect(harness.signal?.aborted).toBe(true)
    childExit('connector')
    if (outcome === 'resolve') completeProbe?.()
    else rejectProbe?.(new Error('cancelled'))
    await imported
    expect(lastStatus()).toMatchObject({ phase: 'stopping', remoteState: 'starting', remoteEnabled: false })
    expect(harness.stopAll).toHaveBeenCalledTimes(1)
    expect(harness.stop).not.toHaveBeenCalled()
    expect(harness.close).toHaveBeenCalledTimes(1)
    expect(harness.release).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBe(0)
  })

  it('awaits in-flight failure cleanup before shutdown without repeating it', async () => {
    await launch()
    startRemote()
    deferConnectorStop()
    rejectProbe?.(new Error('HTTP 502'))
    await vi.waitFor(() => expect(harness.stop).toHaveBeenCalledWith('connector'))
    expectLocalSurvives('启用远程服务失败：HTTP 502')
    harness.handler?.({ type: 'stop' })
    harness.handler?.({ type: 'stop' })
    startRemote()
    expect(harness.stopAll).not.toHaveBeenCalled()
    expect(harness.close).toHaveBeenCalledTimes(1)
    finishStop?.()
    await imported
    expect(harness.stop.mock.calls.flat()).toEqual(['connector', 'relay'])
    expect(harness.stopAll).toHaveBeenCalledTimes(1)
    expect(harness.release).toHaveBeenCalledTimes(1)
    expect(lastStatus()).toMatchObject({ phase: 'stopping', remoteState: 'failed', remoteError: '启用远程服务失败：HTTP 502' })
    expect(process.exitCode).toBe(0)
  })

  it('still shuts down everything when dsh exits during remote startup', async () => {
    await launch()
    startRemote()
    childExit('dsh')
    completeProbe?.()
    await imported
    expect(harness.signal?.aborted).toBe(true)
    expect(lastStatus()).toMatchObject({ phase: 'failed', detail: 'dsh 意外退出', remoteEnabled: false })
    expect(harness.stopAll).toHaveBeenCalledTimes(1)
    expect(harness.close).toHaveBeenCalledTimes(1)
    expect(harness.release).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBe(1)
  })

  it.each(['connector', 'relay'])('preserves full shutdown for a fatal %s exit after remote readiness', async (name) => {
    await launch()
    startRemote()
    completeProbe?.()
    await vi.waitFor(() => expect(lastStatus()?.remoteEnabled).toBe(true))
    childExit(name)
    await imported
    expect(lastStatus()).toMatchObject({ phase: 'failed', detail: `${name} 意外退出`, remoteState: 'ready' })
    expect(harness.stopAll).toHaveBeenCalledTimes(1)
    expect(harness.stop).not.toHaveBeenCalled()
    expect(harness.close).toHaveBeenCalledTimes(1)
    expect(harness.stopWatcher).toHaveBeenCalledTimes(1)
    expect(harness.release).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBe(1)
  })
})

describe('membership trust and CLI compatibility', () => {
  it.each(['idle', 'failed'])('does not start connector for membership changes while remote is %s', async (state) => {
    await launch()
    if (state === 'failed') {
      startRemote()
      rejectProbe?.(new Error('HTTP 502'))
      await vi.waitFor(() => expect(harness.stop).toHaveBeenCalledWith('relay'))
    }
    const before = started()
    changeTrust()
    await vi.waitFor(() => expect(harness.restartStatus).toHaveBeenCalledWith('restart.json', expect.objectContaining({ state: 'done' })))
    expect(started()).toEqual([...before, 'dsh'])
    expect(harness.running).toEqual(new Set(['dsh']))
    expect(harness.close).not.toHaveBeenCalled()
    expect(lastStatus()).toMatchObject({ phase: 'ready', remoteState: state, remoteEnabled: false, dshToken: 'test-token-2' })
    if (state === 'failed') expect(lastStatus()?.remoteError).toBe('启用远程服务失败：HTTP 502')
    expect(harness.messages.filter(message => message.type === 'status').every(message => message.remoteState !== undefined)).toBe(true)
  })

  it.each(['starting', 'ready'])('refreshes the connector token on membership changes while remote is %s', async (state) => {
    await launch()
    startRemote()
    if (state === 'ready') {
      completeProbe?.()
      await vi.waitFor(() => expect(lastStatus()?.remoteEnabled).toBe(true))
    }
    changeTrust()
    await vi.waitFor(() => expect(harness.restartStatus).toHaveBeenCalledWith('restart.json', expect.objectContaining({ state: 'done' })))
    expect(started()).toEqual(['dsh', 'relay', 'connector', 'dsh', 'connector'])
    expect(harness.start.mock.calls.at(-1)?.[0].env?.DSH_STATION_DSH_TOKEN).toBe('test-token-2')
    expect(lastStatus()).toMatchObject({ phase: state === 'starting' ? 'remote' : 'ready', remoteState: state })
    expect(harness.wait).toHaveBeenCalledTimes(1)
  })

  it('does not resurrect connector when startup fails during its trust refresh', async () => {
    await launch()
    startRemote()
    deferConnectorStop()
    changeTrust()
    await vi.waitFor(() => expect(harness.stop).toHaveBeenCalledWith('connector'))
    rejectProbe?.(new Error('HTTP 502'))
    await vi.waitFor(() => expect(lastStatus()?.remoteState).toBe('failed'))
    finishStop?.()
    await vi.waitFor(() => expect(harness.stop).toHaveBeenCalledWith('relay'))
    expect(started()).toEqual(['dsh', 'relay', 'connector', 'dsh'])
    expect(harness.stop.mock.calls.flat()).toEqual(['dsh', 'connector', 'relay'])
    expect(harness.running).toEqual(new Set(['dsh']))
    expect(lastStatus()).toMatchObject({ phase: 'ready', remoteState: 'failed', remoteError: '启用远程服务失败：HTTP 502' })
    expect(harness.stopAll).not.toHaveBeenCalled()
  })

  it('waits for an ongoing trust refresh stop before shutting down and never respawns connector', async () => {
    await launch()
    startRemote()
    deferConnectorStop()
    changeTrust()
    await vi.waitFor(() => expect(harness.stop).toHaveBeenCalledWith('connector'))
    harness.handler?.({ type: 'stop' })
    completeProbe?.()
    expect(harness.signal?.aborted).toBe(true)
    expect(harness.stopAll).not.toHaveBeenCalled()
    expect(harness.close).toHaveBeenCalledTimes(1)
    finishStop?.()
    await imported
    expect(started()).toEqual(['dsh', 'relay', 'connector', 'dsh'])
    expect(harness.stop.mock.calls.flat()).toEqual(['dsh', 'connector'])
    expect(harness.stopAll).toHaveBeenCalledTimes(1)
    expect(lastStatus()?.phase).toBe('stopping')
    expect(process.exitCode).toBe(0)
  })

  it('isolates synchronous connector refresh failure during startup', async () => {
    await launch()
    startRemote()
    harness.failStart = 'connector'
    changeTrust()
    await vi.waitFor(() => expect(harness.stop).toHaveBeenCalledWith('relay'))
    expect(lastStatus()).toMatchObject({ phase: 'ready', remoteState: 'failed', remoteError: '启用远程服务失败：connector spawn failed' })
    expect(harness.running).toEqual(new Set(['dsh']))
    expect(harness.stopAll).not.toHaveBeenCalled()
    expect(harness.signal?.aborted).toBe(true)
  })

  it('leaves CLI full startup and trust refresh unchanged without readiness probes', async () => {
    await launch(false)
    expect(started()).toEqual(['relay', 'dsh', 'connector'])
    startRemote()
    harness.handler?.({ type: 'stop-remote' })
    harness.handler?.({ type: 'restart-remote' })
    expect(started()).toEqual(['relay', 'dsh', 'connector'])
    changeTrust()
    await vi.waitFor(() => expect(harness.restartStatus).toHaveBeenCalledWith('restart.json', expect.objectContaining({ state: 'done' })))
    expect(started()).toEqual(['relay', 'dsh', 'connector', 'dsh', 'connector'])
    expect(harness.wait).not.toHaveBeenCalled()
  })

  it.each(['relay', 'connector'])('preserves CLI full shutdown for an unexpected %s exit', async (name) => {
    await launch(false)
    childExit(name)
    await imported
    expect(lastStatus()).toMatchObject({ phase: 'failed', detail: `${name} 意外退出` })
    expect(harness.stopAll).toHaveBeenCalledTimes(1)
    expect(harness.close).toHaveBeenCalledTimes(1)
    expect(harness.release).toHaveBeenCalledTimes(1)
    expect(harness.wait).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})

async function enableRemote(): Promise<void> {
  startRemote()
  completeProbe?.()
  await vi.waitFor(() => expect(lastStatus()?.remoteState).toBe('ready'))
}

function expectLocalResourcesRetained(): void {
  expect(harness.running.has('dsh')).toBe(true)
  expect(started().filter(name => name === 'dsh')).toHaveLength(1)
  expect(harness.stop).not.toHaveBeenCalledWith('dsh')
  expect(harness.stopAll).not.toHaveBeenCalled()
  expect(harness.close).not.toHaveBeenCalled()
  expect(harness.stopWatcher).not.toHaveBeenCalled()
  expect(harness.release).not.toHaveBeenCalled()
  expect(harness.restartStatus).not.toHaveBeenCalled()
  expect(moduleSettled).toBe(false)
  expect(harness.messages.filter(message => message.type === 'status').every(message => message.pid === process.pid)).toBe(true)
  expect(lastStatus()?.dshToken).toBe('test-token-1')
}

describe('desktop remote stop and restart commands', () => {
  it('stops only remote children, immediately switches to dsh, and can enable again with the same token', async () => {
    await launch()
    await enableRemote()
    const initialSignal = harness.signal
    deferConnectorStop()
    harness.handler?.({ type: 'stop-remote' })
    expect(lastStatus()).toMatchObject({
      phase: 'remote', remoteState: 'stopping', remoteEnabled: false,
      urls: { local: 'http://127.0.0.1:3080/' },
    })
    expect(initialSignal?.aborted).toBe(true)
    expectLocalResourcesRetained()
    harness.handler?.({ type: 'stop-remote' })
    harness.handler?.({ type: 'restart-remote' })
    startRemote()
    childExit('relay')
    await vi.waitFor(() => expect(harness.stop.mock.calls.flat()).toEqual(['connector']))
    finishStop?.()
    await vi.waitFor(() => expect(lastStatus()).toMatchObject({ phase: 'ready', remoteState: 'idle', remoteEnabled: false }))
    expect(harness.stop.mock.calls.flat()).toEqual(['connector', 'relay'])
    expect(harness.running).toEqual(new Set(['dsh']))
    expectLocalResourcesRetained()
    const messageCount = harness.messages.length
    harness.handler?.({ type: 'stop-remote' })
    harness.handler?.({ type: 'restart-remote' })
    expect(harness.messages).toHaveLength(messageCount)
    await enableRemote()
    expect(started()).toEqual(['dsh', 'relay', 'connector', 'relay', 'connector'])
    expect(harness.signal).not.toBe(initialSignal)
    expect(harness.signal?.aborted).toBe(false)
    expect(harness.start.mock.calls.at(-1)?.[0].env?.DSH_STATION_DSH_TOKEN).toBe('test-token-1')
    expectLocalResourcesRetained()
  })

  it('restarts remote only once through stopping → starting → ready, with no intermediate idle', async () => {
    await launch()
    await enableRemote()
    const from = harness.messages.length
    harness.handler?.({ type: 'restart-remote' })
    harness.handler?.({ type: 'restart-remote' })
    harness.handler?.({ type: 'stop-remote' })
    startRemote()
    expect(lastStatus()?.remoteState).toBe('stopping')
    await vi.waitFor(() => expect(harness.wait).toHaveBeenCalledTimes(2))
    expect(lastStatus()).toMatchObject({ remoteState: 'starting', remoteEnabled: false, urls: { local: 'http://127.0.0.1:3080/' } })
    harness.handler?.({ type: 'restart-remote' })
    harness.handler?.({ type: 'stop-remote' })
    completeProbe?.()
    await vi.waitFor(() => expect(lastStatus()).toMatchObject({ phase: 'ready', remoteState: 'ready', remoteEnabled: true }))
    expect(harness.messages.slice(from).map(message => message.type === 'status' ? message.remoteState : message.type)).toEqual(['stopping', 'starting', 'ready'])
    expect(harness.stop.mock.calls.flat()).toEqual(['connector', 'relay'])
    expect(started()).toEqual(['dsh', 'relay', 'connector', 'relay', 'connector'])
    expectLocalResourcesRetained()
  })

  it.each(['stop-remote', 'restart-remote'] as const)('shutdown waits for %s cleanup and never respawns children', async (type) => {
    await launch()
    await enableRemote()
    deferConnectorStop()
    harness.handler?.({ type })
    await vi.waitFor(() => expect(harness.stop).toHaveBeenCalledWith('connector'))
    harness.handler?.({ type: 'stop' })
    harness.handler?.({ type: 'restart-remote' })
    startRemote()
    expect(lastStatus()).toMatchObject({ phase: 'stopping', remoteState: 'stopping', remoteEnabled: false })
    expect(harness.stopAll).not.toHaveBeenCalled()
    finishStop?.()
    await imported
    expect(started()).toEqual(['dsh', 'relay', 'connector'])
    expect(harness.stop.mock.calls.flat()).toEqual(['connector', 'relay'])
    expect(harness.stopAll).toHaveBeenCalledTimes(1)
    expect(harness.close).toHaveBeenCalledTimes(1)
    expect(harness.stopWatcher).toHaveBeenCalledTimes(1)
    expect(harness.release).toHaveBeenCalledTimes(1)
    expect(lastStatus()?.phase).toBe('stopping')
  })

  it.each(['resolve', 'reject'] as const)('ignores a late restarted probe %s after shutdown', async (outcome) => {
    await launch()
    await enableRemote()
    harness.handler?.({ type: 'restart-remote' })
    await vi.waitFor(() => expect(harness.wait).toHaveBeenCalledTimes(2))
    harness.handler?.({ type: 'stop' })
    if (outcome === 'resolve') completeProbe?.()
    else rejectProbe?.(new Error('late probe'))
    await imported
    expect(harness.signal?.aborted).toBe(true)
    expect(lastStatus()).toMatchObject({ phase: 'stopping', remoteState: 'starting', remoteEnabled: false })
    expect(lastStatus()?.remoteError).toBeUndefined()
    expect(harness.stopAll).toHaveBeenCalledTimes(1)
    expect(started()).toEqual(['dsh', 'relay', 'connector', 'relay', 'connector'])
  })

  it('retains local resources on restart failure and does not allow implicit retry', async () => {
    await launch()
    await enableRemote()
    harness.handler?.({ type: 'restart-remote' })
    await vi.waitFor(() => expect(harness.wait).toHaveBeenCalledTimes(2))
    rejectProbe?.(new Error('HTTP 502'))
    await vi.waitFor(() => expect(harness.stop.mock.calls.flat()).toEqual(['connector', 'relay', 'connector', 'relay']))
    expectLocalSurvives('启用远程服务失败：HTTP 502')
    startRemote()
    harness.handler?.({ type: 'restart-remote' })
    harness.handler?.({ type: 'stop-remote' })
    expect(started()).toEqual(['dsh', 'relay', 'connector', 'relay', 'connector'])
    expectLocalResourcesRetained()
  })
})

describe('remote commands interleaved with membership trust refresh', () => {
  it.each(['stop-remote', 'restart-remote'] as const)('shares the connector stop during %s and never restores the old connector', async (type) => {
    await launch()
    await enableRemote()
    deferConnectorStop()
    changeTrust()
    await vi.waitFor(() => expect(harness.stop).toHaveBeenCalledWith('connector'))
    harness.handler?.({ type })
    expect(lastStatus()).toMatchObject({ phase: 'restarting', remoteState: 'stopping', remoteEnabled: false })
    finishStop?.()
    await vi.waitFor(() => expect(harness.restartStatus).toHaveBeenCalledWith('restart.json', expect.objectContaining({ state: 'done' })))
    if (type === 'restart-remote') {
      await vi.waitFor(() => expect(harness.wait).toHaveBeenCalledTimes(2))
      completeProbe?.()
    }
    await vi.waitFor(() => expect(lastStatus()?.remoteState).toBe(type === 'restart-remote' ? 'ready' : 'idle'))
    expect(harness.stop.mock.calls.flat()).toEqual(['dsh', 'connector', 'relay'])
    expect(started()).toEqual(['dsh', 'relay', 'connector', 'dsh', ...(type === 'restart-remote' ? ['relay', 'connector'] : [])])
    expect(harness.stopAll).not.toHaveBeenCalled()
    expect(lastStatus()?.dshToken).toBe('test-token-2')
    if (type === 'restart-remote') {
      expect(harness.start.mock.calls.at(-1)?.[0].env?.DSH_STATION_DSH_TOKEN).toBe('test-token-2')
    }
  })

  it.each(['ready', 'failed', 'idle'] as const)('remote %s does not publish phase ready until dsh trust restart finishes', async (state) => {
    await launch()
    startRemote()
    if (state === 'idle') {
      completeProbe?.()
      await vi.waitFor(() => expect(lastStatus()?.remoteState).toBe('ready'))
    }
    harness.waitDsh.mockReturnValueOnce(new Promise<boolean>((resolve) => { finishDsh = () => resolve(true) }))
    changeTrust()
    await vi.waitFor(() => expect(harness.waitDsh).toHaveBeenCalledTimes(2))
    const from = harness.messages.length
    if (state === 'ready') completeProbe?.()
    else if (state === 'failed') rejectProbe?.(new Error('HTTP 502'))
    else harness.handler?.({ type: 'stop-remote' })
    await vi.waitFor(() => expect(lastStatus()?.remoteState).toBe(state))
    expect(harness.messages.slice(from).every(message => message.type === 'status' && message.phase === 'restarting')).toBe(true)
    expect(lastStatus()).toMatchObject({ phase: 'restarting', remoteState: state })
    expect(harness.restartStatus).not.toHaveBeenCalledWith('restart.json', expect.objectContaining({ state: 'done' }))
    finishDsh?.()
    await vi.waitFor(() => expect(lastStatus()?.phase).toBe('ready'))
    expect(lastStatus()?.remoteState).toBe(state)
    expect(harness.running.has('connector')).toBe(state === 'ready')
  })
})
