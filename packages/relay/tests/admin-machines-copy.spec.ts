import { ADMIN_THEME_SCRIPT } from '../src/admin/theme-client.js'
import { afterEach, describe, expect, it } from 'vitest'
import { machinesPage, PROBE_FRESH_MS } from '../src/admin/console/machines.js'
import {
  ADMIN_PATH_PREFIX,
  ADMIN_REVOKE_PATH,
  ADMIN_TOKEN_CREATE_PATH,
  ADMIN_WAKEUP_PATH,
} from '../src/admin/console/shell.js'
import { ADMIN_CSP } from '../src/admin/shared.js'
import { resolveRelayConfig } from '../src/config.js'
import { ICON_SVG } from '../src/icons.js'
import {
  ENROLL_TOKEN_SHOWN_ONCE_NOTICE,
  ENROLL_TOKEN_SINGLE_USE_NOTICE,
  ENROLL_TOKEN_TTL_MINUTES,
} from '../src/store/enroll-token.js'
import type { DeviceRecord } from '../src/store/types.js'
import {
  closeFixtures,
  openCsrfPage,
  postCsrfForm,
  startAuthenticatedRelayFixture,
  type AuthenticatedRelayTestFixture,
} from './helpers.js'

const CONFIG = resolveRelayConfig({ publicDomain: 'dsh.test', directSlug: 'pc1' })
const TIME = Date.UTC(2026, 0, 1)
const HOST = 'pc1.dsh.test'
const fixtures: AuthenticatedRelayTestFixture[] = []

function device(slug: string, overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    slug,
    machineId: `id-${slug}`,
    displayName: null,
    publicKey: 'test-key',
    browserPort: null,
    revokedAt: null,
    wakeupRequestedAt: null,
    createdAt: TIME,
    updatedAt: TIME + 60_000,
    ...overrides,
  }
}

function render(overrides: Partial<Parameters<typeof machinesPage>[0]> = {}): string {
  return machinesPage({
    devices: [],
    online: new Set(),
    probes: new Map(),
    csrf: 'test-csrf',
    config: CONFIG,
    machine: 'pc1',
    username: 'admin',
    host: HOST,
    appearance: { theme: 'light', returnTo: ADMIN_PATH_PREFIX },
    ...overrides,
  })
}

/** 折叠区域的内容不应挤占默认页面；链接和表单仍保留在外层。 */
function outsideDetails(html: string): string {
  return html.replaceAll(/<details\b[^>]*>[\s\S]*?<\/details>/g, '')
}

function cards(html: string): string[] {
  return [...html.matchAll(/<li class="machine">[\s\S]*?<\/li>/g)].map(match => match[0])
}

afterEach(async () => {
  await closeFixtures(fixtures, { beforeRelayClose: fixture => fixture.connector?.close() })
})

describe('concise machine page', () => {
  it('keeps the heading short and machine metadata collapsed without repeating explanations', () => {
    const html = render({
      devices: [device('pc1'), device('pc2'), device('retired', { revokedAt: TIME })],
      online: new Set(['id-pc1', 'id-pc2', 'id-retired']),
    })
    expect(html).toContain('<h1>机器</h1>')
    expect(html).toContain('<p class="intro">2 / 2 台在线</p>')
    expect(html.match(/<h2 class="section">工作站列表<\/h2>/g)).toHaveLength(1)
    expect(html).not.toContain('通过 pc1 开放的机器')
    expect(html).toContain('<p class="eyebrow">当前机器：pc1</p>')
    expect(html).toContain('<h2 class="section">添加机器</h2>')
    expect(html).not.toContain('每台机器都跑着自己的 dsh')
    expect(html).not.toContain('这些机器把自己挂在')
    expect(html).not.toContain('像短信验证码一样')
    expect(html).not.toMatch(/<details\b[^>]*\bopen\b/)
    expect(html.match(/<summary>详细信息<\/summary>/g)).toHaveLength(3)

    for (const card of cards(html)) {
      expect(card).toMatch(/<details class="details"><summary>详细信息<\/summary><p class="meta">机器 ID /)
      const visible = outsideDetails(card)
      expect(visible.replaceAll(/<[^>]+>/g, '')).not.toContain('机器 ID')
      expect(visible).not.toContain('注册于')
      expect(visible).not.toContain('更新于')
      expect(visible).not.toContain('访问地址')
      expect(visible).not.toContain('<p ')
    }
    const remote = cards(html)[1]
    expect(remote).toContain('href="https://pc2.dsh.test/">打开 pc2</a>')
    expect(remote).toContain(`href="${ADMIN_REVOKE_PATH}?machineId=id-pc2"`)
    expect(remote).toContain('2026-01-01 00:00 UTC')
    expect(remote).toContain('2026-01-01 00:01 UTC')
    expect(remote).not.toContain(`<form method="post" action="${ADMIN_REVOKE_PATH}">`)
    expect(cards(html)[0]).toContain('<span class="badge local">本机</span>')
    expect(cards(html)[0]).not.toContain(ADMIN_REVOKE_PATH)
    expect(cards(html)[0]).not.toContain('本机运行着这个控制台')
    expect(cards(html)[2]).toContain('已移除')
    expect(cards(html)[2]).not.toContain('href=')
    expect(cards(html)[2]).not.toContain('<form')
  })

  it.each(['light', 'dark'] as const)('uses whale blue only for local identity in %s theme', (theme) => {
    const whaleBlue = ICON_SVG.match(/<path\b[^>]*\bfill="([^"]+)"/u)?.[1]
    expect(whaleBlue).toBe('#4D6BFE')
    for (const state of ['on', 'idle', 'off']) {
      const ids = ['id-pc1', 'id-pc2']
      const html = render({
        devices: [device('pc1'), device('pc2')],
        online: new Set(state === 'on' ? ids : []),
        probes: new Map(state === 'idle' ? ids.map(id => [id, Date.now()]) : []),
        appearance: { theme },
      })
      const [local, remote] = cards(html)
      expect(local).toContain('<span class="badge local">本机</span>')
      expect(remote).not.toContain('badge local')
      expect(local).toContain(`class="badge ${state}"`)
      expect(remote).toContain(`class="badge ${state}"`)
      expect(html).toContain(`.badge.local:before{background:${whaleBlue}}`)
      expect(html).toContain('.badge.on:before{background:var(--success)}')
      expect(html).toContain('.badge.idle:before{background:var(--warn)}')
      expect(html).toContain('.badge.gone:before{background:var(--danger)}')
    }
  })

  it('keeps enrollment form fields and browser validation intact', () => {
    const html = render()
    expect(html).toContain('<p class="empty">暂无机器</p>')
    expect(html).toContain(`<form method="post" action="${ADMIN_TOKEN_CREATE_PATH}">`)
    expect(html).toContain('<input type="hidden" name="csrf" value="test-csrf">')
    expect(html).toContain('<label for="slug">机器名（如 pc2）</label>')
    expect(html).toContain('<input id="slug" name="slug" required maxlength="63" pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" autocapitalize="none" autocorrect="off" spellcheck="false">')
    expect(html).toContain('<input id="name" name="name" maxlength="64">')
    expect(html).toContain(`令牌 ${String(ENROLL_TOKEN_TTL_MINUTES)} 分钟内有效`)
    expect(html).not.toContain('class="secret"')
    expect([...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)].map(match => match[1])).toEqual([ADMIN_THEME_SCRIPT])
  })

  it.each([
    { label: 'idle', probeAge: 1_000, badge: '已断开 · 可唤醒', hint: '重连通常需约一分钟，请求保留 24 小时。' },
    { label: 'offline', probeAge: undefined, badge: '离线', hint: '请求保留 24 小时；无法唤醒已关机的机器。' },
    { label: 'stale probe', probeAge: PROBE_FRESH_MS + 10_000, badge: '离线', hint: '请求保留 24 小时；无法唤醒已关机的机器。' },
  ])('explains the $label wakeup limit beside its unchanged form', ({ probeAge, badge, hint }) => {
    const html = render({
      devices: [device('pc2')],
      probes: probeAge === undefined ? new Map() : new Map([['id-pc2', Date.now() - probeAge]]),
    })
    const visible = outsideDetails(cards(html)[0] ?? '')
    expect(visible).toContain(badge)
    expect(visible).toContain(hint)
    expect(visible).toContain(`<form method="post" action="${ADMIN_WAKEUP_PATH}">`)
    expect(visible).toContain('<input type="hidden" name="csrf" value="test-csrf">')
    expect(visible).toContain('<input type="hidden" name="machineId" value="id-pc2">')
    expect(visible).toContain('<button type="submit">请求 pc2 上线</button>')
    expect(visible).toContain(`href="${ADMIN_REVOKE_PATH}?machineId=id-pc2">移除 pc2…</a>`)
    expect(visible).not.toContain('class="open"')
  })

  it('never adds a wakeup or removal action for an offline local machine', () => {
    const local = cards(render({ devices: [device('pc1')] }))[0]
    expect(local).toContain('离线')
    expect(local).not.toContain(ADMIN_WAKEUP_PATH)
    expect(local).not.toContain(ADMIN_REVOKE_PATH)
  })

  it('escapes names, metadata, error text and hidden fields after moving markup', () => {
    const hostile = '<img src=x onerror="alert(1)">'
    const html = render({
      machine: '<hub&>',
      devices: [device(hostile, { machineId: 'id"&<>' })],
      csrf: 'csrf"&<>',
      error: hostile,
    })
    expect(html).toContain('<h2 class="section">工作站列表</h2>')
    expect(html).toContain('<p class="eyebrow">当前机器：&lt;hub&amp;&gt;</p>')
    expect(html).toContain('<h2>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(html).toContain('机器 ID id&quot;&amp;&lt;&gt;')
    expect(html).toContain('name="machineId" value="id&quot;&amp;&lt;&gt;"')
    expect(html).toContain('name="csrf" value="csrf&quot;&amp;&lt;&gt;"')
    expect(html).toContain(`href="${ADMIN_REVOKE_PATH}?machineId=${encodeURIComponent('id"&<>')}"`)
    expect(html).toContain('<p class="error" role="alert">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>')
    expect(html).not.toContain(hostile)
    expect(html).not.toMatch(/<details\b[^>]*\bopen\b/)
  })

  it('keeps the complete command primary and both mandatory token notices visible', () => {
    const html = render({ host: '127.0.0.1:30809', issued: { slug: 'pc2', token: 'once<token>&"' } })
    const visible = outsideDetails(html)
    const token = 'once&lt;token&gt;&amp;&quot;'
    expect(visible).toContain(`<p class="cmd">dsh-station-connector --relay wss://dsh.test --slug pc2 --enroll-token ${token} --hub-authority pc2.dsh.test</p>`)
    expect(visible).toContain('在 pc2 的「远程入口」页粘贴完整连接命令')
    expect(visible.split(ENROLL_TOKEN_SHOWN_ONCE_NOTICE)).toHaveLength(2)
    expect(visible.split(ENROLL_TOKEN_SINGLE_USE_NOTICE)).toHaveLength(2)
    expect(html).toContain(`<details class="details"><summary>原始令牌</summary><p class="secret">${token}</p></details>`)
    expect(html.match(/<p class="secret">/g)).toHaveLength(1)
    expect(html).not.toMatch(/<details\b[^>]*\bopen\b/)
    expect(html).not.toContain('once<token>')
    expect(render()).not.toContain(token)
  })

  it('preserves local and per-machine port entry links', () => {
    const html = render({
      config: resolveRelayConfig({ directSlug: 'pc1', publicScheme: 'http' }),
      host: '192.168.1.2:30809',
      devices: [device('pc1'), device('pc2', { browserPort: 30810 })],
      online: new Set(['id-pc1', 'id-pc2']),
    })
    expect(html).toContain('href="/">打开 pc1</a>')
    expect(html).toContain('href="http://192.168.1.2:30810/">打开 pc2</a>')
    expect(html).toContain('访问地址 http://192.168.1.2:30810/</p></details>')
  })
})

describe('machine removal confirmation copy', () => {
  it.each([true, false])('preserves safety consequences and GET → POST for online=%s', async (online) => {
    const fixture = await startAuthenticatedRelayFixture({
      jwtSecret: new Uint8Array(32).fill(0x69),
      account: {
        kind: 'existing-user',
        input: {
          id: 'machine-copy-user',
          username: 'admin',
          passwordHash: 'test-password-hash',
          totpSecret: 'test-totp-secret',
          totpEnabled: true,
        },
      },
      device: online
        ? { mode: 'online', machineId: 'id-pc2', slug: 'pc2', upstreamPort: 1 }
        : { mode: 'offline', machineId: 'id-pc2', slug: 'pc2' },
    })
    fixtures.push(fixture)
    const page = await openCsrfPage(fixture, {
      path: `${ADMIN_REVOKE_PATH}?machineId=id-pc2`,
      host: HOST,
    })
    expect(page.status).toBe(200)
    expect(page.headers['content-security-policy']).toBe(ADMIN_CSP)
    expect(page.body).toContain('对话记录保留')
    expect(page.body).toContain('设备凭据和未使用的注册令牌失效')
    expect(page.body).toContain('访问端口关闭')
    expect(page.body).toContain('恢复需新注册令牌')
    if (online) {
      expect(page.body).toContain('<h1>停止 pc2 并移除？</h1>')
      expect(page.body).toContain('停止 pc2 的连接及工作站托管的 dsh')
      expect(page.body).toContain('远程访问及现有连接立即断开')
      expect(page.body).toContain('在 pc2 上重新启动 DSH 工作站')
    } else {
      expect(page.body).toContain('<h1>移除 pc2？</h1>')
      expect(page.body).toContain('当前离线：仅移除设备身份，不停止该机服务')
      expect(page.body).toContain('后续连接和上线探测将被拒绝')
      expect(page.body).not.toContain('工作站将停止')
    }
    expect(page.body).toContain(`<form method="post" action="${ADMIN_REVOKE_PATH}">`)
    expect(page.body).toContain(`<input type="hidden" name="csrf" value="${page.csrf}">`)
    expect(page.body).toContain('<input type="hidden" name="machineId" value="id-pc2">')
    expect(page.body).toContain(`<a href="${ADMIN_PATH_PREFIX}">取消</a>`)
    expect(fixture.store.getDeviceByMachineId('id-pc2')?.revokedAt).toBeNull()
    expect(fixture.relay.tunnel.registry.machines()).toHaveLength(online ? 1 : 0)

    const submitted = await postCsrfForm(fixture, {
      path: ADMIN_REVOKE_PATH,
      host: HOST,
      origin: `https://${HOST}`,
      sessionCookie: fixture.sessionCookie,
      csrfPair: page.csrfPair,
      fields: { csrf: page.csrf, machineId: 'id-pc2' },
    })
    expect(submitted.status).toBe(303)
    expect(submitted.headers.location).toBe(ADMIN_PATH_PREFIX)
    expect(fixture.store.getDeviceByMachineId('id-pc2')?.revokedAt).toBeTypeOf('number')
  })
})
