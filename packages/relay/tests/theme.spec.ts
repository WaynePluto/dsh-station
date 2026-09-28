import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserCookiePolicy,
} from '../src/index.js'
import { ADMIN_PATH_PREFIX } from '../src/admin/console-app.js'
import { LOGIN_PATH } from '../src/admin/auth-app.js'
import { THEME_PATH } from '../src/admin/theme.js'
import {
  closeFixtures,
  cookieHeader,
  httpRequest,
  openPage,
  setCookieArray,
  startAuthenticatedRelayFixture,
  type AuthenticatedRelayTestFixture,
  type HttpResult,
} from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x5e)
const HOST = 'pc1.dsh.test'
const PASSWORD = 'Correct horse battery staple 1'

const cookies = new BrowserCookiePolicy({ mode: 'domain-https', domain: 'dsh.test' })

type Fixture = AuthenticatedRelayTestFixture

const fixtures: Fixture[] = []

async function startFixture(): Promise<Fixture> {
  const fixture = await startAuthenticatedRelayFixture({
    jwtSecret: JWT_SECRET,
    account: { kind: 'initialize-admin', username: 'admin', password: PASSWORD },
    relay: { streamConnectTimeoutMs: 2_000 },
    cookiePolicy: cookies,
  })
  fixtures.push(fixture)
  return fixture
}

function open(fixture: Fixture, path: string, cookie?: string): Promise<HttpResult> {
  return openPage(fixture, { path, host: HOST, ...cookie === undefined ? {} : { cookie } })
}

/** 浏览器切换一次主题后会带回的 Cookie header。 */
function themeCookie(result: HttpResult): string {
  const header = setCookieArray(result.headers)
    .find(value => value.startsWith(`${cookies.names.theme}=`))
  if (header === undefined) throw new Error('the theme switch set no cookie')
  return cookieHeader([header])
}

afterEach(async () => {
  await closeFixtures(fixtures)
})

describe('the appearance switch', () => {
  it('defaults management to system without an independent theme switch', async () => {
    const fixture = await startFixture()

    const machines = await open(fixture, ADMIN_PATH_PREFIX, fixture.sessionCookie)
    expect(machines.status).toBe(200)
    expect(machines.body).toContain('<html lang="zh-CN" data-theme="system">')
    expect(machines.body).not.toContain(`${THEME_PATH}?value=`)
    expect(machines.body).not.toContain('aria-label="外观"')
  })

  it('preserves the public cookie switch but does not let it override management', async () => {
    const fixture = await startFixture()

    const switched = await httpRequest({
      port: fixture.port,
      path: `${THEME_PATH}?value=dark&returnTo=${encodeURIComponent(ADMIN_PATH_PREFIX)}`,
      headers: { host: HOST, accept: 'text/html', cookie: fixture.sessionCookie },
    })
    expect(switched.status).toBe(303)
    expect(switched.headers.location).toBe(ADMIN_PATH_PREFIX)

    const remembered = await open(
      fixture,
      ADMIN_PATH_PREFIX,
      `${fixture.sessionCookie}; ${themeCookie(switched)}`,
    )
    expect(remembered.status).toBe(200)
    expect(remembered.body).toContain('<html lang="zh-CN" data-theme="system">')
    expect(remembered.body).not.toContain(`${THEME_PATH}?value=`)
  })

  it('works on the login page, which nobody has a session for yet', async () => {
    const fixture = await startFixture()

    const login = await open(fixture, LOGIN_PATH)
    expect(login.status).toBe(200)
    expect(login.body).toContain('<html lang="zh-CN" data-theme="system">')

    // 此交换过程中完全没有会话 cookie：切换会在认证前响应，
    // 正因为如此该页面才能提供切换。
    const switched = await httpRequest({
      port: fixture.port,
      path: `${THEME_PATH}?value=light&returnTo=${encodeURIComponent(LOGIN_PATH)}`,
      headers: { host: HOST, accept: 'text/html' },
    })
    expect(switched.status).toBe(303)
    expect(switched.headers.location).toBe(LOGIN_PATH)

    const remembered = await open(fixture, LOGIN_PATH, themeCookie(switched))
    expect(remembered.status).toBe(200)
    expect(remembered.body).toContain('<html lang="zh-CN" data-theme="light">')
    expect(remembered.body).toContain('aria-current="true">浅色</a>')
  })

  it('keeps the login page pointed at where the browser was heading', async () => {
    const fixture = await startFixture()

    const login = await open(fixture, `${LOGIN_PATH}?returnTo=%2F_admin%2Fhub`)
    expect(login.status).toBe(200)
    // 在这里切换主题不能丢失操作员原本请求的页面。
    const loginWithReturn = `${LOGIN_PATH}?returnTo=${encodeURIComponent('/_admin/hub')}`
    expect(login.body).toContain(`returnTo=${encodeURIComponent(loginWithReturn)}`)
  })

  it('refuses an unknown appearance, a non-GET, and an off-site return path', async () => {
    const fixture = await startFixture()

    const unknown = await open(fixture, `${THEME_PATH}?value=sepia`, fixture.sessionCookie)
    expect(unknown.status).toBe(400)
    expect(setCookieArray(unknown.headers)).toHaveLength(0)

    const posted = await httpRequest({
      port: fixture.port,
      path: `${THEME_PATH}?value=dark`,
      method: 'POST',
      headers: { host: HOST, cookie: fixture.sessionCookie },
    })
    expect(posted.status).toBe(405)

    const offSite = await open(
      fixture,
      `${THEME_PATH}?value=dark&returnTo=${encodeURIComponent('//evil.example/')}`,
      fixture.sessionCookie,
    )
    expect(offSite.status).toBe(303)
    expect(offSite.headers.location).toBe('/')
  })
})
