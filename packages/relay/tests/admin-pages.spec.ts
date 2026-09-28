/* oxlint-disable no-await-in-loop -- 页面矩阵需要按顺序访问，避免多个真实 relay 请求互相影响。 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  type RelayStore,
} from '../src/index.js'
import {
  ADMIN_ACCOUNT_PATH,
  ADMIN_HUB_PATH,
  ADMIN_PATH_PREFIX,
} from '../src/admin/console-app.js'
import {
  closeFixtures,
  httpRequest,
  openAuthenticatedPage,
  startAuthenticatedRelayFixture,
  type AuthenticatedRelayTestFixture,
  type HttpResult,
} from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x3c)
const HOST = 'pc1.dsh.test'
const PASSWORD = 'Correct horse battery staple 1'

/** 标签栏提供的所有页面，按列出顺序排列。 */
const CONSOLE_PAGES: readonly { path: string; heading: string }[] = [
  { path: ADMIN_PATH_PREFIX, heading: '机器' },
  { path: ADMIN_HUB_PATH, heading: '远程入口' },
  { path: ADMIN_ACCOUNT_PATH, heading: '账号与安全' },
]

type Fixture = AuthenticatedRelayTestFixture

const fixtures: Fixture[] = []

async function startFixture(): Promise<Fixture> {
  const fixture = await startAuthenticatedRelayFixture({
    jwtSecret: JWT_SECRET,
    account: { kind: 'initialize-admin', username: 'admin', password: PASSWORD },
    relay: { streamConnectTimeoutMs: 2_000 },
  })
  fixtures.push(fixture)
  return fixture
}

function open(fixture: Fixture, path: string): Promise<HttpResult> {
  return openAuthenticatedPage(fixture, { path, host: HOST })
}

/** 填充审计轨迹，使泄露它的页面确实有内容可显示。 */
function fillAudit(store: RelayStore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    store.appendAudit({
      occurredAt: Date.UTC(2026, 0, 1) + index * 60_000,
      event: index % 2 === 0 ? 'login.succeeded' : 'device.revoked',
      success: true,
      sourceIp: '10.0.0.9',
    })
  }
}

afterEach(async () => {
  await closeFixtures(fixtures)
})

describe('console pages behind one tab strip', () => {
  it('serves each page, and every page links to all three tabs', async () => {
    const fixture = await startFixture()

    for (const target of CONSOLE_PAGES) {
      const page = await open(fixture, target.path)
      expect(page.status, `${target.path} -> ${page.body}`).toBe(200)
      expect(page.body).toContain(`<h1>${target.heading}</h1>`)
      // 精简描述不能省略当前管理的机器或混淆登录状态。
      expect(page.body).toContain('当前机器：')
      expect(page.body).toContain('已登录：admin')
      expect(page.body).not.toContain('signed in as')
      // 标签栏是找到其他页面的唯一入口，因此它必须在每个页面上
      // 完整显示，并且恰好有一个当前标签。
      for (const tab of CONSOLE_PAGES) expect(page.body).toContain(`href="${tab.path}"`)
      expect(page.body).toContain(`<a href="${target.path}" aria-current="page">`)
      expect([...page.body.matchAll(/<a href="[^"]*" aria-current="page">/g)]).toHaveLength(1)
    }
  })

  it('keeps every page behind the session check', async () => {
    const fixture = await startFixture()

    for (const target of CONSOLE_PAGES) {
      const anonymous = await httpRequest({
        port: fixture.port,
        path: target.path,
        headers: { host: HOST, accept: 'text/html' },
      })
      expect(anonymous.status, target.path).toBe(302)
      expect(anonymous.headers.location).toContain('/_auth/login?returnTo=')
    }
  })

  it('answers an unknown console path with 404 rather than a page', async () => {
    const fixture = await startFixture()

    const missing = await open(fixture, `${ADMIN_PATH_PREFIX}/nope`)
    expect(missing.status).toBe(404)
  })
})

describe('the audit trail stays out of the console', () => {
  it('serves no audit page and shows no records on the machines page', async () => {
    const fixture = await startFixture()
    fillAudit(fixture.store, 12)

    // 审计轨迹是写给在 relay 主机上读取 audit_log 和 pino 流的人看的，
    // 控制台不应把它展示给浏览器。
    const gone = await open(fixture, `${ADMIN_PATH_PREFIX}/audit`)
    expect(gone.status).toBe(404)

    const machines = await open(fixture, ADMIN_PATH_PREFIX)
    expect(machines.status).toBe(200)
    expect(machines.body).not.toContain('最近活动')
    expect(machines.body).not.toContain('login.succeeded')
    expect(machines.body).not.toContain('/_admin/audit')
  })

  it('still records every event in the store', async () => {
    const fixture = await startFixture()
    fillAudit(fixture.store, 3)

    // 删除页面只是删除视图，不是删除轨迹：fixture 执行的登录
    // 和预置记录仍然都可以查询。
    const events = fixture.store.listAudit().map(record => record.event)
    expect(events).toContain('login.succeeded')
    expect(events).toContain('device.revoked')
  })
})
