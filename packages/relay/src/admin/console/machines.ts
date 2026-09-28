import type { RelayConfig } from '../../config.js'
import { PROBE_INTERVAL_MS } from '@dsh-station/protocol'
import {
  ENROLL_TOKEN_SHOWN_ONCE_NOTICE,
  ENROLL_TOKEN_SINGLE_USE_NOTICE,
  ENROLL_TOKEN_TTL_MINUTES,
} from '../../store/enroll-token.js'
import type { DeviceRecord } from '../../store/types.js'
import { escapeHtml, type PageAppearance } from '../shared.js'
import {
  ADMIN_PATH_PREFIX,
  ADMIN_REVOKE_PATH,
  ADMIN_TOKEN_CREATE_PATH,
  ADMIN_WAKEUP_PATH,
  consolePage,
  formatTime,
} from './shell.js'

/** 刚签发的令牌，只渲染一次，之后无法找回。 */
export interface IssuedTokenView {
  readonly token: string
  readonly slug: string
}

/** 操作员实际使用的 Host，不含端口。 */
function consoleHostname(host: string | undefined): string | undefined {
  if (host === undefined) return undefined
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return undefined
  }
}

/**
 * 浏览器访问这台机器 dsh UI 的地址；当前部署没有到它的路由时为 undefined
 * （没有子域名、没有已分配成员端口，且它不是提供此控制台的机器）。
 */
function machineEntryUrl(options: {
  device: DeviceRecord
  config: RelayConfig
  hostname: string | undefined
}): string | undefined {
  const { device, config, hostname } = options
  if (config.publicDomain !== undefined) {
    return `${config.publicScheme}://${device.slug}.${config.publicDomain}/`
  }
  if (config.directSlug === device.slug) return '/'
  // D16 路由键 2：同一主机、机器自己的端口。
  if (hostname === undefined || device.browserPort === null) return undefined
  return `${config.publicScheme}://${hostname}:${String(device.browserPort)}/`
}

/**
 * 浏览器会放入发往即将挂接机器的请求 `Host` header 中的 authority。
 *
 * 模式 A 原样转发该 Host（铁律 7），因此它正是另一台机器的 dsh 必须信任的值。
 * 这里直接推导而不是让操作员手动输入，因为控制台已经知道它：使用公网域名时
 * 机器有自己的子域名，否则通过当前主机上的每机器端口访问——而不带端口的
 * `--trusted-host` 条目匹配任意端口，所以在端口分配前也能打印此值。
 * @param options 机器的 slug、relay 配置以及操作员查看此控制台时使用的 hostname。
 * @returns 要信任的裸 `host`；请求没有携带可用 Host 可供推导时返回 undefined。
 */
function hubBrowserAuthority(options: {
  slug: string
  config: RelayConfig
  hostname: string | undefined
}): string | undefined {
  const { slug, config, hostname } = options
  if (config.publicDomain !== undefined) return `${slug}.${config.publicDomain}`
  return hostname
}

/**
 * 「已断开·可唤醒」状态的判定窗口：最近一次唤醒探测距今不超过
 * 三个探测周期，就认为那台机器的服务还在运行、只是断开了远程入口。
 */
export const PROBE_FRESH_MS = 3 * PROBE_INTERVAL_MS

/** 机器在列表页上的可达状态。 */
type Presence = 'online' | 'idle' | 'offline'

function machineItem(options: {
  device: DeviceRecord
  online: boolean
  probedAt: number | undefined
  now: number
  csrf: string
  config: RelayConfig
  hostname: string | undefined
}): string {
  const { device, online, probedAt, now, csrf, config, hostname } = options
  const revoked = device.revokedAt !== null
  // 本机（directSlug）就是运行这个控制台的机器：停止并移除它会
  // 杀掉它自己的 dsh-station，这个操作没有意义，也不提供入口。
  const self = device.slug === config.directSlug
  const presence: Presence = online
    ? 'online'
    : probedAt !== undefined && now - probedAt <= PROBE_FRESH_MS
      ? 'idle'
      : 'offline'
  const localBadge = self ? '<span class="badge local">本机</span>' : ''
  const badge = revoked
    ? '<span class="badge gone">已移除</span>'
    : presence === 'online'
      ? `<span class="badge on">在线</span>${localBadge}`
      : presence === 'idle'
        ? `<span class="badge idle">已断开 · 可唤醒</span>${localBadge}`
        : `<span class="badge off">离线</span>${localBadge}`
  const entry = revoked ? undefined : machineEntryUrl({ device, config, hostname })
  const link = entry === undefined || presence !== 'online'
    ? ''
    : `<a class="open" href="${escapeHtml(entry)}">打开 ${escapeHtml(device.slug)}</a>`
  // 「请求上线」对断开的机器立即生效（约一个探测周期内连回），对真正
  // 离线的机器保留等待它回来；两种都值得提供，徽标已经说明区别。
  const wakeup = revoked || self || presence === 'online'
    ? ''
    : `<form method="post" action="${ADMIN_WAKEUP_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<input type="hidden" name="machineId" value="${escapeHtml(device.machineId)}">
<button type="submit">请求 ${escapeHtml(device.slug)} 上线</button></form>`
  // 使用链接而不是提交按钮：吊销无法从它所影响的机器上撤销，
  // 因此要经过同一路径在 GET 上提供的确认页面。离线的机器收不到
  // 任何消息——不能宣称「停止」一台连不上的机器，只移除它的设备身份。
  const revokeLabel = presence === 'online'
    ? `停止 ${escapeHtml(device.slug)} 并移除…`
    : `移除 ${escapeHtml(device.slug)}…`
  const action = self || revoked
    ? ''
    : `<a class="danger-link" href="${ADMIN_REVOKE_PATH}?machineId=${encodeURIComponent(device.machineId)}">${revokeLabel}</a>`
  const wakeupHint = wakeup === ''
    ? ''
    : `<p class="hint">${presence === 'idle'
      ? '重连通常需约一分钟，请求保留 24 小时。'
      : '请求保留 24 小时；无法唤醒已关机的机器。'}</p>`
  const address = revoked || entry === undefined || entry === '/'
    ? ''
    : `<br>访问地址 ${escapeHtml(entry)}`
  return `<li class="machine">
<h2>${escapeHtml(device.slug)}${badge}</h2>
${link || wakeup || action ? `<div class="actions">${link}${wakeup}${action}</div>` : ''}
${wakeupHint}
<details class="details"><summary>详细信息</summary><p class="meta">机器 ID ${escapeHtml(device.machineId)}<br>注册于 ${escapeHtml(formatTime(device.createdAt))}<br>更新于 ${escapeHtml(formatTime(device.updatedAt))}${address}</p></details>
</li>`
}

/**
 * 用于将要挂接到这台机器上的机器的 connector 调用命令。
 * 地址就是操作员查看此页面时使用的 authority，因此即使机器位于 NAT 后或 DHCP 租约
 * 不断变化，也能打印出可用的内容。
 *
 * 另一台机器所需的一切都在这一行中——包括 `--hub-authority`，因此模式 A 不会留下
 * 任何内容让操作员在另一端手动填写。
 */
function connectorCommand(options: {
  host: string | undefined
  scheme: 'http' | 'https'
  slug: string
  token: string
  hubAuthority: string | undefined
}): string {
  const authority = options.host ?? '<relay-host>:30809'
  const wsScheme = options.scheme === 'https' ? 'wss' : 'ws'
  // 未知时省略而不是猜测：占位符会被写入另一台机器的 membership.json，
  // 导致其 dsh 无法启动。
  const trust = options.hubAuthority === undefined ? '' : ` --hub-authority ${options.hubAuthority}`
  return `dsh-station-connector --relay ${wsScheme}://${authority} --slug ${options.slug} --enroll-token ${options.token}${trust}`
}

function tokenPanel(options: {
  issued: IssuedTokenView
  host: string | undefined
  config: RelayConfig
}): string {
  const { issued, host, config } = options
  const command = connectorCommand({
    // 域名模式下本机管理页可能从 127.0.0.1 打开，但目标机器必须拨到公网入口；
    // 不把本机请求的 Host 当成 connector 的可达地址。
    host: config.publicDomain ?? host,
    scheme: config.publicScheme,
    slug: issued.slug,
    token: issued.token,
    hubAuthority: hubBrowserAuthority({
      slug: issued.slug,
      config,
      hostname: consoleHostname(host),
    }),
  })
  return `<section class="token">
<h2>连接 ${escapeHtml(issued.slug)}</h2>
<p class="warn">${escapeHtml(ENROLL_TOKEN_SHOWN_ONCE_NOTICE)}</p>
<p class="warn">在 ${escapeHtml(issued.slug)} 的「远程入口」页粘贴完整连接命令：</p>
<p class="cmd">${escapeHtml(command)}</p>
<p class="meta">${escapeHtml(ENROLL_TOKEN_SINGLE_USE_NOTICE)}</p>
<details class="details"><summary>原始令牌</summary><p class="secret">${escapeHtml(issued.token)}</p></details>
</section>`
}

function issueForm(options: { csrf: string; error: string | undefined }): string {
  const { csrf } = options
  const alert = options.error === undefined
    ? ''
    : `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
  return `<h2 class="section">添加机器</h2>
<p class="hint">生成连接命令，在对方的「远程入口」页粘贴；令牌 ${String(ENROLL_TOKEN_TTL_MINUTES)} 分钟内有效。</p>${alert}
<form method="post" action="${ADMIN_TOKEN_CREATE_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<div class="field"><label for="slug">机器名（如 pc2）</label><input id="slug" name="slug" required maxlength="63" pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" autocapitalize="none" autocorrect="off" spellcheck="false"></div>
<div class="field"><label for="name">显示名称（可选）</label><input id="name" name="name" maxlength="64"></div>
<button type="submit">生成令牌</button></form>`
}

/**
 * 控制台默认页面：可以从这里打开 dsh 的所有机器。
 * @param options store 中的设备、哪些设备拥有活动控制信道、表单携带的 CSRF token、
 * relay 配置和请求 Host（共同决定每台机器的浏览器地址）、这台机器自己的名称、
 * 登录用户、要渲染的外观、刚签发的令牌以及签发被拒绝时的错误。
 * @returns 完整的 HTML 文档。
 */
export function machinesPage(options: {
  devices: readonly DeviceRecord[]
  online: ReadonlySet<string>
  /** 每台机器最近一次唤醒探测的时间（unix 毫秒），用于区分「已断开·可唤醒」与「离线」。 */
  probes: ReadonlyMap<string, number>
  csrf: string
  config: RelayConfig
  machine: string
  username: string | null
  host: string | undefined
  appearance: PageAppearance
  issued?: IssuedTokenView
  error?: string
}): string {
  const { devices, online, probes, csrf, config, machine, host } = options
  const hostname = consoleHostname(host)
  const now = Date.now()
  const active = devices.filter(device => device.revokedAt === null)
  const onlineCount = active.filter(device => online.has(device.machineId)).length
  const list = devices.length === 0
    ? '<p class="empty">暂无机器</p>'
    : `<ul class="machines">${devices
      .map(device => machineItem({
        device,
        online: online.has(device.machineId),
        probedAt: probes.get(device.machineId),
        now,
        csrf,
        config,
        hostname,
      }))
      .join('')}</ul>`
  const panel = options.issued === undefined
    ? ''
    : tokenPanel({ issued: options.issued, host, config })
  return consolePage({
    current: ADMIN_PATH_PREFIX,
    machine,
    title: '机器',
    heading: '机器',
    intro: `${String(onlineCount)} / ${String(active.length)} 台在线`,
    username: options.username,
    appearance: options.appearance,
    body: `${panel}
<h2 class="section">工作站列表</h2>
${list}
${issueForm({ csrf, error: options.error })}`,
  })
}
