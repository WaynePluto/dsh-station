import { afterEach, describe, expect, it } from 'vitest'
import { ADMIN_PATH_PREFIX, ADMIN_REVOKE_PATH, ADMIN_WAKEUP_PATH } from '../src/admin/console-app.js'
import {
  closeFixtures,
  httpRequest,
  openCsrfPage,
  postCsrfForm,
  probeWakeup,
  registerKnownDevice,
  registerTestDevice,
  startAuthenticatedRelayFixture,
  type AuthenticatedRelayTestFixture,
  type HttpResult,
} from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x71)
const HOST = 'pc1.dsh.test'
const ORIGIN = 'https://pc1.dsh.test'
const MACHINE_ID = 'machine-wakeup-01'
const MACHINE_SLUG = 'pc2'

type Fixture = AuthenticatedRelayTestFixture

const fixtures: Fixture[] = []

async function startFixture(options: { online?: boolean } = {}): Promise<Fixture> {
  const fixture = await startAuthenticatedRelayFixture({
    jwtSecret: JWT_SECRET,
    account: {
      kind: 'existing-user',
      input: {
        id: 'wakeup-test-user',
        username: 'admin',
        passwordHash: 'test-password-hash',
        totpSecret: 'test-totp-secret',
        totpEnabled: true,
      },
    },
    relay: { streamConnectTimeoutMs: 2_000 },
    ...options.online === undefined
      ? {}
      : {
          device: options.online
            ? { mode: 'online' as const, machineId: MACHINE_ID, slug: MACHINE_SLUG, upstreamPort: 1 }
            : { mode: 'offline' as const, machineId: MACHINE_ID, slug: MACHINE_SLUG },
        },
  })
  fixtures.push(fixture)
  return fixture
}

async function openConsole(fixture: Fixture) {
  const page = await openCsrfPage(fixture, {
    path: ADMIN_PATH_PREFIX,
    host: HOST,
    label: 'console',
  })
  expect(page.status, page.body).toBe(200)
  return page
}

function requestWakeup(fixture: Fixture, options: {
  csrf: string
  csrfPair: string
  machineId: string
}): Promise<HttpResult> {
  return postCsrfForm(fixture, {
    path: ADMIN_WAKEUP_PATH,
    host: HOST,
    origin: ORIGIN,
    sessionCookie: fixture.sessionCookie,
    csrfPair: options.csrfPair,
    fields: { csrf: options.csrf, machineId: options.machineId },
  })
}

afterEach(async () => {
  await closeFixtures(fixtures)
})

describe('wakeup probes on the control plane', () => {
  it('answers a probe with auth-ok and a polite close, without listing the machine online', async () => {
    const fixture = await startFixture()
    const identity = registerKnownDevice(fixture.store, { machineId: MACHINE_ID, slug: MACHINE_SLUG })

    const answer = await probeWakeup({
      relayPort: fixture.port,
      identity,
      machineId: MACHINE_ID,
      slug: MACHINE_SLUG,
    })

    expect(answer).toEqual({ offered: false, closeCode: 1000 })
    expect(fixture.relay.tunnel.registry.machines()).toHaveLength(0)
    expect(fixture.relay.tunnel.registry.lastProbeAt(MACHINE_ID)).toBeTypeOf('number')
  })

  it('delivers a wakeup request as a reconnect-offer on the next probe', async () => {
    const fixture = await startFixture()
    const identity = registerKnownDevice(fixture.store, { machineId: MACHINE_ID, slug: MACHINE_SLUG })
    const { csrf, csrfPair } = await openConsole(fixture)
    expect(await requestWakeup(fixture, { csrf, csrfPair, machineId: MACHINE_ID })).toMatchObject({ status: 303 })

    const answer = await probeWakeup({
      relayPort: fixture.port,
      identity,
      machineId: MACHINE_ID,
      slug: MACHINE_SLUG,
    })
    expect(answer.offered).toBe(true)
    // 探测会话本身不承载流量：机器仍不在在线名单里。
    expect(fixture.relay.tunnel.registry.machines()).toHaveLength(0)

    const audit = fixture.store.listAudit().find(record => record.event === 'machine.wakeup-requested')
    expect(audit).toMatchObject({ success: true, actorUserId: fixture.userId, machineId: MACHINE_ID })
  })

  it('requires a valid CSRF token and ignores wakeup for unknown machines', async () => {
    const fixture = await startFixture()
    registerTestDevice(fixture.store, { machineId: MACHINE_ID, slug: MACHINE_SLUG })
    const { csrf, csrfPair } = await openConsole(fixture)

    const forged = await requestWakeup(fixture, { csrf: 'not-the-cookie', csrfPair, machineId: MACHINE_ID })
    expect(forged.status).toBe(403)
    expect(fixture.store.getDeviceByMachineId(MACHINE_ID)?.wakeupRequestedAt).toBeNull()

    const missing = await requestWakeup(fixture, { csrf, csrfPair, machineId: 'no-such-machine' })
    expect(missing.status).toBe(404)
  })
})

describe('wakeup state on the machines page', () => {
  it('shows disconnected-but-probing machines as wakeable, truly silent ones as offline', async () => {
    const fixture = await startFixture()
    const identity = registerKnownDevice(fixture.store, { machineId: MACHINE_ID, slug: MACHINE_SLUG })
    registerTestDevice(fixture.store, { machineId: 'machine-wakeup-02', slug: 'silent' })

    await probeWakeup({ relayPort: fixture.port, identity, machineId: MACHINE_ID, slug: MACHINE_SLUG })
    const { body } = await openConsole(fixture)

    expect(body).toContain('<span class="badge idle">已断开 · 可唤醒</span>')
    expect(body).toContain('请求 pc2 上线')
    expect(body).toContain('<span class="badge off">离线</span>')
    // 两台都不在线：按钮对两种断开状态都提供，徽标说明区别。
    expect(body).toContain('请求 silent 上线')
    expect(body).toContain('重连通常需约一分钟')
    expect(body).toContain('请求保留 24 小时')
    expect(body).toContain('无法唤醒已关机的机器')
  })

  it('offers no wakeup button for online machines and labels removal differently', async () => {
    const fixture = await startFixture({ online: true })
    const { body } = await openConsole(fixture)

    expect(body).toContain('<span class="badge on">在线</span>')
    expect(body).not.toContain('请求 pc2 上线')
    expect(body).toContain(`停止 ${MACHINE_SLUG} 并移除…`)
  })

  it('labels offline removal honestly and explains it cannot stop the machine', async () => {
    const fixture = await startFixture()
    registerTestDevice(fixture.store, { machineId: MACHINE_ID, slug: MACHINE_SLUG })
    const { body } = await openConsole(fixture)

    expect(body).toContain(`移除 ${MACHINE_SLUG}…`)
    expect(body).not.toContain(`停止 ${MACHINE_SLUG} 并移除…`)

    // 确认页如实区分在线与离线：离线移除送不到对方机器。
    const confirm = await httpRequest({
      port: fixture.port,
      path: `${ADMIN_REVOKE_PATH}?machineId=${encodeURIComponent(MACHINE_ID)}`,
      headers: { host: HOST, accept: 'text/html', cookie: fixture.sessionCookie },
    })
    expect(confirm.status, confirm.body).toBe(200)
    expect(confirm.body).toContain('当前离线')
    expect(confirm.body).toContain('仅移除设备身份')
    expect(confirm.body).toContain('不停止该机服务')
    expect(confirm.body).toContain(`type="submit">移除 ${MACHINE_SLUG}</button>`)
  })
})
