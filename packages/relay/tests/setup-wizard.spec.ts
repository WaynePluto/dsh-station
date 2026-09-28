import { afterEach, describe, expect, it } from 'vitest'
import {
  generateTotp,
} from '../src/index.js'
import { ADMIN_PATH_PREFIX } from '../src/admin/console-app.js'
import {
  SETUP_CONFIRM_PATH,
  SETUP_CREATE_PATH,
  SETUP_PATH_PREFIX,
} from '../src/admin/setup-app.js'
import {
  closeFixtures,
  csrfTokensFromResponse,
  httpRequest,
  openCsrfPage,
  postForm,
  setCookieArray,
  startRelayFixture,
  type RelayTestFixture,
  type HttpResult,
} from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x5a)
const PASSWORD = 'Correct horse battery staple 1'
/** 此处 socket 仍是 loopback；只有 D15 的 Host 部分被违反。 */
const LAN_HOST = '192.168.7.11'

interface Fixture extends RelayTestFixture {
  readonly loopbackHost: string
  readonly loopbackOrigin: string
  readonly lanHost: string
}

const fixtures: Fixture[] = []

/** 已配置浏览器认证但尚未有账号的 relay。 */
async function startFixture(): Promise<Fixture> {
  const base = await startRelayFixture({
    jwtSecret: JWT_SECRET,
    relay: {
      directSlug: 'pc1',
      publicScheme: 'http',
      memberPortCount: 0,
      streamConnectTimeoutMs: 2_000,
      browserAuth: { cookieMode: 'lan-http' },
    },
  })
  const fixture: Fixture = {
    ...base,
    loopbackHost: `127.0.0.1:${String(base.port)}`,
    loopbackOrigin: `http://127.0.0.1:${String(base.port)}`,
    lanHost: `${LAN_HOST}:${String(base.port)}`,
  }
  fixtures.push(fixture)
  return fixture
}

/** 加载向导，以获取它签发的双提交 CSRF cookie。 */
async function openWizard(fixture: Fixture) {
  const page = await openCsrfPage(fixture, {
    path: SETUP_PATH_PREFIX,
    host: fixture.loopbackHost,
    csrfCookieName: 'dsh_csrf',
    label: 'wizard',
  })
  expect(page.status, page.body).toBe(200)
  return page
}

function submit(fixture: Fixture, options: {
  path: string
  host?: string
  origin?: string
  cookie?: string
  fields: Record<string, string>
}): Promise<HttpResult> {
  return postForm(fixture, {
    path: options.path,
    host: options.host ?? fixture.loopbackHost,
    origin: options.origin ?? fixture.loopbackOrigin,
    ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    fields: options.fields,
  })
}

/** 注册 secret 只在一个元素中渲染一次。 */
function secretFromPage(body: string): string {
  const matches = [...body.matchAll(/<p class="otp">([^<]+)<\/p>/g)]
  expect(matches).toHaveLength(1)
  const grouped = matches[0]?.[1]
  if (grouped === undefined) throw new Error('the page rendered no TOTP secret')
  return grouped.replaceAll(' ', '')
}

/** 端到端走完向导；若干测试需要已完成设置的 relay。 */
async function completeSetup(fixture: Fixture): Promise<{ secret: string }> {
  const { csrf, csrfPair } = await openWizard(fixture)
  const created = await submit(fixture, {
    path: SETUP_CREATE_PATH,
    cookie: csrfPair,
    fields: { csrf, username: 'admin', password: PASSWORD, confirmPassword: PASSWORD },
  })
  expect(created.status, created.body).toBe(200)
  const secret = secretFromPage(created.body)
  const { csrf: nextCsrf, csrfPair: nextPair } = csrfTokensFromResponse(created, {
    cookieName: 'dsh_csrf',
    label: 'enrollment step',
  })
  const confirmed = await submit(fixture, {
    path: SETUP_CONFIRM_PATH,
    cookie: nextPair,
    fields: { csrf: nextCsrf, totp: await generateTotp(secret) },
  })
  expect(confirmed.status, confirmed.body).toBe(303)
  expect(confirmed.headers.location).toBe(ADMIN_PATH_PREFIX)
  return { secret }
}

afterEach(async () => {
  await closeFixtures(fixtures)
})

describe('first-run setup wizard', () => {
  it('serves the wizard on loopback; business pages flow through, admin pages steer to it', async () => {
    const fixture = await startFixture()

    const { body } = await openWizard(fixture)
    expect(body).toContain('创建管理员账号')
    expect(body).toContain(`action="${SETUP_CREATE_PATH}"`)
    // 账号名是真实字段且已预填：即使操作员从不阅读
    // 提示，也能看到登录表单将要求的名称。
    expect(body).toContain('name="username" value="admin"')
    // 没有登录表单：目前还没有能通过登录的账号。
    expect(body).not.toContain('/_auth/login')

    // 首次免设置：本机业务请求不被向导拦截（没有机器可代理时它按
    // 普通的 502 暴露，而不是被重定向去创建管理员）。
    const root = await httpRequest({
      port: fixture.port,
      path: '/',
      headers: { host: fixture.loopbackHost, accept: 'text/html' },
    })
    expect(root.status).toBe(502)

    // 管理页是远程能力的入口：未初始化时在本机打开它才被引导到向导。
    const admin = await httpRequest({
      port: fixture.port,
      path: '/_admin',
      headers: { host: fixture.loopbackHost, accept: 'text/html' },
    })
    expect(admin.status).toBe(303)
    expect(admin.headers.location).toBe(SETUP_PATH_PREFIX)

    // 登录页同样让位给向导：还没有能通过登录的账号。
    const login = await httpRequest({
      port: fixture.port,
      path: '/_auth/login',
      headers: { host: fixture.loopbackHost, accept: 'text/html' },
    })
    expect(login.status).toBe(303)
    expect(login.headers.location).toBe(SETUP_PATH_PREFIX)

    // 非 loopback 的业务请求保持拒绝：远程访问必须等设置完成后登录。
    const lan = await httpRequest({
      port: fixture.port,
      path: '/',
      headers: { host: fixture.lanHost, accept: 'text/html' },
    })
    expect(lan.status).toBe(503)
    expect(lan.body).toContain('请先创建管理员账号')
  })

  it('refuses to create the administrator from a non-loopback Host', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openWizard(fixture)

    const page = await httpRequest({
      port: fixture.port,
      path: SETUP_PATH_PREFIX,
      headers: { host: fixture.lanHost, accept: 'text/html' },
    })
    expect(page.status).toBe(503)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.body).toContain('请先创建管理员账号')
    expect(page.body).toContain(`http://127.0.0.1:${String(fixture.port)}${SETUP_PATH_PREFIX}`)
    expect(page.body).not.toContain(`action="${SETUP_CREATE_PATH}"`)

    // 即使携带在 loopback 上签发的 CSRF 对，局域网也不能认领它。
    const forged = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      host: fixture.lanHost,
      origin: `http://${fixture.lanHost}`,
      cookie: csrfPair,
      fields: { csrf, password: PASSWORD, confirmPassword: PASSWORD },
    })
    expect(forged.status).toBe(503)
    expect(fixture.store.countUsers()).toBe(0)

    const landing = await httpRequest({
      port: fixture.port,
      path: '/',
      headers: { host: fixture.lanHost, accept: 'text/html' },
    })
    expect(landing.status).toBe(503)
    expect(landing.body).toContain('请先创建管理员账号')
  })

  it('rejects a CSRF-less or cross-origin submission and creates no user', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openWizard(fixture)

    const noCsrf = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      cookie: csrfPair,
      fields: { password: PASSWORD, confirmPassword: PASSWORD },
    })
    expect(noCsrf.status).toBe(403)

    const wrongCsrf = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      cookie: csrfPair,
      fields: { csrf: 'not-the-cookie', password: PASSWORD, confirmPassword: PASSWORD },
    })
    expect(wrongCsrf.status).toBe(403)

    const crossOrigin = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      origin: 'http://evil.example',
      cookie: csrfPair,
      fields: { csrf, password: PASSWORD, confirmPassword: PASSWORD },
    })
    expect(crossOrigin.status).toBe(403)

    expect(fixture.store.countUsers()).toBe(0)
  })

  it('rejects a mismatched or too short password without creating anything', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openWizard(fixture)

    const mismatch = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      cookie: csrfPair,
      fields: { csrf, username: 'admin', password: PASSWORD, confirmPassword: `${PASSWORD}!` },
    })
    expect(mismatch.status).toBe(400)
    expect(mismatch.body).toContain('两次输入的密码不一致')

    const short = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      cookie: csrfPair,
      fields: { csrf, username: 'admin', password: 'short', confirmPassword: 'short' },
    })
    expect(short.status).toBe(400)
    expect(short.body).toContain('个字符')

    expect(fixture.store.countUsers()).toBe(0)
  })

  it('accepts a chosen account name and rejects one that breaks the policy', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openWizard(fixture)

    const bad = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      cookie: csrfPair,
      fields: { csrf, username: '-张三 ', password: PASSWORD, confirmPassword: PASSWORD },
    })
    expect(bad.status).toBe(400)
    expect(bad.body).toContain('账号名')
    expect(fixture.store.countUsers()).toBe(0)

    const created = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      cookie: csrfPair,
      // 首尾空白会被去除，和登录表单的处理方式相同。
      fields: { csrf, username: '  Wei.Lu  ', password: PASSWORD, confirmPassword: PASSWORD },
    })
    expect(created.status, created.body).toBe(200)
    expect(fixture.store.getUserByUsername('admin')).toBeUndefined()
    expect(fixture.store.getUserByUsername('Wei.Lu')?.totpEnabled).toBe(false)
  })

  it('creates the administrator, shows a scannable QR, and logs in after confirmation', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openWizard(fixture)

    const created = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      cookie: csrfPair,
      fields: { csrf, username: 'admin', password: PASSWORD, confirmPassword: PASSWORD },
    })
    expect(created.status, created.body).toBe(200)
    // 使用内联 SVG，因此页面的 CSP 无需 img-src 例外。
    expect(created.headers['content-security-policy']).toContain("default-src 'none'")
    expect(created.body).toContain('<svg')
    expect(created.body).not.toContain('data:image')
    const secret = secretFromPage(created.body)
    expect(secret.length).toBeGreaterThanOrEqual(16)

    const staged = fixture.store.getUserByUsername('admin')
    expect(staged).toMatchObject({ totpSecret: secret, totpEnabled: false })

    // 重新加载注册步骤必须重绘同一个暂存 secret，而不是
    // 签发新的 secret 并使刚扫描的动态码失效。
    const reloaded = await openWizard(fixture)
    expect(secretFromPage(reloaded.body)).toBe(secret)

    const rejected = await submit(fixture, {
      path: SETUP_CONFIRM_PATH,
      cookie: reloaded.csrfPair,
      fields: { csrf: reloaded.csrf, totp: '000000' },
    })
    expect(rejected.status).toBe(400)
    expect(rejected.body).toContain('动态码不正确')
    expect(fixture.store.getUserByUsername('admin')?.totpEnabled).toBe(false)

    const after = await openWizard(fixture)
    const confirmed = await submit(fixture, {
      path: SETUP_CONFIRM_PATH,
      cookie: after.csrfPair,
      fields: { csrf: after.csrf, totp: await generateTotp(secretFromPage(after.body)) },
    })
    expect(confirmed.status, confirmed.body).toBe(303)
    expect(confirmed.headers.location).toBe(ADMIN_PATH_PREFIX)
    expect(setCookieArray(confirmed.headers).some(header => header.includes('dsh_access='))).toBe(true)
    expect(fixture.store.getUserByUsername('admin')?.totpEnabled).toBe(true)

    const events = fixture.store.listAudit().map(record => record.event)
    expect(events).toContain('admin.initialized')
    expect(events).toContain('totp.enrollment-confirmed')
  })

  it('is gone once an account exists', async () => {
    const fixture = await startFixture()
    await completeSetup(fixture)

    const wizard = await httpRequest({
      port: fixture.port,
      path: SETUP_PATH_PREFIX,
      headers: { host: fixture.loopbackHost, accept: 'text/html' },
    })
    expect(wizard.status).toBe(303)
    expect(wizard.headers.location).toBe(ADMIN_PATH_PREFIX)

    const create = await submit(fixture, {
      path: SETUP_CREATE_PATH,
      fields: { username: 'admin', password: 'a different password', confirmPassword: 'a different password' },
    })
    expect(create.status).toBeGreaterThanOrEqual(303)
    expect(fixture.store.countUsers()).toBe(1)

    // 远程浏览器现在会进入普通登录流程，而不是 503 页面。
    const remote = await httpRequest({
      port: fixture.port,
      path: '/',
      headers: { host: fixture.lanHost, accept: 'text/html' },
    })
    expect(remote.status).toBe(302)
    expect(remote.headers.location).toContain('/_auth/login')
  })
})