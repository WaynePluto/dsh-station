/* eslint-disable no-await-in-loop -- 按时间顺序推进同一客户端的退避状态，不能并行推进定时器。 */
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_THEME_EVENTS_PATH, ADMIN_THEME_SCRIPT } from '../src/admin/theme-client.js'

function streamResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value },
    cancel,
  })
  return {
    response: { status: 200, ok: true, body, headers: new Headers({ 'content-type': 'application/x-ndjson' }) },
    push: (text: string | Uint8Array) => controller.enqueue(typeof text === 'string' ? new TextEncoder().encode(text) : text),
    end: () => controller.close(),
    fail: () => controller.error(new Error('network disconnected')),
    cancel,
  }
}

function startClient(fetch: ReturnType<typeof vi.fn>) {
  vi.useFakeTimers()
  const listeners = new Map<string, (event: { persisted: boolean }) => void>()
  const writes: string[] = []
  let theme = 'system'
  const dataset = Object.defineProperty({}, 'theme', {
    get: () => theme,
    set: (value: string) => { theme = value; writes.push(value) },
  })
  const cookieWrite = vi.fn()
  const document = { documentElement: { dataset } }
  Object.defineProperty(document, 'cookie', { get: () => 'original-cookie', set: cookieWrite })
  const location = { reload: vi.fn(), assign: vi.fn(), replace: vi.fn() }
  runInNewContext(ADMIN_THEME_SCRIPT, {
    fetch, document, location, AbortController, TextDecoder, setTimeout, clearTimeout,
    window: {
      fetch, AbortController, TextDecoder,
      addEventListener: (name: string, listener: (event: { persisted: boolean }) => void) => listeners.set(name, listener),
    },
  })
  return {
    theme: () => theme, writes, cookieWrite, location,
    hide: () => listeners.get('pagehide')?.({ persisted: false }),
    show: (persisted = true) => listeners.get('pageshow')?.({ persisted }),
  }
}

const frame = (preference: string) => `${JSON.stringify({ version: 1, preference })}\n`
const flush = () => vi.advanceTimersByTimeAsync(0)

afterEach(() => vi.useRealTimers())

describe('fixed management theme client', () => {
  it('parses split and combined frames, ignores heartbeats and duplicate themes without touching settings', async () => {
    const stream = streamResponse()
    const fetch = vi.fn().mockResolvedValue(stream.response)
    const client = startClient(fetch)
    await flush()
    const raw = frame('dark')
    for (const character of raw) stream.push(character)
    stream.push(`\n${frame('dark')}${frame('light')}${frame('system')}\n`)
    await flush()
    expect(client.writes).toEqual(['dark', 'light', 'system'])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(ADMIN_THEME_EVENTS_PATH, expect.objectContaining({
      method: 'GET', mode: 'same-origin', credentials: 'same-origin', redirect: 'error',
      cache: 'no-store', headers: { Accept: 'application/x-ndjson' },
    }))
    expect(client.cookieWrite).not.toHaveBeenCalled()
    for (const action of Object.values(client.location)) expect(action).not.toHaveBeenCalled()
    client.hide()
    stream.end()
    await flush()
  })

  it.each([
    '{broken}\n', frame('sepia'), '{"version":2,"preference":"light"}\n',
    '{"version":1,"preference":"light","extra":1}\n', 'null\n', '[]\n',
    'x'.repeat(129),
  ])('cancels invalid input %# while preserving the last valid preference', async (invalid) => {
    const stream = streamResponse()
    const fetch = vi.fn().mockResolvedValue(stream.response)
    const client = startClient(fetch)
    await flush()
    stream.push(frame('dark'))
    await flush()
    stream.push(invalid)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.theme()).toBe('dark')
    expect(client.writes).toEqual(['dark'])
    expect(stream.cancel).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops on malformed UTF-8 and retains the last preference', async () => {
    const stream = streamResponse()
    const fetch = vi.fn().mockResolvedValue(stream.response)
    const client = startClient(fetch)
    await flush()
    stream.push(frame('dark'))
    await flush()
    stream.push(Buffer.from([0xff, 0x0a]))
    await flush()
    expect(client.theme()).toBe('dark')
    expect(stream.cancel).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    client.hide()
  })

  it('allows a 128-character frame and never applies an unterminated partial frame', async () => {
    const stream = streamResponse()
    const fetch = vi.fn().mockResolvedValue(stream.response)
    const client = startClient(fetch)
    await flush()
    stream.push(frame('dark').trimEnd().padEnd(128, ' ') + '\n')
    stream.push(frame('light').trimEnd())
    stream.end()
    await flush()
    expect(client.theme()).toBe('dark')
    client.hide()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 404])('stops reconnecting after HTTP %i', async (status) => {
    const fetch = vi.fn().mockResolvedValue({ status, ok: false })
    startClient(fetch)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reconnects with bounded exponential backoff and resets it after valid data', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('offline'))
    const client = startClient(fetch)
    await flush()
    for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 30000, 30000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(fetch).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetch).toHaveBeenCalledTimes(index + 2)
    }
    const stream = streamResponse()
    fetch.mockResolvedValue(stream.response)
    await vi.advanceTimersByTimeAsync(30_000)
    stream.push(frame('light'))
    stream.end()
    await flush()
    const count = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(999)
    expect(fetch).toHaveBeenCalledTimes(count)
    fetch.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(count + 1)
    client.hide()
  })

  it('aborts on pagehide, cancels retries, and resumes only persisted pageshow', async () => {
    const stream = streamResponse()
    const signals: AbortSignal[] = []
    const fetch = vi.fn((_url: string, options: RequestInit) => {
      const signal = options.signal as AbortSignal
      signals.push(signal)
      signal.addEventListener('abort', stream.fail, { once: true })
      return Promise.resolve(stream.response)
    })
    const client = startClient(fetch)
    await flush()
    client.hide()
    await flush()
    expect(signals[0]?.aborted).toBe(true)
    client.show(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockRejectedValue(new Error('offline'))
    client.show()
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    client.hide()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a stalled connection lifetime and then reconnects without changing the last theme', async () => {
    const stream = streamResponse()
    const signals: AbortSignal[] = []
    const fetch = vi.fn((_url: string, options: RequestInit) => {
      const signal = options.signal as AbortSignal
      signals.push(signal)
      signal.addEventListener('abort', stream.fail, { once: true })
      return Promise.resolve(stream.response)
    })
    const client = startClient(fetch)
    await flush()
    stream.push(frame('dark'))
    await flush()
    await vi.advanceTimersByTimeAsync(360_000)
    expect(signals[0]?.aborted).toBe(true)
    expect(client.theme()).toBe('dark')
    fetch.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    client.hide()
  })

  it('does not overlap an open reader even when pageshow fires repeatedly', async () => {
    const stream = streamResponse()
    const fetch = vi.fn().mockResolvedValue(stream.response)
    const client = startClient(fetch)
    await flush()
    client.show()
    client.show()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    client.hide()
    stream.end()
    await flush()
  })
})
