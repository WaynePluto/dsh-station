import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { htmlHeaders, PAGE_CSP, renderSplashPage, SPLASH_CSP } from '../src/admin/shared.js'

function scriptOf(html: string): string {
  const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1]
  if (script === undefined) throw new Error('Missing splash script')
  return script
}

function startProbe(fetch: ReturnType<typeof vi.fn>) {
  vi.useFakeTimers()
  const reload = vi.fn()
  const listeners = new Map<string, () => void>()
  runInNewContext(scriptOf(renderSplashPage({ theme: 'system' })), {
    fetch,
    location: { href: 'http://127.0.0.1:31809/', reload },
    window: { addEventListener: (name: string, listener: () => void) => listeners.set(name, listener) },
    AbortController,
    setTimeout,
    clearTimeout,
  })
  return { reload, hide: () => listeners.get('pagehide')?.() }
}

function response(status: number, type = 'basic') {
  return { status, type, ok: status >= 200 && status < 300, body: { cancel: vi.fn().mockResolvedValue(undefined) } }
}

afterEach(() => vi.useRealTimers())

describe('local splash', () => {
  it('allows only its fixed script and same-origin probes without relaxing normal pages', () => {
    for (const theme of ['light', 'dark', 'system'] as const) {
      const html = renderSplashPage({ theme })
      const hash = createHash('sha256').update(scriptOf(html)).digest('base64')
      expect(SPLASH_CSP).toBe(`${PAGE_CSP}; script-src 'sha256-${hash}'; connect-src 'self'`)
      expect(html).toContain(`data-theme="${theme}"`)
      expect(html).toContain('animation:splash-spin 1s linear infinite')
      expect(html).toContain('@media(prefers-reduced-motion:reduce){.spin{animation:none}}')
      expect(html.replace(/<noscript>[\s\S]*?<\/noscript>/gu, '')).not.toContain('http-equiv="refresh"')
    }
    expect(htmlHeaders().get('content-security-policy')).toBe(PAGE_CSP)
    expect(PAGE_CSP).not.toContain('script-src')
  })

  it('keeps the document intact while offline and reloads once ready', async () => {
    const offline = response(502)
    const fetch = vi.fn().mockResolvedValue(offline)
    const { reload } = startProbe(fetch)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(reload).not.toHaveBeenCalled()
    expect(offline.body.cancel).toHaveBeenCalledTimes(6)
    expect(fetch).toHaveBeenLastCalledWith('http://127.0.0.1:31809/', expect.objectContaining({
      mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
      headers: { Accept: 'text/plain' },
    }))
    fetch.mockResolvedValue(response(200))
    await vi.advanceTimersByTimeAsync(2000)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(7)
  })

  it('hands opaque redirects to navigation without following or reading token URLs', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 0, type: 'opaqueredirect', ok: false, body: null })
    const { reload } = startProbe(fetch)
    await vi.advanceTimersByTimeAsync(1000)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 404])('lets navigation display terminal HTTP %i instead of hiding errors forever', async (status) => {
    const { reload } = startProbe(vi.fn().mockResolvedValue(response(status)))
    await vi.advanceTimersByTimeAsync(0)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it.each([429, 502, 503])('keeps waiting on transient HTTP %i', async (status) => {
    const fetch = vi.fn().mockResolvedValue(response(status))
    const { reload } = startProbe(fetch)
    await vi.advanceTimersByTimeAsync(200)
    expect(reload).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries network failures', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('network unavailable'))
    const { reload } = startProbe(fetch)
    await vi.advanceTimersByTimeAsync(200)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(reload).not.toHaveBeenCalled()
  })

  it('bounds hung requests, never overlaps probes, and aborts on pagehide', async () => {
    const signals: AbortSignal[] = []
    const fetch = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      const signal = options.signal as AbortSignal
      signals.push(signal)
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const { reload, hide } = startProbe(fetch)
    await vi.advanceTimersByTimeAsync(2999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(201)
    expect(signals[0]?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    hide()
    await vi.advanceTimersByTimeAsync(5000)
    expect(signals[1]?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(reload).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels queued retries when leaving the splash', async () => {
    const fetch = vi.fn().mockResolvedValue(response(502))
    const { hide } = startProbe(fetch)
    await vi.advanceTimersByTimeAsync(0)
    hide()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
