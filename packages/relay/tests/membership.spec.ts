import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { MEMBERSHIP_FILE_NAME, parseMembership, type MembershipHub } from '@dsh-station/protocol'
import {
  ADMIN_MEMBERSHIP_JOIN_PATH,
  ADMIN_MEMBERSHIP_LEAVE_PATH,
  ADMIN_MEMBERSHIP_RECONNECT_PATH,
  ADMIN_HUB_PATH,
} from '../src/admin/console-app.js'
import {
  closeFixtures,
  openAuthenticatedPage,
  openCsrfPage,
  postCsrfForm,
  startAuthenticatedRelayFixture,
  type AuthenticatedRelayTestFixture,
  type HttpResult,
} from './helpers.js'

const JWT_SECRET = new Uint8Array(32).fill(0x77)
const HOST = 'pc1.dsh.test'
const ORIGIN = 'https://pc1.dsh.test'
const HUB_URL = 'wss://hub.dsh.test:30809'
const HUB_SLUG = 'pc2'
const HUB_AUTHORITY = '10.1.2.87:30810'
/** 对 `membershipSchema` 来说足够长，也足够独特，便于在页面中 grep。 */
const ENROLL_TOKEN = 'jointoken-4f2b9c7e1a5d8306'
/** 与入口机器控制台打印的形状完全一致。 */
const HUB_COMMAND = `dsh-station-connector --relay ${HUB_URL} --slug ${HUB_SLUG} --enroll-token ${ENROLL_TOKEN} --hub-authority ${HUB_AUTHORITY}`

interface Fixture extends AuthenticatedRelayTestFixture {
  readonly home: string
  readonly membershipPath: string
}

const fixtures: Fixture[] = []

async function startFixture(): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-station-membership-'))
  const base = await startAuthenticatedRelayFixture({
    jwtSecret: JWT_SECRET,
    account: {
      kind: 'existing-user',
      input: {
        id: 'membership-test-user',
        username: 'admin',
        passwordHash: 'test-password-hash',
        totpSecret: 'test-totp-secret',
        totpEnabled: true,
      },
    },
    relay: { home },
  })
  const fixture: Fixture = {
    ...base,
    home,
    membershipPath: join(home, MEMBERSHIP_FILE_NAME),
  }
  fixtures.push(fixture)
  return fixture
}

async function openConsole(fixture: Fixture) {
  const page = await openCsrfPage(fixture, {
    path: ADMIN_HUB_PATH,
    host: HOST,
    label: 'console',
  })
  expect(page.status, page.body).toBe(200)
  return page
}

function post(fixture: Fixture, path: string, options: {
  csrf: string
  csrfPair: string
  fields?: Record<string, string>
}): Promise<HttpResult> {
  return postCsrfForm(fixture, {
    path,
    host: HOST,
    origin: ORIGIN,
    sessionCookie: fixture.sessionCookie,
    csrfPair: options.csrfPair,
    fields: { csrf: options.csrf, ...options.fields },
  })
}

function joinHub(fixture: Fixture, options: {
  csrf: string
  csrfPair: string
  fields: Record<string, string>
}): Promise<HttpResult> {
  return post(fixture, ADMIN_MEMBERSHIP_JOIN_PATH, options)
}

/** connector 在这台机器上实际会读取的 membership。 */
function storedHub(fixture: Fixture): MembershipHub | undefined {
  return parseMembership(readFileSync(fixture.membershipPath, 'utf8'))?.hub
}

/** 「重新连接」会恢复的 lastHub。 */
function storedLastHub(fixture: Fixture): MembershipHub | undefined {
  return parseMembership(readFileSync(fixture.membershipPath, 'utf8'))?.lastHub
}

function membershipFileExists(fixture: Fixture): boolean {
  return readdirSync(fixture.home).includes(MEMBERSHIP_FILE_NAME)
}

afterEach(async () => {
  await closeFixtures(fixtures, {
    afterStoreClose: fixture => rmSync(fixture.home, { recursive: true, force: true }),
  })
})

describe('D16 membership: this machine joining a hub', () => {
  it('tells the operator plainly that this machine has joined nothing yet', async () => {
    const fixture = await startFixture()

    const { body } = await openConsole(fixture)
    expect(body).toContain('<h1>远程入口</h1>')
    expect(body).toContain('未设置远程入口')
    // 短副标题仍说明方向与单入口限制，取消后果留在确认页。
    expect(body).toContain('<p class="intro">通过其他机器访问本机，同时仅使用一个远程入口。</p>')
    expect(membershipFileExists(fixture)).toBe(false)
  })

  it('writes a membership file the connector can parse, with no stray temp file', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)
    const before = Date.now()

    const response = await joinHub(fixture, {
      csrf,
      csrfPair,
      fields: { command: HUB_COMMAND },
    })
    expect(response.status, response.body).toBe(303)
    expect(response.headers.location).toBe(ADMIN_HUB_PATH)

    const hub = storedHub(fixture)
    expect(hub).toMatchObject({
      relayUrl: HUB_URL,
      slug: HUB_SLUG,
      enrollToken: ENROLL_TOKEN,
      browserAuthority: HUB_AUTHORITY,
    })
    expect(hub?.joinedAt).toBeGreaterThanOrEqual(before)
    // rename 后目录中只能留下最终文件，不能有其他内容。
    expect(readdirSync(fixture.home)).toEqual([MEMBERSHIP_FILE_NAME])

    if (process.platform !== 'win32') {
      expect(statSync(fixture.membershipPath).mode & 0o777).toBe(0o600)
    }
  })

  it('refuses a join without a valid CSRF token', async () => {
    const fixture = await startFixture()
    const { csrfPair } = await openConsole(fixture)

    const forged = await joinHub(fixture, {
      csrf: 'not-the-cookie',
      csrfPair,
      fields: { command: HUB_COMMAND },
    })
    expect(forged.status).toBe(403)
    expect(membershipFileExists(fixture)).toBe(false)
    expect(fixture.store.listAudit().some(record => record.event === 'membership.joined')).toBe(false)
  })

  it('refuses a command whose relay URL is not ws:// or wss://', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    const commands = [
      `dsh-station-connector --relay https://hub.dsh.test --slug ${HUB_SLUG} --enroll-token ${ENROLL_TOKEN}`,
      `dsh-station-connector --relay hub.dsh.test:30809 --slug ${HUB_SLUG} --enroll-token ${ENROLL_TOKEN}`,
      // 根本不是 connector 命令：没有可读取的 relay。
      'rm -rf /',
    ]
    for (const command of commands) {
      // eslint-disable-next-line no-await-in-loop -- 每次尝试都断言同一个未改动的文件
      const rejected = await joinHub(fixture, { csrf, csrfPair, fields: { command } })
      expect(rejected.status, command).toBe(400)
      expect(rejected.body).toContain('--relay')
    }
    expect(membershipFileExists(fixture)).toBe(false)
  })

  it('refuses a machine name that is not a DNS label, without echoing the token back', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    const rejected = await joinHub(fixture, {
      csrf,
      csrfPair,
      fields: {
        command: `dsh-station-connector --relay ${HUB_URL} --slug "Not A Slug" --enroll-token ${ENROLL_TOKEN}`,
      },
    })
    expect(rejected.status).toBe(400)
    expect(rejected.body).toContain('DNS 标签')
    expect(membershipFileExists(fixture)).toBe(false)
    // 被拒绝的页面绝不能把粘贴的 secret 交还给浏览器。
    expect(rejected.body).not.toContain(ENROLL_TOKEN)
  })

  it('reads the command whatever quoting or --flag=value spelling it arrives in', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    const plain = await joinHub(fixture, { csrf, csrfPair, fields: { command: HUB_COMMAND } })
    expect(plain.status, plain.body).toBe(303)
    const { joinedAt: _plainAt, ...plainHub } = storedHub(fixture) ?? {}

    const quoted = await joinHub(fixture, {
      csrf,
      csrfPair,
      fields: {
        command: `dsh-station-connector --relay="${HUB_URL}" --slug='${HUB_SLUG}' --enroll-token=${ENROLL_TOKEN} --hub-authority=${HUB_AUTHORITY} --dsh-port 3080`,
      },
    })
    expect(quoted.status, quoted.body).toBe(303)
    const { joinedAt: _quotedAt, ...quotedHub } = storedHub(fixture) ?? {}
    expect(quotedHub).toEqual(plainHub)
    expect(quotedHub).toMatchObject({
      relayUrl: HUB_URL,
      slug: HUB_SLUG,
      enrollToken: ENROLL_TOKEN,
      browserAuthority: HUB_AUTHORITY,
    })
  })

  it('says so plainly when the pasted command carries no authority to trust', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    const response = await joinHub(fixture, {
      csrf,
      csrfPair,
      fields: {
        command: `dsh-station-connector --relay ${HUB_URL} --slug ${HUB_SLUG} --enroll-token ${ENROLL_TOKEN}`,
      },
    })
    expect(response.status, response.body).toBe(303)
    expect(storedHub(fixture)?.browserAuthority).toBeUndefined()

    // 没有它远程访问无法工作，因此页面不能保持沉默。
    const { body } = await openConsole(fixture)
    expect(body).toContain('缺少浏览器地址，远程访问暂不可用')
    expect(body).toContain('获取新令牌和完整连接命令')
  })

  it('leaves the hub without touching the machines that joined this one', async () => {
    const fixture = await startFixture()
    const joined = await openConsole(fixture)
    await joinHub(fixture, {
      csrf: joined.csrf,
      csrfPair: joined.csrfPair,
      fields: { command: HUB_COMMAND },
    })

    const reloaded = await openConsole(fixture)
    expect(reloaded.body).toContain('已设置远程入口')
    // 离开要经过确认页面，而不是一键提交。
    expect(reloaded.body).toContain(`href="${ADMIN_MEMBERSHIP_LEAVE_PATH}"`)
    const confirm = await openAuthenticatedPage(fixture, {
      path: ADMIN_MEMBERSHIP_LEAVE_PATH,
      host: HOST,
      cookie: `${fixture.sessionCookie}; ${reloaded.csrfPair}`,
    })
    expect(confirm.status, confirm.body).toBe(200)
    expect(confirm.body).toContain('的远程入口？')
    expect(confirm.body).toContain(HUB_URL)
    expect(confirm.body).not.toContain(ENROLL_TOKEN)
    // 渲染它不会改变 membership。
    expect(storedHub(fixture)).toMatchObject({ relayUrl: HUB_URL, slug: HUB_SLUG })

    const response = await post(fixture, ADMIN_MEMBERSHIP_LEAVE_PATH, {
      csrf: reloaded.csrf,
      csrfPair: reloaded.csrfPair,
    })
    expect(response.status, response.body).toBe(303)
    expect(response.headers.location).toBe(`${ADMIN_HUB_PATH}?done=leave`)
    // 文件会保留但不带 hub：connector 必须读取明确的“not a member”。
    expect(membershipFileExists(fixture)).toBe(true)
    expect(storedHub(fixture)).toBeUndefined()

    const left = fixture.store.listAudit().find(record => record.event === 'membership.left')
    expect(left).toMatchObject({ success: true, actorUserId: fixture.userId })
    expect(left?.metadata).toMatchObject({ relayUrl: HUB_URL, slug: HUB_SLUG })
  })

  it('never puts the enrollment token in the page or in the audit trail', async () => {
    const fixture = await startFixture()
    const { csrf, csrfPair } = await openConsole(fixture)

    await joinHub(fixture, {
      csrf,
      csrfPair,
      fields: { command: HUB_COMMAND },
    })

    const reloaded = await openConsole(fixture)
    expect(reloaded.body).toContain('注册令牌 已保存')
    expect(reloaded.body).not.toContain(ENROLL_TOKEN)
    // 只有 connector 读取的文件可以保存 secret。
    expect(readFileSync(fixture.membershipPath, 'utf8')).toContain(ENROLL_TOKEN)

    const audit = fixture.store.listAudit().find(record => record.event === 'membership.joined')
    expect(audit).toMatchObject({ success: true, actorUserId: fixture.userId })
    expect(audit?.metadata).toMatchObject({
      relayUrl: HUB_URL,
      slug: HUB_SLUG,
      browserAuthority: HUB_AUTHORITY,
      enrollTokenProvided: true,
    })
    expect(JSON.stringify(fixture.store.listAudit())).not.toContain(ENROLL_TOKEN)
  })
})

/** 与 launcher 写入的契约一致（protocol 的 dsh-restart schema）。 */
function writeRestartStatus(fixture: Fixture, status: Record<string, unknown>): void {
  writeFileSync(join(fixture.home, 'dsh-restart-status.json'), `${JSON.stringify(status, undefined, 2)}\n`)
}

describe('launcher dsh auto-restart status on the hub page', () => {
  it('explains an in-progress restart and asks for a refresh', async () => {
    const fixture = await startFixture()
    writeRestartStatus(fixture, {
      state: 'restarting',
      at: 1_800_000_000_000,
      added: [HUB_AUTHORITY],
      removed: [],
    })

    const { body } = await openConsole(fixture)
    expect(body).toContain('正在自动重启 dsh')
    expect(body).toContain(`新增信任 ${HUB_AUTHORITY}`)
    expect(body).toContain('刷新本页查看结果')
  })

  it('reports a finished restart with its timestamp', async () => {
    const fixture = await startFixture()
    writeRestartStatus(fixture, {
      state: 'done',
      at: Date.UTC(2026, 8, 14, 16, 50),
      added: [HUB_AUTHORITY],
      removed: [],
    })

    const { body } = await openConsole(fixture)
    expect(body).toContain('dsh 已重启')
    expect(body).toContain('2026-09-14 16:50 UTC')
  })

  it('shows the failure reason and the manual recovery action', async () => {
    const fixture = await startFixture()
    writeRestartStatus(fixture, {
      state: 'failed',
      at: 1_800_000_000_000,
      added: [],
      removed: [HUB_AUTHORITY],
      error: 'dsh did not become ready',
    })

    const { body } = await openConsole(fixture)
    expect(body).toContain('自动重启 dsh 失败')
    expect(body).toContain('dsh did not become ready')
    expect(body).toContain(`移除信任 ${HUB_AUTHORITY}`)
    expect(body).toContain('退出并重新打开工作站')
  })

  it('renders no restart card while the launcher has not written one', async () => {
    const fixture = await startFixture()

    const { body } = await openConsole(fixture)
    expect(body).not.toContain('class="restart"')
    expect(body).not.toContain('正在自动重启')
    expect(body).toContain('提交后会自动重启 dsh')
  })
})

describe('remembering the last hub for one-click reconnect', () => {
  it('stores the left hub as lastHub and offers a reconnect card', async () => {
    const fixture = await startFixture()
    const joined = await openConsole(fixture)
    await joinHub(fixture, {
      csrf: joined.csrf,
      csrfPair: joined.csrfPair,
      fields: { command: HUB_COMMAND },
    })

    const reloaded = await openConsole(fixture)
    const response = await post(fixture, ADMIN_MEMBERSHIP_LEAVE_PATH, {
      csrf: reloaded.csrf,
      csrfPair: reloaded.csrfPair,
    })
    expect(response.status, response.body).toBe(303)

    // 取消后：没有 hub，但记住了上次的入口（不带一次性令牌）。
    expect(storedHub(fixture)).toBeUndefined()
    expect(storedLastHub(fixture)).toMatchObject({
      relayUrl: HUB_URL,
      slug: HUB_SLUG,
      browserAuthority: HUB_AUTHORITY,
    })
    expect(readFileSync(fixture.membershipPath, 'utf8')).not.toContain('enrollToken')

    const left = await openConsole(fixture)
    expect(left.body).toContain('上次的远程入口')
    expect(left.body).toContain(`action="${ADMIN_MEMBERSHIP_RECONNECT_PATH}"`)
    expect(left.body).toContain('<button type="submit">重新连接</button>')
    expect(left.body).toContain(HUB_URL)
    expect(left.body).not.toContain(ENROLL_TOKEN)
  })

  it('reconnects the remembered hub without a token and clears the memory', async () => {
    const fixture = await startFixture()
    const joined = await openConsole(fixture)
    await joinHub(fixture, {
      csrf: joined.csrf,
      csrfPair: joined.csrfPair,
      fields: { command: HUB_COMMAND },
    })
    const reloaded = await openConsole(fixture)
    await post(fixture, ADMIN_MEMBERSHIP_LEAVE_PATH, {
      csrf: reloaded.csrf,
      csrfPair: reloaded.csrfPair,
    })

    const left = await openConsole(fixture)
    const response = await post(fixture, ADMIN_MEMBERSHIP_RECONNECT_PATH, {
      csrf: left.csrf,
      csrfPair: left.csrfPair,
    })
    expect(response.status, response.body).toBe(303)
    expect(response.headers.location).toBe(`${ADMIN_HUB_PATH}?done=reconnect`)

    // 恢复的 hub 不带令牌：connector 用设备密钥直接认证。
    expect(storedHub(fixture)).toMatchObject({
      relayUrl: HUB_URL,
      slug: HUB_SLUG,
      browserAuthority: HUB_AUTHORITY,
    })
    expect(storedHub(fixture)?.enrollToken).toBeUndefined()
    expect(storedLastHub(fixture)).toBeUndefined()

    const audit = fixture.store.listAudit().find(record => record.event === 'membership.joined')
    expect(audit).toMatchObject({ success: true, actorUserId: fixture.userId })
    expect(audit?.metadata).toMatchObject({
      relayUrl: HUB_URL,
      slug: HUB_SLUG,
      enrollTokenProvided: false,
      via: 'reconnect',
    })
    // 重连后的页面不再显示重连卡片。
    const back = await openConsole(fixture)
    expect(back.body).toContain('已设置远程入口')
    expect(back.body).not.toContain('上次的远程入口')
  })

  it('tells the operator to refresh after leaving or reconnecting', async () => {
    const fixture = await startFixture()
    const joined = await openConsole(fixture)
    await joinHub(fixture, {
      csrf: joined.csrf,
      csrfPair: joined.csrfPair,
      fields: { command: HUB_COMMAND },
    })
    const reloaded = await openConsole(fixture)
    const left = await post(fixture, ADMIN_MEMBERSHIP_LEAVE_PATH, {
      csrf: reloaded.csrf,
      csrfPair: reloaded.csrfPair,
    })
    expect(left.headers.location).toBe(`${ADMIN_HUB_PATH}?done=leave`)

    // 断开后的页面：提示正在断开与 dsh 自动重启，稍后刷新。
    const page = await openCsrfPage(fixture, {
      path: `${ADMIN_HUB_PATH}?done=leave`,
      host: HOST,
      label: 'left',
    })
    expect(page.status, page.body).toBe(200)
    expect(page.body).toContain('已提交取消')
    expect(page.body).toContain('稍后刷新本页查看状态')

    // 重连后的页面：提示正在拨号与恢复信任地址。
    const consolePage = await openCsrfPage(fixture, {
      path: ADMIN_HUB_PATH,
      host: HOST,
      label: 'reconnect-csrf',
    })
    const back = await post(fixture, ADMIN_MEMBERSHIP_RECONNECT_PATH, {
      csrf: consolePage.csrf,
      csrfPair: consolePage.csrfPair,
    })
    expect(back.headers.location).toBe(`${ADMIN_HUB_PATH}?done=reconnect`)
    const reconnected = await openCsrfPage(fixture, {
      path: `${ADMIN_HUB_PATH}?done=reconnect`,
      host: HOST,
      label: 'reconnected',
    })
    expect(reconnected.body).toContain('已提交重新连接')
    expect(reconnected.body).toContain('稍后刷新本页查看状态')
    expect(reconnected.body).toContain('连接结果尚待确认')

    // 未知 done 值不渲染提示；普通页面也没有。
    const plain = await openConsole(fixture)
    expect(plain.body).not.toContain('已提交取消')
    expect(plain.body).not.toContain('已提交重新连接')
  })

  it('requires the CSRF token and ignores reconnect without a remembered hub', async () => {
    const fixture = await startFixture()
    const page = await openConsole(fixture)

    // 没有 lastHub：回到本页，什么都不写。
    const response = await post(fixture, ADMIN_MEMBERSHIP_RECONNECT_PATH, {
      csrf: page.csrf,
      csrfPair: page.csrfPair,
    })
    expect(response.status, response.body).toBe(303)
    expect(membershipFileExists(fixture)).toBe(false)

    // 伪造的提交被 CSRF 检查拒绝。
    const forged = await postCsrfForm(fixture, {
      path: ADMIN_MEMBERSHIP_RECONNECT_PATH,
      host: HOST,
      origin: ORIGIN,
      sessionCookie: fixture.sessionCookie,
      csrfPair: page.csrfPair,
      fields: { csrf: 'not-the-token' },
    })
    expect(forged.status).toBe(403)
  })
})
