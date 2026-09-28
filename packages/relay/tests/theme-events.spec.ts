/* eslint-disable no-await-in-loop -- 按顺序建立连接和回收资源，保证上限与关闭断言可重复。 */
import { createHash } from 'node:crypto'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import http, { type IncomingMessage, type OutgoingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeTheme } from '../src/admin/native-theme.js'
import { ThemeEvents, THEME_STREAM_HEARTBEAT_MS, THEME_STREAM_LEASE_MS, trustedThemeRequest } from '../src/admin/theme-events.js'
import { ADMIN_THEME_EVENTS_PATH, ADMIN_THEME_SCRIPT } from '../src/admin/theme-client.js'
import { ADMIN_CSP, PAGE_CSP } from '../src/admin/shared.js'
import type { AdminConsoleSession } from '../src/admin/console-app.js'
import { BrowserCookiePolicy, hashOpaqueToken, openRelayStore, resolveRelayConfig } from '../src/index.js'
import {
  closeFixtures, httpRequest, registerTestDevice, startAuthenticatedRelayFixture, startRelayFixture,
  type AuthenticatedRelayTestFixture, type RelayTestFixture,
} from './helpers.js'

const HOST = 'pc1.dsh.test'
const ORIGIN = `https://${HOST}`
const fixtures: RelayTestFixture[] = []
const cleanups: (() => void | Promise<void>)[] = []
const homes: string[] = []

function temporaryHome() {
  const home = mkdtempSync(join(tmpdir(), 'theme-events-'))
  homes.push(home)
  return home
}

function project(home: string, preference: string) {
  const path = join(home, 'theme.tmp')
  writeFileSync(path, JSON.stringify({ version: 1, preference }))
  renameSync(path, join(home, 'dsh-theme.json'))
}

async function fixture(theme = 'dark') {
  const home = temporaryHome()
  project(home, theme)
  const result = await startAuthenticatedRelayFixture({
    jwtSecret: new Uint8Array(32).fill(0x71),
    account: { kind: 'existing-user', input: {
      username: 'theme-admin', passwordHash: 'test-hash', totpSecret: 'test-secret', totpEnabled: true,
    } },
    relay: { home },
  })
  fixtures.push(result)
  return result
}

function requestHeaders(relay: AuthenticatedRelayTestFixture): OutgoingHttpHeaders {
  return { host: HOST, origin: ORIGIN, cookie: relay.sessionCookie, accept: 'application/x-ndjson' }
}

/** 响应头抵达即返回，不等待有意保持打开的 NDJSON 流结束。 */
function openStream(port: number, headers: OutgoingHttpHeaders, path = ADMIN_THEME_EVENTS_PATH, method = 'GET') {
  return new Promise<{
    response: IncomingMessage
    chunks: string[]
    lines: string[]
    ended: () => boolean
    close: () => void
  }>((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, method, headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)), agent: false }, (response) => {
      const chunks: string[] = []
      const lines: string[] = []
      let pending = ''
      let ended = false
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        chunks.push(chunk)
        pending += chunk
        let newline: number
        while ((newline = pending.indexOf('\n')) !== -1) {
          lines.push(pending.slice(0, newline))
          pending = pending.slice(newline + 1)
        }
      })
      response.on('end', () => { ended = true })
      response.on('close', () => { ended = true })
      response.on('error', () => { ended = true })
      const close = () => { response.destroy(); request.destroy() }
      cleanups.push(close)
      resolve({ response, chunks, lines, ended: () => ended, close })
    })
    request.setTimeout(3_000, () => request.destroy(new Error('theme test request timed out')))
    request.on('error', reject)
    request.end()
  })
}

const frame = (preference: string) => JSON.stringify({ version: 1, preference })

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
  await closeFixtures(fixtures)
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('authenticated relay theme stream', () => {
  it('sends a bounded initial snapshot and updates independent clients without CORS or cookies', async () => {
    const relay = await fixture()
    const first = await openStream(relay.port, requestHeaders(relay))
    const second = await openStream(relay.port, { ...requestHeaders(relay), origin: undefined,
      'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin' })
    for (const stream of [first, second]) {
      expect(stream.response.statusCode).toBe(200)
      expect(stream.response.headers).toMatchObject({
        'content-type': 'application/x-ndjson', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'referrer-policy': 'same-origin',
      })
      expect(stream.response.headers['access-control-allow-origin']).toBeUndefined()
      expect(stream.response.headers['set-cookie']).toBeUndefined()
      await vi.waitFor(() => expect(stream.lines).toEqual([frame('dark')]))
    }
    project(relay.relay.config.home, 'light')
    await vi.waitFor(() => expect(first.lines).toEqual([frame('dark'), frame('light')]))
    await vi.waitFor(() => expect(second.lines).toEqual(first.lines))
    project(relay.relay.config.home, 'light')
    await delay(80)
    expect(first.lines).toHaveLength(2)
    expect(first.ended()).toBe(false)
    expect(relay.relay.tunnel.registry.machines()).toHaveLength(0)
  })

  it.each([
    [{ origin: 'https://evil.example' }, 403],
    [{ origin: 'https://pc2.dsh.test' }, 403],
    [{ origin: 'http://pc1.dsh.test' }, 403],
    [{ origin: `${ORIGIN}:444` }, 403],
    [{ origin: 'null' }, 403],
    [{ 'sec-fetch-site': 'cross-site' }, 403],
    [{ 'sec-fetch-site': 'same-site' }, 403],
    [{ origin: undefined }, 403],
    [{ origin: undefined, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }, 403],
    [{ accept: '*/*' }, 406],
    [{ accept: 'application/x-ndjson, text/plain' }, 406],
    [{ host: 'evil.example', origin: 'https://evil.example' }, 403],
    [{ host: 'pc1.dsh.test/path', origin: ORIGIN }, 403],
    [{ host: 'user@pc1.dsh.test', origin: ORIGIN }, 403],
  ] as const)('rejects unsafe request headers %# after authentication', async (override, status) => {
    const relay = await fixture()
    const result = await openStream(relay.port, { ...requestHeaders(relay), ...override })
    expect(result.response.statusCode).toBe(status)
    await vi.waitFor(() => expect(result.ended()).toBe(true))
    expect(result.chunks.join('')).toBe('')
    expect(result.response.headers['cache-control']).toBe('no-store')
  })

  it('requires authentication for a domain Host even on loopback and never redirects streams to login', async () => {
    const relay = await fixture()
    for (const cookie of [undefined, 'invalid-session']) {
      const result = await openStream(relay.port, { ...requestHeaders(relay), cookie, 'x-forwarded-for': '127.0.0.1' })
      expect(result.response.statusCode).toBe(401)
      expect(result.response.headers.location).toBeUndefined()
    }
    const localHost = `127.0.0.1:${relay.port}`
    const local = await openStream(relay.port, { host: localHost, origin: `http://${localHost}`, accept: 'application/x-ndjson' })
    expect(local.response.statusCode).toBe(200)
    const wrongPort = await openStream(relay.port, { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1', accept: 'application/x-ndjson' })
    expect(wrongPort.response.statusCode).toBe(403)
  })

  it('requires both socket and Host for loopback exemption', () => {
    const config = resolveRelayConfig({ publicDomain: 'dsh.test', home: temporaryHome() })
    for (const remoteAddress of ['192.168.1.8', '203.0.113.8']) {
      const request = { headers: { host: '127.0.0.1:30809', origin: 'http://127.0.0.1:30809' },
        socket: { remoteAddress, localPort: 30809 } } as IncomingMessage
      expect(trustedThemeRequest(request, config)).toBe(false)
    }
  })

  it.each([
    ['POST', ADMIN_THEME_EVENTS_PATH], ['HEAD', ADMIN_THEME_EVENTS_PATH],
    ['GET', `${ADMIN_THEME_EVENTS_PATH}?`], ['GET', `${ADMIN_THEME_EVENTS_PATH}?theme=light`],
  ])('refuses %s %s without mutation', async (method, path) => {
    const relay = await fixture()
    const result = await openStream(relay.port, requestHeaders(relay), path, method)
    expect(result.response.statusCode).toBe(405)
  })

  it('limits one viewer to eight connections and releases capacity after disconnect', async () => {
    const relay = await fixture()
    const streams: Awaited<ReturnType<typeof openStream>>[] = []
    for (let index = 0; index < 8; index++) streams.push(await openStream(relay.port, requestHeaders(relay)))
    expect(streams.map(stream => stream.response.statusCode)).toEqual(Array(8).fill(200))
    expect((await openStream(relay.port, requestHeaders(relay))).response.statusCode).toBe(429)
    streams[0]?.close()
    await delay(80)
    expect((await openStream(relay.port, requestHeaders(relay))).response.statusCode).toBe(200)
  })

  it.each(['revoked', 'disabled', 'totp-reset'] as const)('rechecks %s authorization before sending changed preferences', async (reason) => {
    const relay = await fixture()
    const stream = await openStream(relay.port, requestHeaders(relay))
    await vi.waitFor(() => expect(stream.lines).toEqual([frame('dark')]))
    if (reason === 'revoked') relay.store.revokeUserSessions(relay.userId)
    if (reason === 'disabled') relay.store.disableUser(relay.userId)
    if (reason === 'totp-reset') relay.store.updateUserTotp({ userId: relay.userId, secret: null, enabled: false })
    project(relay.relay.config.home, 'light')
    await vi.waitFor(() => expect(stream.ended()).toBe(true))
    expect(stream.lines).toEqual([frame('dark')])
    expect((await openStream(relay.port, requestHeaders(relay))).response.statusCode).toBe(401)
  })

  it('closes existing streams when the real relay shuts down', async () => {
    const relay = await fixture()
    const stream = await openStream(relay.port, requestHeaders(relay))
    await closeFixtures(fixtures)
    await vi.waitFor(() => expect(stream.ended()).toBe(true))
  })
})

/** 独立 HTTP listener 只注入测试租期和已认证会话，不绕过实际流实现。 */
async function eventServer(leaseMs = 10_000, heartbeatMs = 5_000) {
  const home = temporaryHome()
  project(home, 'dark')
  const source = new NativeTheme(home, pino({ level: 'silent' }))
  source.start()
  const store = openRelayStore({ path: ':memory:' })
  const config = resolveRelayConfig({ publicDomain: 'dsh.test', home })
  const events = new ThemeEvents(source, store, config, leaseMs, heartbeatMs)
  const sessions = new Map<string, AdminConsoleSession>()
  const server = http.createServer((req, res) => {
    const session = sessions.get(String(req.headers['x-test-viewer']))
    if (session === undefined) { res.writeHead(401); res.end(); return }
    events.handle(req, res, session)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing test address')
  cleanups.push(async () => {
    events.close()
    source.close()
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    store.close()
  })
  function viewer(id: string, lifetime = 60_000) {
    const user = store.createUser({ id, username: id, passwordHash: 'test', totpEnabled: true, totpSecret: 'test' })
    const session = store.createSession({ userId: user.id, refreshTokenHash: hashOpaqueToken(id), expiresAt: Date.now() + lifetime })
    sessions.set(id, { userId: user.id, username: id, sessionId: session.id, setCookieHeaders: [] })
    return { host: HOST, origin: ORIGIN, accept: 'application/x-ndjson', 'x-test-viewer': id }
  }
  return { port: address.port, viewer, events, store, sessions, home }
}

describe('theme stream resource bounds', () => {
  it('keeps production deadlines at five minutes and 25 seconds', () => {
    expect(THEME_STREAM_LEASE_MS).toBe(300_000)
    expect(THEME_STREAM_HEARTBEAT_MS).toBe(25_000)
  })

  it('caps all viewers at 32, releases subscriptions and rejects new streams after close', async () => {
    const server = await eventServer()
    const streams: Awaited<ReturnType<typeof openStream>>[] = []
    for (let viewer = 0; viewer < 4; viewer++) {
      const headers = server.viewer(`viewer-${viewer}`)
      for (let index = 0; index < 8; index++) streams.push(await openStream(server.port, headers))
    }
    expect(streams.every(stream => stream.response.statusCode === 200)).toBe(true)
    const spare = server.viewer('spare')
    expect((await openStream(server.port, spare)).response.statusCode).toBe(429)
    server.events.close()
    await vi.waitFor(() => expect(streams.every(stream => stream.ended())).toBe(true))
    expect((await openStream(server.port, spare)).response.statusCode).toBe(503)
  })

  it('sends blank heartbeats, expires its lease, then permits a fresh snapshot', async () => {
    const server = await eventServer(250, 40)
    const headers = server.viewer('lease')
    const stream = await openStream(server.port, headers)
    await vi.waitFor(() => expect(stream.ended()).toBe(true))
    expect(stream.lines[0]).toBe(frame('dark'))
    expect(stream.lines.length).toBeGreaterThan(1)
    expect(stream.lines.slice(1).every(line => line === '')).toBe(true)
    project(server.home, 'light')
    await delay(80)
    const renewed = await openStream(server.port, headers)
    await vi.waitFor(() => expect(renewed.lines[0]).toBe(frame('light')))
  })

  it.each(['revoked', 'expired', 'disabled'] as const)('closes idle %s sessions before the next heartbeat', async (reason) => {
    const server = await eventServer(2_000, 80)
    const headers = server.viewer('idle', reason === 'expired' ? 120 : 60_000)
    const stream = await openStream(server.port, headers)
    await vi.waitFor(() => expect(stream.lines[0]).toBe(frame('dark')))
    if (reason === 'revoked') server.store.revokeUserSessions('idle')
    if (reason === 'disabled') server.store.disableUser('idle')
    await vi.waitFor(() => expect(stream.ended()).toBe(true))
    expect(stream.lines.filter(Boolean)).toEqual([frame('dark')])
    expect((await openStream(server.port, headers)).response.statusCode).toBe(401)
  })
})

describe('management first paint and script policy', () => {
  it.each(['light', 'dark', 'system'])('renders all management pages from native %s, not the opposite cookie', async (theme) => {
    const relay = await fixture(theme)
    registerTestDevice(relay.store, { machineId: 'test-machine', slug: 'pc2' })
    const cookies = new BrowserCookiePolicy({ mode: 'domain-https', domain: 'dsh.test' })
    const hash = createHash('sha256').update(ADMIN_THEME_SCRIPT).digest('base64')
    expect(ADMIN_CSP).toBe(`${PAGE_CSP}; script-src 'sha256-${hash}'; connect-src 'self'`)
    for (const path of ['/_admin', '/_admin/hub', '/_admin/account', '/_admin/devices/revoke?machineId=test-machine']) {
      const result = await httpRequest({ port: relay.port, path,
        headers: { host: HOST, cookie: `${relay.sessionCookie}; ${cookies.names.theme}=${theme === 'dark' ? 'light' : 'dark'}` } })
      expect(result.status, path).toBe(200)
      expect(result.body).toContain(`data-theme="${theme}"`)
      expect(result.body).not.toContain('aria-label="外观"')
      expect(result.body).not.toContain('/_theme?value=')
      expect([...result.body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)].map(match => match[1])).toEqual([ADMIN_THEME_SCRIPT])
      expect(result.headers['content-security-policy']).toBe(ADMIN_CSP)
      expect(result.headers['cache-control']).toBe('no-store')
      expect(ADMIN_CSP).not.toContain("script-src 'unsafe-inline'")
    }
  })

  it('leaves login and first setup cookie-driven and script-free', async () => {
    const relay = await fixture('dark')
    const login = await httpRequest({ port: relay.port, path: '/_auth/login', headers: {
      host: HOST, cookie: '__Secure-dsh_theme=light',
    } })
    const home = temporaryHome()
    project(home, 'dark')
    const setupRelay = await startRelayFixture({ jwtSecret: new Uint8Array(32).fill(0x72), relay: {
      home, publicDomain: 'dsh.test', browserAuth: { cookieMode: 'domain-https' },
    } })
    fixtures.push(setupRelay)
    const setup = await httpRequest({ port: setupRelay.port, path: '/_setup', headers: {
      host: `127.0.0.1:${setupRelay.port}`, cookie: 'dsh_theme=light',
    } })
    for (const page of [login, setup]) {
      expect(page.status).toBe(200)
      expect(page.body).toContain('data-theme="light"')
      expect(page.body).toContain('/_theme?value=dark')
      expect(page.body).not.toContain('<script')
      expect(page.headers['content-security-policy']).toBe(PAGE_CSP)
    }
  })
})
