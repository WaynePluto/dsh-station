import { createServer, type Server, type RequestListener } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_READY_TIMEOUT_MS, waitForRemote } from '../src/remote-ready.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error === undefined ? resolve() : reject(error))
  })))
})

async function listen(handler: RequestListener): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing server address')
  return address.port
}

function wait(port: number, signal = new AbortController().signal, timeoutMs = 1_000): Promise<void> {
  return waitForRemote({ port, signal, timeoutMs, requestTimeoutMs: 100, intervalMs: 20 })
}

describe('remote readiness', () => {
  it('uses a 20 second production deadline', () => {
    expect(REMOTE_READY_TIMEOUT_MS).toBe(20_000)
  })

  it('waits through an offline relay until the forwarded homepage responds', async () => {
    let attempts = 0
    let active = 0
    let maxActive = 0
    const port = await listen((_req, res) => {
      attempts += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      res.once('close', () => { active -= 1 })
      setTimeout(() => res.writeHead(attempts < 3 ? 503 : 200).end(), 25)
    })
    await wait(port)
    expect(attempts).toBe(3)
    expect(maxActive).toBe(1)
  })

  it('accepts the token redirect without following it or sending credentials', async () => {
    const requests: { url: string | undefined; cookie: string | undefined; host: string | undefined }[] = []
    const port = await listen((req, res) => {
      requests.push({ url: req.url, cookie: req.headers.cookie, host: req.headers.host })
      res.writeHead(303, { location: '/?token=must-not-be-read-or-requested' }).end()
    })
    await wait(port)
    expect(requests).toEqual([{ url: '/', cookie: undefined, host: `127.0.0.1:${String(port)}` }])
  })

  it.each([302, 401, 403, 404, 500, 502, 503])('does not call HTTP %i ready', async (status) => {
    const port = await listen((_req, res) => res.writeHead(status, { location: '/?token=secret' }).end())
    await expect(waitForRemote({ port, signal: new AbortController().signal, timeoutMs: 200, intervalMs: 500 }))
      .rejects.toThrow(`HTTP ${String(status)}`)
  })

  it('reports connection failure rather than accepting a listening TCP socket', async () => {
    const port = await listen(req => req.socket.destroy())
    await expect(wait(port, undefined, 150)).rejects.toThrow('ECONNRESET')
  })

  it('bounds each stalled request and retries before the overall timeout', async () => {
    let attempts = 0
    const port = await listen(() => { attempts += 1 })
    await expect(wait(port, undefined, 300)).rejects.toThrow('未就绪')
    expect(attempts).toBeGreaterThanOrEqual(2)
  })

  it('caps the final request by the remaining overall budget', async () => {
    const port = await listen(() => undefined)
    const start = performance.now()
    await expect(waitForRemote({ port, signal: new AbortController().signal, timeoutMs: 100, requestTimeoutMs: 5_000 }))
      .rejects.toThrow('首页请求超时')
    expect(performance.now() - start).toBeLessThan(1_000)
  })

  it('does not consume or wait for the homepage response body', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200)
      res.flushHeaders()
    })
    await wait(port)
  })

  it('cancels an in-flight request promptly', async () => {
    const abort = new AbortController()
    let received = false
    let closed = false
    const port = await listen((req) => {
      received = true
      req.once('close', () => { closed = true })
    })
    const result = wait(port, abort.signal)
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(received).toBe(true))
    abort.abort()
    await assertion
    await vi.waitFor(() => expect(closed).toBe(true))
  })

  it('cancels the retry delay without issuing another request', async () => {
    const abort = new AbortController()
    let attempts = 0
    const port = await listen((_req, res) => {
      attempts += 1
      res.writeHead(503).end()
    })
    const result = waitForRemote({ port, signal: abort.signal, timeoutMs: 1_000, intervalMs: 500 })
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(attempts).toBe(1))
    abort.abort()
    await assertion
    expect(attempts).toBe(1)
  })

  it('does not request anything when already cancelled', async () => {
    let attempts = 0
    const port = await listen((_req, res) => { attempts += 1; res.end() })
    const abort = new AbortController()
    abort.abort()
    await expect(wait(port, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(attempts).toBe(0)
  })
})
