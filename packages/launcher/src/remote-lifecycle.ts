import { CONNECTOR_CHILD, RELAY_CHILD } from './children.js'
import type { RemoteState } from './desktop-link.js'
import type { ChildExit, Supervisor } from './supervisor.js'

export interface RemoteLifecycleOptions {
  readonly startRelay: () => void
  readonly startConnector: () => void
  readonly stopChild: Supervisor['stop']
  readonly waitForReady: (signal: AbortSignal) => Promise<void>
  readonly onChange: (state: RemoteState, error?: string) => void
}

export interface RemoteLifecycle {
  readonly state: RemoteState
  readonly error: string | undefined
  /** 仅空闲时启用；等待中、已成功或已失败时均不重试。 */
  start(): Promise<void>
  /** 仅停止已就绪的远程服务，完成后可再次启用。 */
  stop(): Promise<void>
  /** 仅重启已就绪的远程服务，中间不发布 idle 完成态。 */
  restart(): Promise<void>
  /** 接管启用与停止阶段的远程退出；就绪后的致命退出交回整套停机。 */
  handleExit(exit: ChildExit): boolean
  /** 信任重启只能刷新同一代已启用或正在启用的 connector。 */
  restartConnector(start: () => void): Promise<void>
  /** 永久取消探测并等已有清理完成；整套停机随后由调用方执行。 */
  cancel(): Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 桌面按需远程生命周期；不持有 dsh、stdin、实例锁或信任 watcher。 */
export function createRemoteLifecycle(options: RemoteLifecycleOptions): RemoteLifecycle {
  let state: RemoteState = 'idle'
  let error: string | undefined
  let cancelled = false
  let generation = 0
  let abort: AbortController | undefined
  let attempted: string[] = []
  const stopping = new Map<string, Promise<boolean>>()
  let cleanup: Promise<void> | undefined
  let cancellation: Promise<void> | undefined
  let connectorRefresh: { generation: number; promise: Promise<void> } | undefined
  const current = (expected: number): boolean => !cancelled && generation === expected
  const starting = (expected: number): boolean => current(expected) && state === 'starting'
  const active = (expected: number): boolean => current(expected) && (state === 'starting' || state === 'ready')

  const stopOnce = async (name: string): Promise<boolean> => {
    const pending = stopping.get(name)
    if (pending !== undefined) return pending
    const stopped = Promise.resolve().then(() => options.stopChild(name))
    stopping.set(name, stopped)
    try {
      return await stopped
    } finally {
      stopping.delete(name)
    }
  }

  const fail = (cause: unknown, expected: number): Promise<void> => {
    if (!starting(expected)) return generation === expected ? cleanup ?? Promise.resolve() : Promise.resolve()
    state = 'failed'
    error = `启用远程服务失败：${errorMessage(cause)}`
    const children = attempted.toReversed()
    // 先认领清理，再通知；退出、关机与迟到探测不能重复回收。
    cleanup = Promise.resolve().then(async () => {
      for (const name of children) {
        try {
          // eslint-disable-next-line no-await-in-loop -- connector 先于 relay 停止。
          await stopOnce(name)
        } catch (stopError) {
          error = `${error}；停止 ${name} 失败：${errorMessage(stopError)}`
          if (current(expected)) options.onChange(state, error)
        }
      }
      return undefined
    })
    abort?.abort()
    options.onChange(state, error)
    return cleanup
  }

  const start = async (): Promise<void> => {
    const expected = ++generation
    const probe = new AbortController()
    abort = probe
    attempted = []
    cleanup = undefined
    state = 'starting'
    try {
      options.onChange(state)
      if (!starting(expected)) return
      attempted.push(RELAY_CHILD)
      options.startRelay()
      if (!starting(expected)) return
      attempted.push(CONNECTOR_CHILD)
      options.startConnector()
      if (!starting(expected)) return
      await options.waitForReady(probe.signal)
      if (!starting(expected)) return
      state = 'ready'
      options.onChange(state)
    } catch (cause) {
      await fail(cause, expected)
    }
  }

  const stop = (restart: boolean): Promise<void> => {
    if (cancelled || state !== 'ready') return Promise.resolve()
    const expected = ++generation
    state = 'stopping'
    cleanup = Promise.resolve().then(async () => {
      for (const name of [CONNECTOR_CHILD, RELAY_CHILD]) {
        try {
          // eslint-disable-next-line no-await-in-loop -- 先停止拨号，再回收 relay。
          await stopOnce(name)
        } catch (cause) {
          const message = `停止 ${name} 失败：${errorMessage(cause)}`
          error = error === undefined ? `停止远程服务失败：${message}` : `${error}；${message}`
        }
      }
      return undefined
    })
    abort?.abort()
    options.onChange(state)
    return cleanup.then(async () => {
      if (!current(expected)) return undefined
      if (error !== undefined) {
        state = 'failed'
        options.onChange(state, error)
      } else if (restart) {
        return start()
      } else {
        state = 'idle'
        options.onChange(state)
      }
      return undefined
    })
  }

  return {
    get state() { return state },
    get error() { return error },
    start() {
      return !cancelled && state === 'idle' ? start() : Promise.resolve()
    },
    stop: () => stop(false),
    restart: () => stop(true),
    handleExit(exit) {
      if (cancelled || (exit.name !== RELAY_CHILD && exit.name !== CONNECTOR_CHILD)) return false
      // 停止中的另一子进程可能先自行退出，不能升级为整套停机。
      if (state === 'failed' || state === 'stopping') return true
      if (!starting(generation)) return false
      const how = exit.signal === null ? `退出码 ${String(exit.code ?? '未知')}` : `收到信号 ${exit.signal}`
      // 只提取已知错误分类，不把可能带凭据的子进程日志透传给界面。
      const reason = exit.recent.some(line => line.includes('EADDRINUSE'))
        ? `${exit.name} 端口已被占用（EADDRINUSE）`
        : `${exit.name} 意外退出（${how}）`
      void fail(new Error(reason), generation)
      return true
    },
    async restartConnector(startConnector) {
      const expected = generation
      if (!active(expected)) return
      if (connectorRefresh?.generation === expected) return connectorRefresh.promise
      const refresh = (async () => {
        try {
          await stopOnce(CONNECTOR_CHILD)
          // 清理或新一代可能在 await 期间开始，不能补回旧 connector。
          if (active(expected)) startConnector()
        } catch (cause) {
          if (!active(expected)) return
          if (!starting(expected)) throw cause
          await fail(cause, expected)
        }
      })()
      connectorRefresh = { generation: expected, promise: refresh }
      try {
        await refresh
      } finally {
        if (connectorRefresh?.promise === refresh) connectorRefresh = undefined
      }
    },
    cancel() {
      cancelled = true
      abort?.abort()
      // 信任刷新可能已在按名停止 connector，整套停机不能与它重复回收。
      cancellation ??= cleanup ?? Promise.allSettled(stopping.values()).then(() => undefined)
      return cancellation
    },
  }
}
