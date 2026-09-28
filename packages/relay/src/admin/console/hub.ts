import {
  MEMBERSHIP_FILE_NAME,
  type DshRestartStatus,
  type MembershipHub,
  type MembershipLastHub,
} from '@dsh-station/protocol'
import { escapeHtml, type PageAppearance } from '../shared.js'
import {
  ADMIN_HUB_PATH,
  ADMIN_MEMBERSHIP_JOIN_PATH,
  ADMIN_MEMBERSHIP_LEAVE_PATH,
  ADMIN_MEMBERSHIP_RECONNECT_PATH,
  consolePage,
  formatTime,
} from './shell.js'

/** 与 `membershipSchema` 对齐，使拼写错误能以可读消息被捕获。 */
export const MIN_ENROLL_TOKEN_LENGTH = 16

/**
 * 这台机器的远程入口（如果有）。
 *
 * D16 最多允许一个：机器可以通过自己的地址以及最多一个其他机器的地址访问，
 * 不能形成链。`self` 是 relay 维护的自挂条目（见 `membership/self-join.ts`），
 * 它让本机与局域网地址能打开这台机器的 dsh，不是操作员设置的远程入口。
 * `lastHub` 是「取消远程入口」时记住的上次入口，只在未加入/自挂状态下存在，
 * 供「重新连接」一键恢复。
 */
export type MembershipView =
  | { readonly kind: 'none'; readonly lastHub?: MembershipLastHub | undefined }
  | { readonly kind: 'joined'; readonly hub: MembershipHub }
  | { readonly kind: 'self'; readonly hub: MembershipHub; readonly lastHub?: MembershipLastHub | undefined }
  | { readonly kind: 'unreadable'; readonly message: string }

/** 仅支持 ws/wss：connector 向外拨号，从不通过 HTTP 获取。 */
export function isHubRelayUrl(value: string): boolean {
  if (value === '') return false
  try {
    const url = new URL(value)
    return url.protocol === 'ws:' || url.protocol === 'wss:'
  } catch {
    return false
  }
}

/**
 * dsh 的 `--trusted-host` 只接受裸 `host` 或 `host:port`；scheme、路径或末尾冒号
 * 会让 dsh 在加载插件时失败，而不是在请求时失败，远程诊断会困难得多。
 */
export function isBrowserAuthority(value: string): boolean {
  if (value.includes('://') || /[\s/\\?#@]/u.test(value)) return false
  try {
    const url = new URL(`http://${value}`)
    return url.hostname !== '' && url.host.toLowerCase() === value.toLowerCase()
  } catch {
    return false
  }
}

function entryCard(view: MembershipView): string {
  if (view.kind === 'unreadable') {
    return `<div class="hub">
<h3>配置读取失败</h3>
<p class="hint">修复 ${escapeHtml(MEMBERSHIP_FILE_NAME)} 后刷新，或清空损坏配置重新设置。</p>
<details class="details"><summary>详细信息</summary><p class="meta">${escapeHtml(view.message)}</p></details>
<div class="actions"><a class="danger-link" href="${ADMIN_MEMBERSHIP_LEAVE_PATH}">清空损坏配置…</a></div>
</div>`
  }
  if (view.kind === 'none') {
    return '<p class="empty">未设置远程入口</p>'
  }
  if (view.kind === 'self') {
    return `<div class="hub">
<h3>未设置远程入口</h3>
<p class="hint">本机访问无需设置远程入口。</p>
</div>`
  }
  const { hub } = view
  const authority = hub.browserAuthority === undefined
    ? ''
    : `<br>浏览器地址 ${escapeHtml(hub.browserAuthority)}`
  const warning = hub.browserAuthority === undefined
    ? '<p class="hint">缺少浏览器地址，远程访问暂不可用。请到入口机器的「机器」页获取新令牌和完整连接命令。</p>'
    : ''
  // 令牌本身从不渲染，详情也只显示是否保存。
  const token = hub.enrollToken === undefined
    ? '<br>注册令牌 未保存'
    : '<br>注册令牌 已保存（不显示）'
  return `<div class="hub">
<h3>已设置远程入口</h3>
<p class="meta">入口地址 ${escapeHtml(hub.relayUrl)}<br>机器名 ${escapeHtml(hub.slug)}</p>
${warning}<details class="details"><summary>详细信息</summary><p class="meta">设置时间 ${escapeHtml(formatTime(hub.joinedAt))}${authority}${token}</p></details>
<div class="actions"><a class="danger-link" href="${ADMIN_MEMBERSHIP_LEAVE_PATH}">取消远程入口…</a></div>
</div>`
}

/** 把一次信任集合变化写成页面上的半句话，例如「新增信任 hub.example.com」。 */
function describeTrustChange(status: DshRestartStatus): string {
  const parts: string[] = []
  if (status.added.length > 0) parts.push(`新增信任 ${escapeHtml(status.added.join('、'))}`)
  if (status.removed.length > 0) parts.push(`移除信任 ${escapeHtml(status.removed.join('、'))}`)
  return parts.length === 0 ? '地址无变化' : parts.join('，')
}

/**
 * 「重新连接」卡片：取消远程入口时记住的上次入口。
 *
 * 恢复不需要注册令牌——设备密钥仍在两侧，hub 还认识这台机器时直接认证；
 * 对方已「停止并移除」时会失败并回到本页，文案必须说明这条路。
 * @param lastHub membership 记录的上次入口。
 * @param machine 这台机器自己的名称。
 * @param csrf 表单携带的 CSRF token。
 * @returns 置于远程入口条目下方的 markup。
 */
function reconnectCard(lastHub: MembershipLastHub, machine: string, csrf: string): string {
  const name = escapeHtml(machine)
  const authority = lastHub.browserAuthority === undefined
    ? ''
    : `<br>浏览器地址 ${escapeHtml(lastHub.browserAuthority)}`
  return `<div class="hub">
<h3>上次的远程入口</h3>
<p class="meta">入口地址 ${escapeHtml(lastHub.relayUrl)}<br>机器名 ${escapeHtml(lastHub.slug)}</p>
<details class="details"><summary>详细信息</summary><p class="meta">设置时间 ${escapeHtml(formatTime(lastHub.joinedAt))}${authority}</p></details>
<p class="hint">重连无需新令牌；若入口已「停止并移除」${name}，请到入口机器的「机器」页获取新令牌和连接命令。</p>
<form method="post" action="${ADMIN_MEMBERSHIP_RECONNECT_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<p class="hint">重新连接会自动重启 dsh，访问会短暂中断。</p>
<button type="submit">重新连接</button></form>
</div>`
}

/**
 * launcher 自动重启 dsh 的进度卡（见 protocol 的 dsh-restart 契约）。
 *
 * 页面没有脚本，状态不会自己刷新；进行中的文案明确让操作员刷新查看结果，
 * 失败的文案给出手动恢复动作。
 * @param status launcher 写入的最新状态。
 * @param machine 这台机器自己的名称。
 * @returns 置于远程入口条目下方的 markup；调用方仅在状态存在时渲染。
 */
function restartStatusCard(status: DshRestartStatus, machine: string): string {
  const name = escapeHtml(machine)
  const what = describeTrustChange(status)
  const details = `<details class="details"><summary>详细信息</summary><p class="meta">${what}<br>${escapeHtml(formatTime(status.at))}${status.state === 'failed' ? `<br>${escapeHtml(status.error ?? '未知原因')}` : ''}</p></details>`
  if (status.state === 'restarting') {
    return `<div class="restart" data-state="restarting" role="status"><strong>正在自动重启 dsh</strong><p>${name} 的本机和远程访问会短暂中断，请稍后刷新本页查看结果。</p>${details}</div>`
  }
  if (status.state === 'failed') {
    return `<div class="restart" data-state="failed" role="alert"><strong>自动重启 dsh 失败</strong><p>请在 ${name} 上退出并重新打开工作站。</p>${details}</div>`
  }
  return `<div class="restart" data-state="done"><strong>dsh 已重启</strong>${details}</div>`
}

/**
 * 刚完成断开/重连后的「稍后刷新」提示。页面没有脚本，效果要等
 * connector 重连与 dsh 自动重启完成，提示必须把这一点说清楚。
 */
function doneNotice(done: 'leave' | 'reconnect', machine: string): string {
  const name = escapeHtml(machine)
  const text = done === 'leave'
    ? `已提交取消 ${name} 的远程入口。dsh 将自动重启，访问会短暂中断；请稍后刷新本页查看状态。`
    : `已提交重新连接 ${name} 的远程入口，连接结果尚待确认。dsh 将自动重启，请稍后刷新本页查看状态。`
  return `<p class="notice" role="status">${text}</p>`
}

/**
 * 远程入口页面：这台机器还可以从哪台机器的地址打开，以及设置它的唯一字段。
 * @param options 当前远程入口、launcher 最近一次 dsh 自动重启的进度、刚完成的操作
 * （断开/重连，渲染「稍后刷新」提示）、表单携带的 CSRF token、这台机器自己的名称、
 * 登录用户、要渲染的外观以及提交被拒绝时的错误。
 * @returns 完整的 HTML 文档。
 */
export function hubPage(options: {
  view: MembershipView
  restartStatus?: DshRestartStatus | undefined
  done?: 'leave' | 'reconnect' | undefined
  csrf: string
  machine: string
  username: string | null
  appearance: PageAppearance
  error?: string
}): string {
  const { view, csrf, machine } = options
  const alert = options.error === undefined
    ? ''
    : `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
  const notice = options.done === undefined
    ? ''
    : doneNotice(options.done, machine)
  const restart = options.restartStatus === undefined
    ? ''
    : restartStatusCard(options.restartStatus, machine)
  const reconnect = view.kind !== 'none' && view.kind !== 'self'
    ? ''
    : view.lastHub === undefined
      ? ''
      : reconnectCard(view.lastHub, machine, csrf)
  return consolePage({
    current: ADMIN_HUB_PATH,
    machine,
    title: '远程入口',
    heading: '远程入口',
    intro: '通过其他机器访问本机，同时仅使用一个远程入口。',
    username: options.username,
    appearance: options.appearance,
    body: `${notice}${alert}${entryCard(view)}${reconnect}${restart}
<h2 class="section">设置远程入口</h2>
<p class="hint">到入口机器的「机器」页获取连接命令，完整粘贴到下方。</p>
<form method="post" action="${ADMIN_MEMBERSHIP_JOIN_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<div class="field"><label for="hubCommand">连接命令</label><input class="paste" id="hubCommand" name="command" required maxlength="2048" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" placeholder="dsh-station-connector --relay wss://… --slug … --enroll-token … --hub-authority …"></div>
<p class="hint">提交后会自动重启 dsh，本机和远程访问会短暂中断。</p>
<button type="submit">${view.kind === 'joined' ? '改用这个远程入口' : '设为远程入口'}</button></form>`,
  })
}
