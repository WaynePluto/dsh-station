import { ADMIN_THEME_SCRIPT } from '../src/admin/theme-client.js'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PAGE_CSP, SPLASH_CSP } from '../src/admin/shared.js'
import {
  ENROLL_TOKEN_SHOWN_ONCE_NOTICE,
  hashOpaqueToken,
  type RelayStore,
} from '../src/index.js'
import {
  ADMIN_PATH_PREFIX,
  ADMIN_REVOKE_PATH,
  ADMIN_TOKEN_CREATE_PATH,
} from '../src/admin/console-app.js'
import {
  closeFixtures,
  httpRequest,
  registerTestDevice,
  openAuthenticatedPage,
  openCsrfPage,
  postCsrfForm,
  postForm,
  setCookieArray,
  startAuthenticatedRelayFixture,
  type AuthenticatedRelayTestFixture,
  type HttpResult,
} from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x77)
const HOST = 'pc1.dsh.test'
const ORIGIN = 'https://pc1.dsh.test'
const MACHINE_ID = 'machine-console-01'
const MACHINE_SLUG = 'pc1'
/** 控制台测试不会打开隧道流，因此 connector 从不拨号到这里。 */
const UNUSED_UPSTREAM_PORT = 1

type Fixture = AuthenticatedRelayTestFixture

const fixtures: Fixture[] = []

async function startFixture(options: { online: boolean }): Promise<Fixture> {
  const fixture = await startAuthenticatedRelayFixture({
    jwtSecret: JWT_SECRET,
    account: {
      kind: 'existing-user',
      input: {
        id: 'console-test-user',
        username: 'admin',
        passwordHash: 'test-password-hash',
        totpSecret: 'test-totp-secret',
        totpEnabled: true,
      },
    },
    relay: { streamConnectTimeoutMs: 2_000 },
    device: options.online
      ? {
          mode: 'online',
          machineId: MACHINE_ID,
          slug: MACHINE_SLUG,
          upstreamPort: UNUSED_UPSTREAM_PORT,
        }
      : { mode: 'offline', machineId: MACHINE_ID, slug: MACHINE_SLUG },
  })
  fixtures.push(fixture)
  return fixture
}

/** 加载一次控制台，以获取它签发的双提交 CSRF cookie。 */
async function openConsole(fixture: Fixture) {
  const page = await openCsrfPage(fixture, {
    path: ADMIN_PATH_PREFIX,
    host: HOST,
    label: 'console',
  })
  expect(page.status, page.body).toBe(200)
  return page
}

function revoke(fixture: Fixture, options: {
  csrf: string
  csrfPair: string
  machineId: string
}): Promise<HttpResult> {
  return postCsrfForm(fixture, {
    path: ADMIN_REVOKE_PATH,
    host: HOST,
    origin: ORIGIN,
    sessionCookie: fixture.sessionCookie,
    csrfPair: options.csrfPair,
    fields: { csrf: options.csrf, machineId: options.machineId },
  })
}

function createToken(fixture: Fixture, options: {
  csrf: string
  csrfPair: string
  slug: string
  name?: string
}): Promise<HttpResult> {
  return postCsrfForm(fixture, {
    path: ADMIN_TOKEN_CREATE_PATH,
    host: HOST,
    origin: ORIGIN,
    sessionCookie: fixture.sessionCookie,
    csrfPair: options.csrfPair,
    fields: { csrf: options.csrf, slug: options.slug, name: options.name ?? '' },
  })
}

/** 控制台只在一个元素中渲染一次明文。 */
function tokenFromPage(body: string): string {
  const matches = [...body.matchAll(/<p class="secret">([^<]+)<\/p>/g)]
  expect(matches).toHaveLength(1)
  const token = matches[0]?.[1]
  if (token === undefined) throw new Error('the console did not render a token')
  return token
}

function lastIssuedTokenId(store: RelayStore): string | undefined {
  const audit = store.listAudit().find(record => record.event === 'device.enroll-token-created')
  const metadata = audit?.metadata as { tokenId?: string } | undefined
  return metadata?.tokenId
}

afterEach(async () => {
  await closeFixtures(fixtures, {
    beforeRelayClose: fixture => fixture.connector?.close(),
  })
})

describe('M2.5 admin console', () => {
  it('requires an authenticated session before any handler runs', async () => {
    const fixture = await startFixture({ online: false })

    const navigation = await httpRequest({
      port: fixture.port,
      path: ADMIN_PATH_PREFIX,
      headers: { host: HOST, accept: 'text/html' },
    })
    expect(navigation.status).toBe(302)
    expect(navigation.headers.location).toBe('/_auth/login?returnTo=%2F_admin')

    const post = await httpRequest({
      port: fixture.port,
      path: ADMIN_REVOKE_PATH,
      method: 'POST',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: `machineId=${MACHINE_ID}`,
    })
    expect(post.status).toBe(401)
    expect(fixture.store.getDeviceByMachineId(MACHINE_ID)?.revokedAt).toBeNull()
  })

  it('lists machines with their live online state and browser entry point', async () => {
    const fixture = await startFixture({ online: true })
    registerTestDevice(fixture.store, { machineId: 'machine-console-02', slug: 'srv' })

    const { body } = await openConsole(fixture)
    expect(body).toContain('<h1>机器</h1>')
    expect(body).toContain('<h2 class="section">工作站列表</h2>')
    expect(body).toContain(MACHINE_ID)
    expect(body).toContain('<span class="badge on">在线</span>')
    expect(body).toContain('href="https://pc1.dsh.test/"')
    expect(body).toContain('<span class="badge off">离线</span>')
    // 桌面占位由壳叠加，普通浏览器仍保留原来的24px/窄屏12px留白。
    expect(body).toContain('body{--dsh-station-page-top-gap:24px;')
    expect(body).toContain('padding:var(--dsh-station-page-top-gap) 16px 24px')
    expect(body).toContain('@media(max-width:460px){body{--dsh-station-page-top-gap:12px;padding:var(--dsh-station-page-top-gap) 8px 12px}')
    expect(body).toContain('body{place-items:start center}')
    // 离线机器没有可链接的访问入口。
    expect(body).not.toContain('href="https://srv.dsh.test/"')
  })

  it('refuses a revoke without a valid CSRF token and keeps the device active', async () => {
    const fixture = await startFixture({ online: true })
    const { csrfPair } = await openConsole(fixture)

    const forged = await revoke(fixture, { csrf: 'not-the-cookie', csrfPair, machineId: MACHINE_ID })
    expect(forged.status).toBe(403)
    expect(fixture.store.getDeviceByMachineId(MACHINE_ID)?.revokedAt).toBeNull()
    expect(fixture.relay.tunnel.registry.machines()).toHaveLength(1)
  })

  it('revokes a device and drops its live control channel immediately', async () => {
    const fixture = await startFixture({ online: true })
    const connector = fixture.connector
    if (connector === undefined) throw new Error('fixture is missing its connector')
    const { csrf, csrfPair } = await openConsole(fixture)

    const closed = once(connector.control, 'close')
    const response = await revoke(fixture, { csrf, csrfPair, machineId: MACHINE_ID })
    expect(response.status).toBe(303)
    expect(response.headers.location).toBe(ADMIN_PATH_PREFIX)
    expect(fixture.store.getDeviceByMachineId(MACHINE_ID)?.revokedAt).toBeTypeOf('number')
    expect(fixture.relay.tunnel.registry.machines()).toHaveLength(0)

    await closed
    expect(connector.lastError).toMatchObject({ code: 'DEVICE_REVOKED', fatal: true })

    const audit = fixture.store.listAudit().find(record => record.event === 'device.revoked')
    expect(audit).toMatchObject({
      success: true,
      machineId: MACHINE_ID,
      actorUserId: fixture.userId,
    })
    expect(audit?.sourceIp).toBeTypeOf('string')
  })

  it('guards a revoke behind a confirmation page that changes nothing by itself', async () => {
    const fixture = await startFixture({ online: true })
    const { body, csrfPair } = await openConsole(fixture)
    // 列表提供确认页面，绝不提供一键吊销。
    expect(body).toContain(`${ADMIN_REVOKE_PATH}?machineId=${encodeURIComponent(MACHINE_ID)}`)
    expect(body).not.toContain('<button class="danger" type="submit">停止并移除</button>')

    const confirm = await openAuthenticatedPage(fixture, {
      path: `${ADMIN_REVOKE_PATH}?machineId=${encodeURIComponent(MACHINE_ID)}`,
      host: HOST,
      cookie: `${fixture.sessionCookie}; ${csrfPair}`,
    })
    expect(confirm.status, confirm.body).toBe(200)
    expect(confirm.body).toContain(`停止 ${MACHINE_SLUG} 并移除？`)
    expect(confirm.body).toContain(`停止 ${MACHINE_SLUG} 的连接及工作站托管的 dsh`)
    expect(confirm.body).toContain('对话记录保留')
    expect(confirm.body).toContain(`<a href="${ADMIN_PATH_PREFIX}">`)
    // 渲染页面不能触碰设备或其控制信道。
    expect(fixture.store.getDeviceByMachineId(MACHINE_ID)?.revokedAt).toBeNull()
    expect(fixture.relay.tunnel.registry.machines()).toHaveLength(1)
    // 此页面背后的控制台标签会保留其 CSRF token。
    expect(setCookieArray(confirm.headers).some(header => header.includes('dsh_csrf='))).toBe(false)

    // 未知或已吊销机器没有需要确认的内容。
    const unknown = await httpRequest({
      port: fixture.port,
      path: `${ADMIN_REVOKE_PATH}?machineId=machine-does-not-exist`,
      headers: { host: HOST, accept: 'text/html', cookie: fixture.sessionCookie },
    })
    expect(unknown.status).toBe(303)
    expect(unknown.headers.location).toBe(ADMIN_PATH_PREFIX)
  })

  it('escapes attacker-influenced device text', async () => {
    const fixture = await startFixture({ online: false })
    registerTestDevice(fixture.store, { machineId: '<script>alert(1)</script>', slug: 'evil' })

    const { body } = await openConsole(fixture)
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect([...body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)].map(match => match[1])).toEqual([ADMIN_THEME_SCRIPT])
  })

  it('refuses to issue an enrollment token without a valid CSRF token', async () => {
    const fixture = await startFixture({ online: false })
    const { csrfPair } = await openConsole(fixture)

    const forged = await createToken(fixture, { csrf: 'not-the-cookie', csrfPair, slug: 'pc9' })
    expect(forged.status).toBe(403)
    expect(lastIssuedTokenId(fixture.store)).toBeUndefined()
  })

  it('shows a new enrollment token once, stores only its hash, and prints the command', async () => {
    const fixture = await startFixture({ online: false })
    const { csrf, csrfPair } = await openConsole(fixture)

    const issued = await createToken(fixture, { csrf, csrfPair, slug: 'pc9', name: 'study laptop' })
    expect(issued.status, issued.body).toBe(200)
    expect(issued.body).toContain(ENROLL_TOKEN_SHOWN_ONCE_NOTICE)
    const token = tokenFromPage(issued.body)
    expect(token.length).toBeGreaterThanOrEqual(32)
    // 命令必须一次携带另一台机器所需的一切：
    // 令牌，以及 dsh 必须信任的 authority（模式 A 原样转发
    // 浏览器 Host；使用公网域名时它就是该机器的子域名）。
    expect(issued.body)
      .toContain(`dsh-station-connector --relay wss://dsh.test --slug pc9 --enroll-token ${token} --hub-authority pc9.dsh.test`)

    const tokenId = lastIssuedTokenId(fixture.store)
    if (tokenId === undefined) throw new Error('the console wrote no audit row for the token')
    const record = fixture.store.getEnrollTokenById(tokenId)
    expect(record).toMatchObject({
      requestedSlug: 'pc9',
      deviceName: 'study laptop',
      createdByUserId: fixture.userId,
    })
    expect(record?.tokenHash).toBe(hashOpaqueToken(token))
    expect(record?.tokenHash).not.toBe(token)

    // 这是实际的一次性令牌，不只是渲染出来的字符串——使用
    // 后不会留下记录。
    expect(fixture.store.consumeEnrollToken({
      tokenHash: hashOpaqueToken(token),
      device: { machineId: 'machine-console-09', slug: 'pc9', publicKey: 'key-nine' },
    })).toMatchObject({ machineId: 'machine-console-09' })
    expect(fixture.store.getEnrollTokenById(tokenId)).toBeUndefined()

    // 重新加载控制台不能再次带回明文。
    const reloaded = await openConsole(fixture)
    expect(reloaded.body).not.toContain(token)
    expect(reloaded.body).not.toContain('class="secret"')
  })

  it('keeps the loopback admin flow on HTTP with a separate CSRF cookie', async () => {
    const fixture = await startFixture({ online: false })
    const localHost = `127.0.0.1:${String(fixture.port)}`
    const localPage = await openCsrfPage(fixture, {
      path: ADMIN_PATH_PREFIX,
      host: localHost,
      cookie: '',
      csrfCookieName: 'dsh_csrf',
      label: 'loopback console',
    })
    expect(localPage.status, localPage.body).toBe(200)
    const csrfCookie = setCookieArray(localPage.headers).find(header => header.startsWith('dsh_csrf='))
    expect(csrfCookie).toBeDefined()
    expect(csrfCookie).not.toContain('Secure')
    expect(csrfCookie).not.toContain('Domain=')

    const issued = await postForm(fixture, {
      path: ADMIN_TOKEN_CREATE_PATH,
      host: localHost,
      origin: `http://${localHost}`,
      cookie: localPage.csrfPair,
      fields: { csrf: localPage.csrf, slug: 'pc9', name: '' },
    })
    expect(issued.status, issued.body).toBe(200)
    expect(issued.body).toContain('dsh-station-connector --relay wss://dsh.test')
  })

  it('rejects a malformed slug without issuing anything', async () => {
    const fixture = await startFixture({ online: false })
    const { csrf, csrfPair } = await openConsole(fixture)

    const bad = await createToken(fixture, { csrf, csrfPair, slug: 'Not A Slug' })
    expect(bad.status).toBe(400)
    expect(bad.body).toContain('DNS 标签')
    expect(bad.body).not.toContain('class="secret"')
    expect(lastIssuedTokenId(fixture.store)).toBeUndefined()
  })

  it('shows local loopback visitors a minimal splash instead of the console-styled offline page', async () => {
    // directSlug 让 127.0.0.1 Host 解析到机器（生产 launcher 总是传它）；
    // home 指到临时目录，避免 relay 的自挂条目写进真实 dsh-station home。
    const home = await mkdtemp(join(tmpdir(), 'relay-splash-'))
    const fixture = await startAuthenticatedRelayFixture({
      jwtSecret: JWT_SECRET,
      account: {
        kind: 'existing-user',
        input: {
          id: 'console-test-user',
          username: 'admin',
          passwordHash: 'test-password-hash',
          totpSecret: 'test-totp-secret',
          totpEnabled: true,
        },
      },
      relay: { streamConnectTimeoutMs: 2_000, directSlug: MACHINE_SLUG, home },
      device: { mode: 'offline', machineId: MACHINE_ID, slug: MACHINE_SLUG },
    })
    fixtures.push(fixture)
    try {
      const local = await httpRequest({
        port: fixture.port,
        path: '/',
        headers: {
          host: `127.0.0.1:${String(fixture.port)}`,
          cookie: fixture.sessionCookie,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      })
      expect(local.status).toBe(502)
      expect(local.headers['content-type']).toContain('text/html')
      expect(local.body).toContain('正在启动 DSH 工作站')
      expect(local.body).toContain('class="spin"')
      expect(local.body).toContain('<noscript><meta http-equiv="refresh" content="1"></noscript>')
      expect(local.body).not.toContain('content="0.2"')
      expect(local.headers['content-security-policy']).toBe(SPLASH_CSP)
      expect(local.body).toContain("redirect: 'manual'")
      const probe = await httpRequest({
        port: fixture.port,
        path: '/',
        headers: { accept: 'text/plain', 'sec-fetch-site': 'same-origin' },
      })
      expect(probe.status).toBe(502)
      expect(probe.headers['content-type']).toContain('text/plain')
      expect(probe.body).not.toContain('<script>')
      const crossSite = await httpRequest({
        port: fixture.port,
        path: '/',
        headers: { accept: 'text/plain', 'sec-fetch-site': 'cross-site' },
      })
      expect(crossSite.status).toBe(403)
      // 启动等待是应用体验的一部分：不得出现管理页的痕迹。
      expect(local.body).not.toContain('当前离线')
      expect(local.body).not.toContain(ADMIN_PATH_PREFIX)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('answers an offline machine with an HTML page only for browser navigation', async () => {
    const fixture = await startFixture({ online: false })

    const navigation = await httpRequest({
      port: fixture.port,
      path: '/',
      headers: {
        host: HOST,
        cookie: fixture.sessionCookie,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    expect(navigation.status).toBe(502)
    expect(navigation.headers['content-type']).toContain('text/html')
    expect(navigation.body).toContain('<!doctype html>')
    expect(navigation.body).toContain('pc1 当前离线')
    expect(navigation.headers['content-security-policy']).toBe(PAGE_CSP)
    expect(navigation.body).not.toContain('<script>')
    // 离线页承担启动等待：meta refresh 每秒重试，机器上线后顺着 303 进 dsh。
    expect(navigation.body).toContain('<meta http-equiv="refresh" content="1">')
    expect(navigation.body).toContain('自动重试')

    const api = await httpRequest({
      port: fixture.port,
      path: '/api/session.list',
      headers: { host: HOST, cookie: fixture.sessionCookie, accept: 'application/json' },
    })
    expect(api.status).toBe(502)
    expect(api.headers['content-type']).toContain('text/plain')
    expect(api.body).toBe('machine pc1 is offline\n')
  })
})
