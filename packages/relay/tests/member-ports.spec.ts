import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { Buffer } from 'node:buffer'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { TUNNEL_CONTROL_PATH } from '@dsh-station/protocol'
import {
  BrowserCookiePolicy,
  createAuthenticationService,
  createRelayServer,
  openRelayStore,
  readCookie,
  type RelayServer,
  type RelayStore,
} from '../src/index.js'
import { ADMIN_PATH_PREFIX, ADMIN_REVOKE_PATH, ADMIN_TOKEN_CREATE_PATH } from '../src/admin/console-app.js'
import {
  MockConnector,
  cookieHeader,
  createDeviceIdentity,
  findFreePortBlock,
  httpRequest,
  issueEnrollToken,
  setCookieArray,
} from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x39)
/** 只会发送到 Host header；每个 socket 仍连接 loopback。 */
const LAN_IP = '10.1.2.87'
const HUB_SLUG = 'hub'
const HUB_MACHINE = 'machine-hub'
const MEMBER_SLUG = 'pc2'
const MEMBER_MACHINE = 'machine-pc2'
const MEMBER_PORT_COUNT = 4

interface Upstream {
  readonly server: http.Server
  readonly port: number
}

interface Fixture {
  relay: RelayServer
  store: RelayStore
  mainPort: number
  memberPort: number
  memberUpstream: Upstream
  connectors: MockConnector[]
  upstreams: Upstream[]
  sessionCookie: string
}

const fixtures: Fixture[] = []

/** 一台机器 dsh 的替身：用该机器的名称响应。 */
async function startUpstream(machine: string): Promise<Upstream> {
  const server = http.createServer((req, res) => {
    const body = JSON.stringify({ machine, host: req.headers.host, path: req.url })
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('upstream has no TCP address')
  return { server, port: address.port }
}

async function startFixture(): Promise<Fixture> {
  const memberPortBase = await findFreePortBlock(MEMBER_PORT_COUNT)
  const hubUpstream = await startUpstream(HUB_SLUG)
  const memberUpstream = await startUpstream(MEMBER_SLUG)

  const store = openRelayStore({ path: ':memory:' })
  const user = store.createUser({
    id: 'member-port-user',
    username: 'admin',
    passwordHash: 'test-password-hash',
    totpSecret: 'test-totp-secret',
    totpEnabled: true,
  })
  const authentication = await createAuthenticationService({ store, jwtSecret: JWT_SECRET })
  const tokens = await authentication.sessions.issue({ user, sourceIp: '127.0.0.1' })
  const sessionCookie = cookieHeader(new BrowserCookiePolicy({ mode: 'lan-http' }).sessionHeaders(tokens))

  const relay = createRelayServer({
    home: mkdtempSync(join(tmpdir(), 'relay-integration-')),
    host: '127.0.0.1',
    port: 0,
    directSlug: HUB_SLUG,
    memberPortBase,
    memberPortCount: MEMBER_PORT_COUNT,
    publicScheme: 'http',
    streamConnectTimeoutMs: 2_000,
    browserAuth: { cookieMode: 'lan-http' },
  }, { authentication, logger: pino({ level: process.env.RELAY_TEST_LOG ?? 'silent' }), store })
  const address = await relay.listen()

  const connectors = [
    new MockConnector({
      relayPort: address.port,
      upstreamPort: hubUpstream.port,
      identity: createDeviceIdentity(),
      enrollToken: issueEnrollToken(store, HUB_SLUG),
      machineId: HUB_MACHINE,
      slug: HUB_SLUG,
    }),
    new MockConnector({
      relayPort: address.port,
      upstreamPort: memberUpstream.port,
      identity: createDeviceIdentity(),
      enrollToken: issueEnrollToken(store, MEMBER_SLUG),
      machineId: MEMBER_MACHINE,
      slug: MEMBER_SLUG,
    }),
  ]
  await Promise.all(connectors.map(async connector => connector.ready()))
  // 注册会在后台打开端口；等待排队的工作完成。
  const memberPort = await relay.memberPorts.ensure(MEMBER_MACHINE)
  if (memberPort === undefined) throw new Error('the member machine did not get a browser port')

  const fixture: Fixture = {
    relay,
    store,
    mainPort: address.port,
    memberPort,
    memberUpstream,
    connectors,
    upstreams: [hubUpstream, memberUpstream],
    sessionCookie,
  }
  fixtures.push(fixture)
  return fixture
}

/** 加载控制台，以获取它签发的双提交 CSRF cookie。 */
async function openConsole(fixture: Fixture): Promise<{ csrf: string; csrfPair: string }> {
  const page = await httpRequest({
    port: fixture.mainPort,
    path: ADMIN_PATH_PREFIX,
    headers: {
      host: `${LAN_IP}:${String(fixture.mainPort)}`,
      accept: 'text/html',
      cookie: fixture.sessionCookie,
    },
  })
  expect(page.status, page.body).toBe(200)
  const setCookie = setCookieArray(page.headers).find(header => header.includes('dsh_csrf='))
  if (setCookie === undefined) throw new Error('console did not issue a CSRF cookie')
  const csrfPair = setCookie.split(';', 1)[0] ?? ''
  const csrf = readCookie(csrfPair, 'dsh_csrf')
  if (csrf === undefined) throw new Error('could not parse the CSRF cookie')
  return { csrf, csrfPair }
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    for (const connector of fixture.connectors) connector.close()
    await fixture.relay.close()
    rmSync(fixture.relay.config.home, { recursive: true, force: true })
    fixture.store.close()
    await Promise.all(fixture.upstreams.map(async upstream => new Promise<void>((resolve) => {
      upstream.server.close(() => resolve())
    })))
  }))
})

describe('D16 member ports', () => {
  it('routes each port to its own machine and leaves the hub on the main port', async () => {
    const fixture = await startFixture()

    const member = await httpRequest({
      port: fixture.memberPort,
      path: '/api/session.list',
      headers: {
        host: `${LAN_IP}:${String(fixture.memberPort)}`,
        origin: `http://${LAN_IP}:${String(fixture.memberPort)}`,
        cookie: fixture.sessionCookie,
      },
    })
    expect(member.status, member.body).toBe(200)
    expect(JSON.parse(member.body)).toMatchObject({
      machine: MEMBER_SLUG,
      // 模式 A 原样转发浏览器自己的 authority。
      host: `${LAN_IP}:${String(fixture.memberPort)}`,
      path: '/api/session.list',
    })

    const hub = await httpRequest({
      port: fixture.mainPort,
      path: '/api/session.list',
      headers: { host: `${LAN_IP}:${String(fixture.mainPort)}`, cookie: fixture.sessionCookie },
    })
    expect(hub.status, hub.body).toBe(200)
    expect(JSON.parse(hub.body)).toMatchObject({ machine: HUB_SLUG })

    // hub 在主端口响应，因此不能同时占用成员端口。
    expect(fixture.relay.memberPorts.portOf(HUB_MACHINE)).toBeUndefined()
    expect(fixture.store.getDeviceByMachineId(HUB_MACHINE)?.browserPort).toBeNull()
    expect(fixture.store.getDeviceByBrowserPort(fixture.memberPort)?.machineId).toBe(MEMBER_MACHINE)
  })

  it('still requires authentication on a member port', async () => {
    const fixture = await startFixture()
    const host = `${LAN_IP}:${String(fixture.memberPort)}`

    const navigation = await httpRequest({
      port: fixture.memberPort,
      path: '/conversation?id=1',
      headers: { host, accept: 'text/html' },
    })
    expect(navigation.status).toBe(302)
    expect(navigation.headers.location).toBe('/_auth/login?returnTo=%2Fconversation%3Fid%3D1')

    const api = await httpRequest({
      port: fixture.memberPort,
      path: '/api/session.list',
      method: 'POST',
      headers: { host },
    })
    expect(api.status).toBe(401)

    // 登录页本身在成员端口提供，因此该重定向会落到
    // 有用的位置，而不是死路。
    const login = await httpRequest({
      port: fixture.memberPort,
      path: '/_auth/login',
      headers: { host, accept: 'text/html' },
    })
    expect(login.status).toBe(200)
    expect(login.body).toContain('建立安全控制链路')
  })

  it('sends the console back to the main port instead of serving it per machine', async () => {
    const fixture = await startFixture()

    const consolePage = await httpRequest({
      port: fixture.memberPort,
      path: ADMIN_PATH_PREFIX,
      headers: { host: `${LAN_IP}:${String(fixture.memberPort)}`, accept: 'text/html' },
    })
    expect(consolePage.status).toBe(302)
    expect(consolePage.headers.location)
      .toBe(`http://${LAN_IP}:${String(fixture.mainPort)}${ADMIN_PATH_PREFIX}`)

    // connector 始终拨号主端口；成员端口只供浏览器使用。
    const tunnel = await httpRequest({
      port: fixture.memberPort,
      path: TUNNEL_CONTROL_PATH,
      headers: { host: `${LAN_IP}:${String(fixture.memberPort)}` },
    })
    expect(tunnel.status).toBe(404)
  })

  // M2 验收：已认证调用方请求此 hub 不提供的 slug 时，
  // 必须得到裸 404。更丰富的响应（403，或已知但
  // 离线机器的不同响应体）会把 hub 变成查询哪些机器
  // 存在的 oracle。未认证调用方不会走到这里：它们会
  // 在解析路由前重定向到登录页。
  it('answers 404 for a slug this hub does not serve, without revealing existence', async () => {
    const fixture = await startFixture()

    const unknown = await httpRequest({
      port: fixture.mainPort,
      path: '/',
      headers: { host: 'pc9.dsh.test', accept: 'text/html', cookie: fixture.sessionCookie },
    })
    const known = await httpRequest({
      port: fixture.mainPort,
      path: '/',
      headers: { host: 'pc1.dsh.test', accept: 'text/html', cookie: fixture.sessionCookie },
    })

    expect(unknown.status).toBe(404)
    // 已注册机器必须与从未存在过的机器无法区分。
    expect(known.status).toBe(404)
    expect(known.body).toBe(unknown.body)
  })

  it('prints a connector command carrying the port-less authority to trust', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)
    const host = `${LAN_IP}:${String(fixture.mainPort)}`

    const issued = await httpRequest({
      port: fixture.mainPort,
      path: ADMIN_TOKEN_CREATE_PATH,
      method: 'POST',
      headers: {
        host,
        origin: `http://${host}`,
        cookie: `${fixture.sessionCookie}; ${csrfPair}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf, slug: 'pc3' }).toString(),
    })
    expect(issued.status, issued.body).toBe(200)

    // 没有公网域名时，浏览器会在当前主机上通过
    // 日后分配的端口访问 pc3，而 dsh 会将不带端口的条目匹配到任意端口——
    // 因此端口尚不存在时也能打印命令。
    expect(issued.body).toContain(`--relay ws://${host} --slug pc3 --enroll-token `)
    expect(issued.body).toContain(`--hub-authority ${LAN_IP}<`)
  })

  it('lists the member address in the console and drops the listener on revoke', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)
    const host = `${LAN_IP}:${String(fixture.mainPort)}`

    const page = await httpRequest({
      port: fixture.mainPort,
      path: ADMIN_PATH_PREFIX,
      headers: { host, accept: 'text/html', cookie: fixture.sessionCookie },
    })
    expect(page.body).toContain(`http://${LAN_IP}:${String(fixture.memberPort)}/`)

    const revoked = await httpRequest({
      port: fixture.mainPort,
      path: ADMIN_REVOKE_PATH,
      method: 'POST',
      headers: {
        host,
        origin: `http://${host}`,
        cookie: `${fixture.sessionCookie}; ${csrfPair}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf, machineId: MEMBER_MACHINE }).toString(),
    })
    expect(revoked.status).toBe(303)

    // 吊销会在后台关闭 listener；等待排队的工作完成。
    await fixture.relay.memberPorts.release(MEMBER_MACHINE)
    expect(fixture.relay.memberPorts.portOf(MEMBER_MACHINE)).toBeUndefined()
    await expect(httpRequest({
      port: fixture.memberPort,
      path: '/',
      headers: { host: `${LAN_IP}:${String(fixture.memberPort)}` },
    })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('hands the same port back when a machine re-enrolls', async () => {
    const fixture = await startFixture()
    const original = fixture.memberPort

    fixture.connectors[1]?.close()
    fixture.store.revokeDevice(MEMBER_MACHINE)
    await fixture.relay.memberPorts.release(MEMBER_MACHINE)

    const reconnected = new MockConnector({
      relayPort: fixture.mainPort,
      upstreamPort: fixture.memberUpstream.port,
      identity: createDeviceIdentity(),
      enrollToken: issueEnrollToken(fixture.store, MEMBER_SLUG),
      machineId: MEMBER_MACHINE,
      slug: MEMBER_SLUG,
    })
    fixture.connectors.push(reconnected)
    await reconnected.ready()

    // 书签必须在重新注册后仍然有效，因此复用预留端口。
    expect(await fixture.relay.memberPorts.ensure(MEMBER_MACHINE)).toBe(original)
    const member = await httpRequest({
      port: original,
      path: '/',
      headers: { host: `${LAN_IP}:${String(original)}`, cookie: fixture.sessionCookie },
    })
    expect(member.status, member.body).toBe(200)
    expect(JSON.parse(member.body)).toMatchObject({ machine: MEMBER_SLUG })
  })

  it('reopens member listeners for machines enrolled before a restart', async () => {
    const fixture = await startFixture()
    const original = fixture.memberPort

    await fixture.relay.memberPorts.closeAll()
    expect(fixture.relay.memberPorts.portOf(MEMBER_MACHINE)).toBeUndefined()

    await fixture.relay.memberPorts.syncFromStore()
    expect(fixture.relay.memberPorts.portOf(MEMBER_MACHINE)).toBe(original)
  })
})
