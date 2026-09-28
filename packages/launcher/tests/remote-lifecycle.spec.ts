import { describe, expect, it, vi } from 'vitest'
import { createRemoteLifecycle } from '../src/remote-lifecycle.js'
import type { ChildExit } from '../src/supervisor.js'

const noop = (): void => undefined

function deferred() {
  let resolve: () => void = noop
  let reject: (error: unknown) => void = noop
  const promise = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

function setup() {
  const probe = deferred()
  const options = {
    startRelay: vi.fn<() => void>(),
    startConnector: vi.fn<() => void>(),
    stopChild: vi.fn<(name: string) => Promise<boolean>>().mockResolvedValue(true),
    waitForReady: vi.fn<(signal: AbortSignal) => Promise<void>>().mockReturnValue(probe.promise),
    onChange: vi.fn(),
  }
  return { remote: createRemoteLifecycle(options), options, probe }
}

function exit(name = 'connector'): ChildExit {
  return { name, code: 1, signal: null, recent: ['not copied into remoteError'] }
}

describe('remote lifecycle', () => {
  it('reports a safe port-conflict category without copying sensitive logs', async () => {
    const { remote, options } = setup()
    options.startRelay.mockImplementation(() => {
      remote.handleExit({ ...exit('relay'), recent: ['EADDRINUSE token=secret-private-value'] })
    })
    await remote.start()
    expect(remote.error).toBe('启用远程服务失败：relay 端口已被占用（EADDRINUSE）')
    expect(remote.error).not.toContain('secret-private-value')
  })

  it('moves idle → starting → ready once and exposes the probe cancellation signal', async () => {
    const { remote, options, probe } = setup()
    expect(remote.state).toBe('idle')
    const pending = remote.start()
    await remote.start()
    expect(remote.state).toBe('starting')
    expect(options.startRelay).toHaveBeenCalledTimes(1)
    expect(options.startConnector).toHaveBeenCalledTimes(1)
    expect(options.waitForReady.mock.calls[0]?.[0].aborted).toBe(false)
    probe.resolve()
    await pending
    await remote.start()
    expect(remote.state).toBe('ready')
    expect(remote.error).toBeUndefined()
    expect(options.onChange.mock.calls).toEqual([['starting'], ['ready']])
    await remote.cancel()
    expect(options.waitForReady.mock.calls[0]?.[0].aborted).toBe(true)
    expect(options.stopChild).not.toHaveBeenCalled()
  })

  it('does not start or replace children after cancellation', async () => {
    const { remote, options } = setup()
    await remote.cancel()
    await remote.start()
    const restart = vi.fn()
    await remote.restartConnector(restart)
    expect(remote.state).toBe('idle')
    expect(options.startRelay).not.toHaveBeenCalled()
    expect(options.waitForReady).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })

  it.each(['startRelay', 'startConnector'] as const)('cleans only attempted children on synchronous %s failure', async (method) => {
    const { remote, options } = setup()
    options[method].mockImplementation(() => { throw new Error('spawn failed') })
    await remote.start()
    expect(remote.state).toBe('failed')
    expect(remote.error).toBe('启用远程服务失败：spawn failed')
    expect(options.waitForReady).not.toHaveBeenCalled()
    expect(options.stopChild.mock.calls.flat()).toEqual(method === 'startRelay' ? ['relay'] : ['connector', 'relay'])
    await remote.start()
    expect(options[method]).toHaveBeenCalledTimes(1)
  })

  it('stops startup immediately when a supervisor callback fails it synchronously', async () => {
    const { remote, options } = setup()
    options.startRelay.mockImplementation(() => { remote.handleExit(exit('relay')) })
    await remote.start()
    await remote.cancel()
    expect(options.startConnector).not.toHaveBeenCalled()
    expect(options.waitForReady).not.toHaveBeenCalled()
    expect(options.stopChild.mock.calls.flat()).toEqual(['relay'])
    expect(remote.error).toBe('启用远程服务失败：relay 意外退出（退出码 1）')
  })

  it.each(['resolve', 'reject'])('ignores a late readiness %s after supervisor failure', async (outcome) => {
    const { remote, options, probe } = setup()
    const pending = remote.start()
    expect(remote.handleExit(exit())).toBe(true)
    expect(remote.handleExit(exit('relay'))).toBe(true)
    expect(options.waitForReady.mock.calls[0]?.[0].aborted).toBe(true)
    if (outcome === 'resolve') probe.resolve()
    else probe.reject(new Error('aborted'))
    await pending
    await remote.cancel()
    expect(remote.state).toBe('failed')
    expect(remote.error).toBe('启用远程服务失败：connector 意外退出（退出码 1）')
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector', 'relay'])
    expect(options.onChange.mock.calls.map(([state]) => state)).toEqual(['starting', 'failed'])
  })

  it('never consumes dsh exits, or remote exits outside the startup failure boundary', async () => {
    const { remote, probe } = setup()
    expect(remote.handleExit(exit())).toBe(false)
    const pending = remote.start()
    expect(remote.handleExit(exit('dsh'))).toBe(false)
    probe.resolve()
    await pending
    expect(remote.handleExit(exit())).toBe(false)
    expect(remote.handleExit(exit('relay'))).toBe(false)
    await remote.cancel()
    expect(remote.handleExit(exit())).toBe(false)
  })

  it('waits for failure cleanup once even when cancelled more than once', async () => {
    const { remote, options, probe } = setup()
    const stopping = deferred()
    options.stopChild.mockImplementation(async name => {
      if (name === 'connector') await stopping.promise
      return true
    })
    const pending = remote.start()
    probe.reject('HTTP 502')
    await vi.waitFor(() => expect(options.stopChild).toHaveBeenCalledWith('connector'))
    const first = remote.cancel()
    expect(remote.cancel()).toBe(first)
    await remote.start()
    expect(options.startConnector).toHaveBeenCalledTimes(1)
    stopping.resolve()
    await first
    await pending
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector', 'relay'])
  })

  it('continues cleanup if one stop throws and retains both failure causes', async () => {
    const { remote, options, probe } = setup()
    options.stopChild.mockRejectedValueOnce(new Error('stop denied'))
    const pending = remote.start()
    probe.reject(new Error('HTTP 502'))
    await pending
    await remote.cancel()
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector', 'relay'])
    expect(remote.error).toBe('启用远程服务失败：HTTP 502；停止 connector 失败：stop denied')
  })

  it('does not start connector from an idle or failed trust refresh', async () => {
    const { remote, options, probe } = setup()
    const restart = vi.fn()
    await remote.restartConnector(restart)
    const pending = remote.start()
    probe.reject(new Error('HTTP 502'))
    await pending
    await remote.restartConnector(restart)
    expect(restart).not.toHaveBeenCalled()
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector', 'relay'])
  })

  it('shares a pending connector stop with failure cleanup and never respawns afterward', async () => {
    const { remote, options, probe } = setup()
    const stopped = deferred()
    options.stopChild.mockImplementation(async name => {
      if (name === 'connector') await stopped.promise
      return true
    })
    const pending = remote.start()
    const restart = vi.fn()
    const refreshing = remote.restartConnector(restart)
    remote.handleExit(exit('relay'))
    stopped.resolve()
    probe.resolve()
    await Promise.all([pending, refreshing, remote.cancel()])
    expect(restart).not.toHaveBeenCalled()
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector', 'relay'])
    expect(remote.state).toBe('failed')
  })

  it('awaits an in-flight trust refresh stop on cancellation without respawning connector', async () => {
    const { remote, options, probe } = setup()
    const stopped = deferred()
    options.stopChild.mockImplementation(async () => { await stopped.promise; return true })
    const pending = remote.start()
    const restart = vi.fn()
    const refreshing = remote.restartConnector(restart)
    const cancelled = vi.fn()
    const cancelling = remote.cancel().then(cancelled)
    await Promise.resolve()
    expect(cancelled).not.toHaveBeenCalled()
    stopped.resolve()
    probe.resolve()
    await Promise.all([pending, refreshing, cancelling])
    expect(restart).not.toHaveBeenCalled()
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector'])
  })

  it('leaves synchronous ready-state connector replacement errors to the caller', async () => {
    const { remote, probe } = setup()
    const pending = remote.start()
    probe.resolve()
    await pending
    await expect(remote.restartConnector(() => { throw new Error('replacement failed') })).rejects.toThrow('replacement failed')
    expect(remote.state).toBe('ready')
  })
})

async function readyRemote() {
  const setupResult = setup()
  const pending = setupResult.remote.start()
  setupResult.probe.resolve()
  await pending
  return setupResult
}

describe('repeatable remote lifecycle', () => {
  it('ignores stop/restart while idle, starting, or terminally failed', async () => {
    const { remote, options, probe } = setup()
    await remote.stop()
    await remote.restart()
    expect(options.onChange).not.toHaveBeenCalled()
    const pending = remote.start()
    await remote.stop()
    await remote.restart()
    expect(remote.state).toBe('starting')
    probe.reject(new Error('HTTP 502'))
    await pending
    await remote.stop()
    await remote.restart()
    await remote.start()
    expect(remote.state).toBe('failed')
    expect(options.startRelay).toHaveBeenCalledTimes(1)
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector', 'relay'])
  })

  it('stops connector before relay, publishes stopping immediately, and can start a new generation', async () => {
    const { remote, options } = await readyRemote()
    const stopped = deferred()
    options.stopChild.mockImplementationOnce(async () => { await stopped.promise; return true })
    const oldSignal = options.waitForReady.mock.calls[0]?.[0]
    const pending = remote.stop()
    expect(remote.state).toBe('stopping')
    expect(oldSignal?.aborted).toBe(true)
    expect(remote.handleExit(exit('relay'))).toBe(true)
    expect(remote.handleExit(exit('connector'))).toBe(true)
    expect(remote.handleExit(exit('dsh'))).toBe(false)
    await remote.stop()
    await remote.restart()
    await remote.start()
    await vi.waitFor(() => expect(options.stopChild.mock.calls.flat()).toEqual(['connector']))
    stopped.resolve()
    await pending
    expect(remote.state).toBe('idle')
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector', 'relay'])
    const probe = deferred()
    options.waitForReady.mockReturnValueOnce(probe.promise)
    const starting = remote.start()
    expect(options.waitForReady.mock.calls[1]?.[0]).not.toBe(oldSignal)
    expect(options.waitForReady.mock.calls[1]?.[0].aborted).toBe(false)
    probe.resolve()
    await starting
    expect(options.startRelay).toHaveBeenCalledTimes(2)
    expect(options.startConnector).toHaveBeenCalledTimes(2)
    expect(options.onChange.mock.calls.map(([state]) => state)).toEqual(['starting', 'ready', 'stopping', 'idle', 'starting', 'ready'])
  })

  it('restarts exactly once without publishing idle, waiting for fresh readiness', async () => {
    const { remote, options } = await readyRemote()
    const probe = deferred()
    options.waitForReady.mockReturnValueOnce(probe.promise)
    const pending = remote.restart()
    await remote.restart()
    await remote.stop()
    await remote.start()
    await vi.waitFor(() => expect(remote.state).toBe('starting'))
    await remote.restart()
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector', 'relay'])
    expect(options.startRelay).toHaveBeenCalledTimes(2)
    expect(options.startConnector).toHaveBeenCalledTimes(2)
    probe.resolve()
    await pending
    expect(options.onChange.mock.calls.map(([state]) => state)).toEqual(['starting', 'ready', 'stopping', 'starting', 'ready'])
  })

  it.each(['stop', 'restart'] as const)('cancel during %s waits for cleanup and permanently prevents respawn', async (command) => {
    const { remote, options } = await readyRemote()
    const stopped = deferred()
    options.stopChild.mockImplementationOnce(async () => { await stopped.promise; return true })
    const pending = remote[command]()
    const cancelling = remote.cancel()
    expect(remote.cancel()).toBe(cancelling)
    await remote.start()
    await remote.restart()
    expect(options.startRelay).toHaveBeenCalledTimes(1)
    stopped.resolve()
    await Promise.all([pending, cancelling])
    await remote.stop()
    await remote.start()
    await remote.restart()
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector', 'relay'])
    expect(options.startRelay).toHaveBeenCalledTimes(1)
    expect(options.onChange.mock.calls.map(([state]) => state)).toEqual(['starting', 'ready', 'stopping'])
  })

  it('claims remote cleanup before an abort listener can request full shutdown', async () => {
    const { remote, options } = await readyRemote()
    const stopped = deferred()
    options.stopChild.mockImplementationOnce(async () => { await stopped.promise; return true })
    const cancelled = vi.fn()
    let cancelling: Promise<void> | undefined
    options.waitForReady.mock.calls[0]?.[0].addEventListener('abort', () => {
      cancelling = remote.cancel().then(cancelled)
    })
    const pending = remote.restart()
    await vi.waitFor(() => expect(options.stopChild).toHaveBeenCalledWith('connector'))
    expect(cancelled).not.toHaveBeenCalled()
    stopped.resolve()
    await Promise.all([pending, cancelling])
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector', 'relay'])
    expect(options.startRelay).toHaveBeenCalledTimes(1)
    expect(cancelled).toHaveBeenCalledTimes(1)
  })
  it.each(['resolve', 'reject'] as const)('ignores late %s from the restarted probe after cancellation', async (outcome) => {
    const { remote, options } = await readyRemote()
    const probe = deferred()
    options.waitForReady.mockReturnValueOnce(probe.promise)
    const pending = remote.restart()
    await vi.waitFor(() => expect(options.waitForReady).toHaveBeenCalledTimes(2))
    await remote.cancel()
    if (outcome === 'resolve') probe.resolve()
    else probe.reject(new Error('late failure'))
    await pending
    expect(remote.error).toBeUndefined()
    expect(options.waitForReady.mock.calls.every(([signal]) => signal.aborted)).toBe(true)
    expect(options.onChange.mock.calls.map(([state]) => state)).toEqual(['starting', 'ready', 'stopping', 'starting'])
  })

  it('does not let an old ready notification error fail a later generation', async () => {
    const { remote, options, probe } = setup()
    let restarting: Promise<void> | undefined
    options.onChange.mockImplementationOnce(noop).mockImplementationOnce(() => {
      restarting = remote.restart()
      throw new Error('late notification error')
    })
    const pending = remote.start()
    probe.resolve()
    await pending
    await restarting
    expect(remote.state).toBe('ready')
    expect(remote.error).toBeUndefined()
    expect(options.startRelay).toHaveBeenCalledTimes(2)
  })

  it.each(['stop', 'restart'] as const)('shares trust refresh cleanup with %s without reviving the old connector', async (command) => {
    const { remote, options } = await readyRemote()
    const stopped = deferred()
    options.stopChild.mockImplementationOnce(async () => { await stopped.promise; return true })
    const replace = vi.fn()
    const refreshing = remote.restartConnector(replace)
    const repeated = remote.restartConnector(replace)
    const pending = remote[command]()
    await remote.restartConnector(replace)
    await vi.waitFor(() => expect(options.stopChild.mock.calls.flat()).toEqual(['connector']))
    stopped.resolve()
    await Promise.all([refreshing, repeated, pending])
    expect(replace).not.toHaveBeenCalled()
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector', 'relay'])
    expect(options.startConnector).toHaveBeenCalledTimes(command === 'restart' ? 2 : 1)
    expect(remote.state).toBe(command === 'restart' ? 'ready' : 'idle')
  })

  it('deduplicates simultaneous trust refresh requests in the same generation', async () => {
    const { remote, options } = await readyRemote()
    const replace = vi.fn()
    await Promise.all([remote.restartConnector(replace), remote.restartConnector(replace)])
    expect(replace).toHaveBeenCalledTimes(1)
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector'])
  })

  it('keeps a failed restart terminal and never retries implicitly', async () => {
    const { remote, options } = await readyRemote()
    options.waitForReady.mockRejectedValueOnce(new Error('HTTP 502'))
    await remote.restart()
    await remote.restart()
    await remote.start()
    expect(remote.state).toBe('failed')
    expect(options.startRelay).toHaveBeenCalledTimes(2)
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector', 'relay', 'connector', 'relay'])
  })

  it('continues stopping relay on a connector stop error and never starts a replacement', async () => {
    const { remote, options } = await readyRemote()
    options.stopChild.mockRejectedValueOnce(new Error('stop denied'))
    await remote.restart()
    expect(remote.state).toBe('failed')
    expect(remote.error).toContain('stop denied')
    expect(options.stopChild.mock.calls.flat()).toEqual(['connector', 'relay'])
    expect(options.startRelay).toHaveBeenCalledTimes(1)
    await remote.restart()
    await remote.start()
    expect(options.startRelay).toHaveBeenCalledTimes(1)
  })
})
