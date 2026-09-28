import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

export const REMOTE_READY_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 1_000
const RETRY_INTERVAL_MS = 250

/** 只检查现有首页的响应头，不读取正文、Location 或交换 token。 */
function probe(port: number, timeoutMs: number, signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolvePromise, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      agent: false,
      maxHeaderSize: 16_384,
      signal,
    })
    // 使用墙钟上限，不能让持续发送零碎响应头的连接无限续期。
    const timer = setTimeout(() => req.destroy(new Error('首页请求超时')), timeoutMs)
    req.once('response', (response) => {
      clearTimeout(timer)
      // loopback 首页 200 来自 dsh；303 是 relay 在 dsh 首页 401 后代发的 token 交换。
      const status = response.statusCode
      resolvePromise(status === 200 || status === 303 ? undefined : `HTTP ${String(status)}`)
      response.destroy()
      req.destroy()
    })
    req.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (signal.aborted) reject(signal.reason)
      else resolvePromise(error.code === undefined ? error.message : `请求失败（${error.code}）`)
    })
    req.end()
  })
}

/** 等待本机 relay 经 connector 转发到 dsh；不等同于公网可达。 */
export async function waitForRemote(options: {
  readonly port: number
  readonly signal: AbortSignal
  readonly timeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly intervalMs?: number
}): Promise<void> {
  const timeoutMs = Math.min(options.timeoutMs ?? REMOTE_READY_TIMEOUT_MS, REMOTE_READY_TIMEOUT_MS)
  const deadline = performance.now() + timeoutMs
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? RETRY_INTERVAL_MS
  let lastFailure = '尚未收到首页响应'
  for (;;) {
    options.signal.throwIfAborted()
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      throw new Error(`本机 relay → connector → dsh 在 ${String(timeoutMs / 1000)} 秒内未就绪；最后结果：${lastFailure}`)
    }
    // eslint-disable-next-line no-await-in-loop -- 串行探测，上一请求完成后才重试。
    const failure = await probe(options.port, Math.min(requestTimeoutMs, remaining), options.signal)
    options.signal.throwIfAborted()
    if (failure === undefined && performance.now() < deadline) return
    lastFailure = failure ?? '首页响应超过就绪时限'
    const pause = Math.min(intervalMs, deadline - performance.now())
    if (pause > 0) {
      // eslint-disable-next-line no-await-in-loop -- 重试间隔也必须可取消。
      await delay(Math.ceil(pause), undefined, { signal: options.signal })
    }
  }
}
