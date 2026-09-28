import { ADMIN_THEME_SCRIPT } from '../src/admin/theme-client.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MEMBERSHIP_FILE_NAME,
  parseMembership,
  type DshRestartStatus,
  type MembershipHub,
  type MembershipLastHub,
} from '@dsh-station/protocol'
import { hubPage, type MembershipView } from '../src/admin/console/hub.js'
import {
  ADMIN_HUB_PATH,
  ADMIN_MEMBERSHIP_JOIN_PATH,
  ADMIN_MEMBERSHIP_LEAVE_PATH,
  ADMIN_MEMBERSHIP_RECONNECT_PATH,
} from '../src/admin/console/shell.js'
import {
  closeFixtures,
  openAuthenticatedPage,
  openCsrfPage,
  postCsrfForm,
  startAuthenticatedRelayFixture,
  type AuthenticatedRelayTestFixture,
} from './helpers.js'

const MACHINE = 'work-pc'
const CSRF = 'csrf-copy-test'
const TOKEN = 'DO_NOT_RENDER_ENROLL_TOKEN_<secret>&'
const LAST_HUB: MembershipLastHub = {
  relayUrl: 'wss://entry.dsh.test:30809',
  slug: 'remote-work-pc',
  browserAuthority: 'remote-work-pc.dsh.test',
  joinedAt: Date.UTC(2026, 8, 14, 16, 50),
}
const HUB: MembershipHub = { ...LAST_HUB, enrollToken: TOKEN }
const SELF: MembershipHub = {
  relayUrl: 'ws://127.0.0.1:30809',
  slug: MACHINE,
  browserAuthority: '127.0.0.1:30809',
  joinedAt: HUB.joinedAt,
  selfManaged: true,
  enrollToken: TOKEN,
}

function render(view: MembershipView, options: Partial<Parameters<typeof hubPage>[0]> = {}): string {
  return hubPage({
    view, machine: MACHINE, csrf: CSRF, username: 'admin',
    appearance: { theme: 'light', returnTo: ADMIN_HUB_PATH }, ...options,
  })
}

/** 只检查默认可见的页面内容，避免样式文本和折叠详情干扰文案断言。 */
function visible(html: string): string {
  return html
    .replaceAll(/<head>[\s\S]*?<\/head>/gu, '')
    .replaceAll(/<details\b[^>]*>[\s\S]*?<\/details>/gu, '')
}

function text(html: string): string {
  return html.replaceAll(/<[^>]*>/gu, ' ').replaceAll(/\s+/gu, ' ').trim()
}

function formAt(html: string, action: string): string {
  const form = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gu)]
    .map(match => match[0]).find(value => value.includes(`action="${action}"`))
  expect(form, `missing form for ${action}`).toBeDefined()
  return form ?? ''
}

function expectPostForm(html: string, action: string, csrf: string): string {
  const form = formAt(html, action)
  expect(form).toMatch(/^<form\b[^>]*method="post"/u)
  expect(form).toContain(`<input type="hidden" name="csrf" value="${csrf}">`)
  expect(form).toMatch(/<button\b[^>]*type="submit"/u)
  return form
}

function restartCard(html: string): string {
  const card = html.match(/<div class="restart"[^>]*>[\s\S]*?<\/div>/u)?.[0]
  expect(card).toBeDefined()
  return card ?? ''
}

describe('远程入口的默认设置视图', () => {
  it.each<MembershipView>([{ kind: 'none' }, { kind: 'self', hub: SELF }])(
    '$kind 只显示未配置状态，不提供取消系统条目的操作', (view) => {
      const html = render(view)
      const main = visible(html)
      expect(main).toMatch(/未设置远程入口/u)
      expect(main).not.toContain('class="restart"')
      expect(main).not.toMatch(/挂在|自挂|selfManaged|系统维护/u)
      expect(main).not.toContain(`href="${ADMIN_MEMBERSHIP_LEAVE_PATH}"`)
      expect(main).not.toContain(`action="${ADMIN_MEMBERSHIP_LEAVE_PATH}"`)
      expect(main).not.toContain(`action="${ADMIN_MEMBERSHIP_RECONNECT_PATH}"`)
      expect(html).not.toContain('DO_NOT_RENDER_ENROLL_TOKEN')
      const intro = text(html.match(/<p class="intro">([\s\S]*?)<\/p>/u)?.[1] ?? '')
      expect(intro).toBe('通过其他机器访问本机，同时仅使用一个远程入口。')
      expect(html).toContain('<p class="eyebrow">当前机器：work-pc</p>')
      expect(intro.length).toBeLessThan(80)
    },
  )

  it.each(['light', 'dark'] as const)('%s 主题保留完整表单约束，重启警告在提交按钮之前', (theme) => {
    const html = render({ kind: 'none' }, { appearance: { theme } })
    const form = expectPostForm(html, ADMIN_MEMBERSHIP_JOIN_PATH, CSRF)
    expect(html).toContain(`data-theme="${theme}"`)
    expect(form).toContain('<label for="hubCommand">连接命令</label>')
    const input = form.match(/<input\b[^>]*id="hubCommand"[^>]*>/u)?.[0] ?? ''
    for (const attribute of [
      'name="command"', 'required', 'maxlength="2048"', 'autocapitalize="none"',
      'autocorrect="off"', 'spellcheck="false"', 'autocomplete="off"',
    ]) expect(input).toContain(attribute)
    expect(input).not.toMatch(/\bvalue=/u)
    const beforeSubmit = text(form.split('<button')[0] ?? '')
    expect(beforeSubmit).toMatch(/自动重启 dsh/u)
    expect(beforeSubmit).toMatch(/本机.*远程.*短暂中断/u)
    expect(text(visible(html))).toMatch(/入口机器的「机器」页.*连接命令/u)
    expect([...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)].map(match => match[1])).toEqual([ADMIN_THEME_SCRIPT])
  })

  it('已设置不等于已连接，地址与机器名可见，低频字段折叠且不含令牌', () => {
    const html = render({ kind: 'joined', hub: HUB })
    const main = visible(html)
    expect(main).toMatch(/已设置远程入口/u)
    expect(main).not.toMatch(/已连接|连接成功|远程访问可用/u)
    expect(main).toContain(HUB.relayUrl)
    expect(main).toContain(HUB.slug)
    expect(main).not.toContain(HUB.browserAuthority)
    expect(main).not.toContain('2026-09-14 16:50 UTC')
    expect(main).not.toContain('注册令牌')
    expect(html).toContain(HUB.browserAuthority)
    expect(html).toContain('2026-09-14 16:50 UTC')
    expect(html).toMatch(/注册令牌.*已保存/u)
    expect(html).not.toContain('DO_NOT_RENDER_ENROLL_TOKEN')
    expect(html).toMatch(/<details class="details"><summary>详细信息<\/summary><p class="meta">/u)
    expect(html).not.toMatch(/<details\b[^>]*\bopen/u)
    expect(main).toContain(`href="${ADMIN_MEMBERSHIP_LEAVE_PATH}"`)
    expect(main).not.toContain(`action="${ADMIN_MEMBERSHIP_LEAVE_PATH}"`)
  })

  it('缺少浏览器地址时，恢复指引不能藏在详情中', () => {
    const { browserAuthority: _authority, enrollToken: _token, ...incomplete } = HUB
    const html = render({ kind: 'joined', hub: incomplete })
    const main = text(visible(html))
    expect(main).toMatch(/缺少浏览器地址.*远程访问.*不可用/u)
    expect(main).toMatch(/入口机器的「机器」页.*新令牌.*完整连接命令/u)
    expect(html).toMatch(/注册令牌.*未保存/u)
  })

  it.each<MembershipView>([
    { kind: 'none', lastHub: LAST_HUB },
    { kind: 'self', hub: SELF, lastHub: LAST_HUB },
  ])('$kind 的上次入口保留可识别信息、POST 重连和被移除后的恢复指引', (view) => {
    const html = render(view)
    const main = visible(html)
    expect(main).toContain(LAST_HUB.relayUrl)
    expect(main).toContain(LAST_HUB.slug)
    expect(main).not.toContain(LAST_HUB.browserAuthority)
    expect(main).not.toContain('2026-09-14 16:50 UTC')
    expect(text(main)).toMatch(/重连无需新令牌/u)
    expect(text(main)).toMatch(/停止并移除.*work-pc.*「机器」页.*新令牌.*连接命令/u)
    const form = expectPostForm(html, ADMIN_MEMBERSHIP_RECONNECT_PATH, CSRF)
    expect(text(form.split('<button')[0] ?? '')).toMatch(/自动重启 dsh.*短暂中断/u)
    expect(html).not.toContain('DO_NOT_RENDER_ENROLL_TOKEN')
  })

  it('读取失败不推断连接状态，保留原错误详情及清空确认入口', () => {
    const message = 'permission denied <unsafe>&"source"'
    const html = render({ kind: 'unreadable', message })
    const main = visible(html)
    expect(text(main)).toMatch(/配置读取失败/u)
    expect(text(main)).toMatch(/修复 membership\.json.*刷新.*清空.*重新设置/u)
    expect(text(main)).not.toMatch(/未设置远程入口|没有远程入口|已断开|已连接/u)
    expect(main).not.toContain('permission denied')
    expect(html).toContain('permission denied &lt;unsafe&gt;&amp;&quot;source&quot;')
    expect(html).not.toContain(message)
    expect(main).toContain(`href="${ADMIN_MEMBERSHIP_LEAVE_PATH}"`)
    expect(main).not.toContain(`action="${ADMIN_MEMBERSHIP_LEAVE_PATH}"`)
  })
})

describe('重启与提交反馈不代替远程连接状态', () => {
  const base = { at: HUB.joinedAt, added: ['new-entry.test'], removed: ['old-entry.test'] }

  it.each<DshRestartStatus['state']>(['restarting', 'failed', 'done'])('%s 的技术信息按需展开', (state) => {
    const html = render({ kind: 'joined', hub: HUB }, {
      restartStatus: { ...base, state, error: 'startup <failure>&"reason"' },
    })
    const card = restartCard(html)
    const main = visible(card)
    expect(card).toContain(`data-state="${state}"`)
    expect(main).not.toMatch(/new-entry\.test|old-entry\.test|2026-09-14|startup/u)
    expect(card).toContain('新增信任 new-entry.test')
    expect(card).toContain('移除信任 old-entry.test')
    expect(card).toContain('2026-09-14 16:50 UTC')
    if (state === 'restarting') {
      expect(main).toContain('role="status"')
      expect(text(main)).toMatch(/正在.*重启 dsh.*本机.*远程.*短暂中断.*刷新/u)
    } else if (state === 'failed') {
      expect(main).toContain('role="alert"')
      expect(text(main)).toMatch(/重启 dsh 失败.*退出并重新打开工作站/u)
      expect(card).not.toMatch(/右键|托盘|启动脚本/u)
      expect(card).toContain('startup &lt;failure&gt;&amp;&quot;reason&quot;')
      expect(card).not.toContain('startup <failure>')
    } else {
      expect(text(main)).toMatch(/^dsh 已重启$/u)
      expect(main).not.toMatch(/已连接|连接成功|自动重连|可用/u)
    }
  })

  it.each(['leave', 'reconnect'] as const)('%s 的提交提示明确等待实际处理结果', (done) => {
    const html = render({ kind: 'none' }, { done })
    const notice = html.match(/<p class="notice"[^>]*>[\s\S]*?<\/p>/u)?.[0] ?? ''
    expect(notice).toContain('role="status"')
    expect(text(notice)).toMatch(/已提交.*work-pc.*dsh 将自动重启.*刷新/u)
    expect(text(notice)).not.toMatch(/已连接|已取消|连接成功|正在拨|正在断开/u)
    if (done === 'reconnect') expect(text(notice)).toMatch(/连接结果尚待确认/u)
    expect(render({ kind: 'none' })).not.toContain('class="notice"')
  })

  it('所有动态文本和表单属性保持转义，详情不会扩大令牌暴露面', () => {
    const raw = '<b data-x="quoted">&\'raw\'</b>'
    const escaped = '&lt;b data-x=&quot;quoted&quot;&gt;&amp;&#39;raw&#39;&lt;/b&gt;'
    const html = render({ kind: 'joined', hub: {
      ...HUB, relayUrl: `relay-${raw}`, slug: `slug-${raw}`, browserAuthority: `authority-${raw}`,
    } }, {
      machine: `machine-${raw}`, username: `user-${raw}`, csrf: `csrf-${raw}`,
      error: `form-${raw}`, done: 'reconnect',
      restartStatus: { ...base, state: 'failed', added: [raw], removed: [raw], error: raw },
    })
    expect(html).not.toContain(raw)
    expect(html).not.toContain('DO_NOT_RENDER_ENROLL_TOKEN')
    for (const prefix of ['relay-', 'slug-', 'authority-', 'machine-', 'user-', 'csrf-', 'form-']) {
      expect(html).toContain(`${prefix}${escaped}`)
    }
    expect(html).toContain(`新增信任 ${escaped}`)
    expect(html).toContain(`移除信任 ${escaped}`)
    expectPostForm(html, ADMIN_MEMBERSHIP_JOIN_PATH, `csrf-${escaped}`)
    const reconnect = render({ kind: 'none', lastHub: {
      ...LAST_HUB, relayUrl: raw, slug: raw, browserAuthority: raw,
    } }, { machine: raw, csrf: raw })
    expect(reconnect).not.toContain(raw)
    expectPostForm(reconnect, ADMIN_MEMBERSHIP_RECONNECT_PATH, escaped)
  })
})

interface Fixture extends AuthenticatedRelayTestFixture {
  home: string
  membershipPath: string
}
const fixtures: Fixture[] = []
const HOST = 'pc1.dsh.test'

async function fixtureWith(raw: string): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hub-copy-'))
  const base = await startAuthenticatedRelayFixture({
    jwtSecret: new Uint8Array(32).fill(0x56),
    account: { kind: 'existing-user', input: {
      id: 'hub-copy-user', username: 'admin', passwordHash: 'test-hash',
      totpSecret: 'test-secret', totpEnabled: true,
    } },
    relay: { home },
  })
  const fixture = { ...base, home, membershipPath: join(home, MEMBERSHIP_FILE_NAME) }
  fixtures.push(fixture)
  writeFileSync(fixture.membershipPath, raw, 'utf8')
  return fixture
}

afterEach(async () => {
  await closeFixtures(fixtures, {
    afterStoreClose: fixture => rmSync(fixture.home, { recursive: true, force: true }),
  })
})

describe('取消确认页保留必要后果与 GET → POST 边界', () => {
  it.each(['joined', 'unreadable'] as const)('%s 的 GET 不写配置，确认 POST 仍需 CSRF', async (kind) => {
    const raw = kind === 'joined' ? JSON.stringify({ version: 1, hub: HUB }) : '{ invalid membership'
    const fixture = await fixtureWith(raw)
    const confirm = await openCsrfPage(fixture, { path: ADMIN_MEMBERSHIP_LEAVE_PATH, host: HOST })
    expect(confirm.status).toBe(200)
    const main = text(visible(confirm.body))
    expect(main).toMatch(/dsh 会自动重启.*短暂中断/u)
    expect(main).toMatch(/重启后.*本机.*局域网地址/u)
    expect(main).toMatch(/通过.*开放的其他机器不受影响/u)
    expect(main).not.toMatch(/不受影响，仍然可以|一台都不会掉线/u)
    if (kind === 'joined') {
      expect(main).toContain(HUB.relayUrl)
      expect(main).toMatch(/无法再通过/u)
      expect(main).toMatch(/重新连接.*「机器」页.*请求上线/u)
    } else {
      expect(main).toMatch(/损坏的 membership\.json 将被清空/u)
      expect(main).toMatch(/远程入口设置会被移除/u)
    }
    expectPostForm(confirm.body, ADMIN_MEMBERSHIP_LEAVE_PATH, confirm.csrf)
    expect(confirm.body).not.toContain('DO_NOT_RENDER_ENROLL_TOKEN')
    expect(readFileSync(fixture.membershipPath, 'utf8')).toBe(raw)
    const post = (csrf: string) => postCsrfForm(fixture, {
      path: ADMIN_MEMBERSHIP_LEAVE_PATH, host: HOST, origin: `https://${HOST}`,
      sessionCookie: fixture.sessionCookie, csrfPair: confirm.csrfPair, fields: { csrf },
    })
    const forged = await post('wrong-token')
    expect(forged.status).toBe(403)
    expect(readFileSync(fixture.membershipPath, 'utf8')).toBe(raw)
    const accepted = await post(confirm.csrf)
    expect(accepted.status).toBe(303)
    expect(accepted.headers.location).toBe(`${ADMIN_HUB_PATH}?done=leave`)
    const saved = parseMembership(readFileSync(fixture.membershipPath, 'utf8'))
    expect(saved?.hub).toBeUndefined()
    expect(saved?.lastHub).toEqual(kind === 'joined' ? LAST_HUB : undefined)
  })

  it('self 的 GET 和 POST 都不能取消系统条目', async () => {
    const raw = JSON.stringify({ version: 1, hub: SELF })
    const fixture = await fixtureWith(raw)
    const confirm = await openAuthenticatedPage(fixture, { path: ADMIN_MEMBERSHIP_LEAVE_PATH, host: HOST })
    expect(confirm.status).toBe(303)
    expect(confirm.headers.location).toBe(ADMIN_HUB_PATH)
    const page = await openCsrfPage(fixture, { path: ADMIN_HUB_PATH, host: HOST })
    const response = await postCsrfForm(fixture, {
      path: ADMIN_MEMBERSHIP_LEAVE_PATH, host: HOST, origin: `https://${HOST}`,
      sessionCookie: fixture.sessionCookie, csrfPair: page.csrfPair, fields: { csrf: page.csrf },
    })
    expect(response.status).toBe(303)
    expect(readFileSync(fixture.membershipPath, 'utf8')).toBe(raw)
  })

  it('确认页转义入口地址，拒绝的命令不回显原始值或令牌', async () => {
    const relayUrl = 'wss://entry.dsh.test/?label=<b>&name="remote"'
    const raw = JSON.stringify({ version: 1, hub: { ...HUB, relayUrl } })
    const fixture = await fixtureWith(raw)
    const confirm = await openCsrfPage(fixture, { path: ADMIN_MEMBERSHIP_LEAVE_PATH, host: HOST })
    expect(confirm.status).toBe(200)
    expect(confirm.body).not.toContain(relayUrl)
    expect(confirm.body).toContain('wss://entry.dsh.test/?label=&lt;b&gt;&amp;name=&quot;remote&quot;')
    const command = `dsh-station-connector --relay ${HUB.relayUrl} --slug '<b>bad</b>' --enroll-token '${TOKEN}'`
    const rejected = await postCsrfForm(fixture, {
      path: ADMIN_MEMBERSHIP_JOIN_PATH, host: HOST, origin: `https://${HOST}`,
      sessionCookie: fixture.sessionCookie, csrfPair: confirm.csrfPair,
      fields: { csrf: confirm.csrf, command },
    })
    expect(rejected.status).toBe(400)
    expect(text(visible(rejected.body))).toMatch(/DNS 标签.*本次设置未保存/u)
    expect(rejected.body).not.toContain('DO_NOT_RENDER_ENROLL_TOKEN')
    expect(rejected.body).not.toContain('<b>bad</b>')
    expect(rejected.body).not.toContain('&lt;b&gt;bad&lt;/b&gt;')
    expect(readFileSync(fixture.membershipPath, 'utf8')).toBe(raw)
  })
})
