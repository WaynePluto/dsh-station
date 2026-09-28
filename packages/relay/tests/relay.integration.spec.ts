import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { Buffer } from 'node:buffer'
import pino from 'pino'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  TUNNEL_CONTROL_PATH,
  decodeControlFrame,
  deviceChallengeMessage,
  type RelayToConnectorFrame,
} from '@dsh-station/protocol'
import {
  ACCESS_TOKEN_TTL_MS,
  BrowserCookiePolicy,
  createAuthenticationService,
  createRelayServer,
  openRelayStore,
  type AuthenticationService,
  type RelayServer,
  type RelayStore,
} from '../src/index.js'
import {
  MockConnector,
  createDeviceIdentity,
  httpRequest as request,
  issueEnrollToken,
} from './helpers.js'

const MACHINE_ID = 'machine-test-01'
const MACHINE_SLUG = 'pc1'
/** 代替 dsh 启动时打印的 token。 */
const DSH_TOKEN = 'dsh-test-token-0123456789'

interface Fixture {
  relay: RelayServer
  relayPort: number
  upstream: http.Server
  upstreamWss: WebSocketServer
  connector: MockConnector
  store: RelayStore
  authentication: AuthenticationService
  cookiePolicy: BrowserCookiePolicy
  browserCookie: string
}

const fixtures: Fixture[] = []

async function startFixture(): Promise<Fixture> {
  const upstreamWss = new WebSocketServer({ noServer: true })
  upstreamWss.on('connection', (ws) => ws.on('message', data => ws.send(data)))

  const upstream = http.createServer((req, res) => {
    // dsh 0.1.2 的替身：没有 dsh 自身 cookie 的 index 请求是
    // 裸 401，与 relay 对浏览器已经作出的决定无关。
    const path = req.url ?? '/'
    if ((path === '/' || path.startsWith('/?')) && !(req.headers.cookie ?? '').includes('dsh-auth')) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.stringify({
        method: req.method,
        path: req.url,
        host: req.headers.host,
        origin: req.headers.origin,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    })
  })
  upstream.on('upgrade', (req, socket, head) => upstreamWss.handleUpgrade(req, socket, head, ws => upstreamWss.emit('connection', ws, req)))
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const upstreamAddress = upstream.address()
  if (upstreamAddress === null || typeof upstreamAddress === 'string') throw new Error('missing upstream address')

  const store = openRelayStore({ path: ':memory:' })
  const user = store.createUser({
    id: 'relay-test-user',
    username: 'admin',
    passwordHash: 'test-password-hash',
    totpSecret: 'test-totp-secret',
    totpEnabled: true,
  })
  const authentication = await createAuthenticationService({
    store,
    jwtSecret: new Uint8Array(32).fill(0x42),
  })
  const tokens = await authentication.sessions.issue({
    user,
    sourceIp: '127.0.0.1',
  })
  const cookiePolicy = new BrowserCookiePolicy({ mode: 'domain-https', domain: 'dsh.test' })
  const browserCookie = cookiePolicy.sessionHeaders(tokens)
    .map(header => header.split(';', 1)[0])
    .join('; ')

  const relay = createRelayServer({
    home: mkdtempSync(join(tmpdir(), 'relay-integration-')),
    host: '127.0.0.1',
    port: 0,
    publicDomain: 'dsh.test',
    publicScheme: 'https',
    streamConnectTimeoutMs: 2_000,
    browserAuth: { cookieMode: 'domain-https' },
  }, {
    logger: pino({ level: process.env.RELAY_TEST_LOG ?? 'silent' }),
    authentication,
    store,
  })
  const relayAddress = await relay.listen()
  const connector = new MockConnector({
    relayPort: relayAddress.port,
    upstreamPort: upstreamAddress.port,
    identity: createDeviceIdentity(),
    enrollToken: issueEnrollToken(store, MACHINE_SLUG),
    machineId: MACHINE_ID,
    slug: MACHINE_SLUG,
    dshToken: DSH_TOKEN,
  })
  await connector.ready()

  const fixture = {
    relay,
    relayPort: relayAddress.port,
    upstream,
    upstreamWss,
    connector,
    store,
    authentication,
    cookiePolicy,
    browserCookie,
  }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    fixture.connector.close()
    await fixture.relay.close()
    rmSync(fixture.relay.config.home, { recursive: true, force: true })
    fixture.store.close()
    fixture.upstreamWss.close()
    await new Promise<void>(resolve => fixture.upstream.close(() => resolve()))
  }))
})

describe('M1 relay', () => {
  it('authenticates a connector and forwards HTTP body with mode-A headers intact', async () => {
    const fixture = await startFixture()
    const result = await request({
      port: fixture.relayPort,
      path: '/api/example',
      method: 'POST',
      headers: {
        host: 'pc1.dsh.test',
        origin: 'https://pc1.dsh.test',
        cookie: fixture.browserCookie,
        'content-type': 'text/plain',
      },
      body: 'hello tunnel',
    })

    expect(result.status, result.body).toBe(200)
    expect(JSON.parse(result.body)).toMatchObject({
      method: 'POST',
      path: '/api/example',
      host: 'pc1.dsh.test',
      origin: 'https://pc1.dsh.test',
      body: 'hello tunnel',
    })
    expect(fixture.connector.openStreamCount).toBe(1)
  })

  it('sends an authenticated browser through dsh\'s own login exchange exactly once', async () => {
    const fixture = await startFixture()
    const headers = {
      host: 'pc1.dsh.test',
      origin: 'https://pc1.dsh.test',
      cookie: fixture.browserCookie,
    }
    const first = await request({ port: fixture.relayPort, path: '/', headers })
    // 已携带令牌的请求必须原样通过 401，
    // 而不是再次重定向，否则被拒绝的令牌会造成无限循环。
    const retry = await request({
      port: fixture.relayPort,
      path: `/?token=${DSH_TOKEN}`,
      headers,
    })
    const api = await request({ port: fixture.relayPort, path: '/api/session.list', headers })

    expect(first.status).toBe(303)
    expect(first.headers.location).toBe(`/?token=${DSH_TOKEN}`)
    expect(first.headers['referrer-policy']).toBe('no-referrer')
    expect(retry.status).toBe(401)
    expect(api.status).toBe(200)
  })

  it('rejects bad Origin and cross-site requests before allocating a stream', async () => {
    const fixture = await startFixture()
    const badOrigin = await request({
      port: fixture.relayPort,
      path: '/api/session.list',
      headers: {
        host: 'pc1.dsh.test',
        origin: 'https://evil.example',
        cookie: fixture.browserCookie,
      },
    })
    const crossSite = await request({
      port: fixture.relayPort,
      path: '/api/session.list',
      headers: {
        host: 'pc1.dsh.test',
        origin: 'https://pc1.dsh.test',
        cookie: fixture.browserCookie,
        'sec-fetch-site': 'cross-site',
      },
    })

    expect(badOrigin.status).toBe(403)
    expect(crossSite.status).toBe(403)
    expect(fixture.connector.openStreamCount).toBe(0)
  })

  it('forwards browser WebSocket upgrades over independent data streams', async () => {
    const fixture = await startFixture()
    const browser = new WebSocket(`ws://127.0.0.1:${fixture.relayPort}/api/remote.mux`, {
      headers: {
        host: 'pc1.dsh.test',
        origin: 'https://pc1.dsh.test',
        cookie: fixture.browserCookie,
      },
    })
    await once(browser, 'open')
    browser.send('through tunnel')
    const [message] = await once(browser, 'message')
    expect(message.toString()).toBe('through tunnel')
    browser.close()
    expect(fixture.connector.openStreamCount).toBe(1)
  })

  it('rotates an expired access cookie during a WebSocket upgrade', async () => {
    const fixture = await startFixture()
    const user = fixture.store.getUserById('relay-test-user')
    if (user === undefined) throw new Error('test user is missing')
    const expired = await fixture.authentication.sessions.issue({
      user,
      sourceIp: '127.0.0.1',
      now: Date.now() - ACCESS_TOKEN_TTL_MS - 1_000,
    })
    const browser = new WebSocket(`ws://127.0.0.1:${fixture.relayPort}/api/remote.mux?generation=2`, {
      headers: {
        host: 'pc1.dsh.test',
        origin: 'https://pc1.dsh.test',
        cookie: fixture.cookiePolicy.sessionHeaders(expired, Date.now() - ACCESS_TOKEN_TTL_MS - 1_000)
          .map(header => header.split(';', 1)[0])
          .join('; '),
      },
    })
    const upgrade = once(browser, 'upgrade')
    await once(browser, 'open')
    const [response] = await upgrade
    expect((response as http.IncomingMessage).headers['set-cookie']).toHaveLength(2)
    browser.close()
  })

  it('returns a fatal auth error for a device that was never enrolled', async () => {
    const fixture = await startFixture()
    const stranger = createDeviceIdentity()
    const wrong = new WebSocket(`ws://127.0.0.1:${fixture.relayPort}${TUNNEL_CONTROL_PATH}`)
    const received: RelayToConnectorFrame[] = []
    wrong.on('message', (data) => {
      const frame = decodeControlFrame(data as Buffer) as RelayToConnectorFrame
      received.push(frame)
      if (frame.type === 'challenge') {
        wrong.send(JSON.stringify({
          type: 'auth',
          version: PROTOCOL_VERSION,
          machineId: 'wrong-machine',
          nonce: frame.nonce,
          credential: {
            method: 'ed25519',
            publicKey: stranger.publicKey,
            signature: stranger.sign(deviceChallengeMessage({
              nonce: frame.nonce,
              machineId: 'wrong-machine',
              slug: 'wrong',
            })),
          },
        }))
      }
    })
    await once(wrong, 'open')
    wrong.send(JSON.stringify({
      type: 'hello',
      version: PROTOCOL_VERSION,
      machineId: 'wrong-machine',
      slug: 'wrong',
      connectorVersion: 'test',
    }))
    await once(wrong, 'close')
    expect(received).toContainEqual(expect.objectContaining({ type: 'error', code: 'AUTH_FAILED', fatal: true }))
  })
})
