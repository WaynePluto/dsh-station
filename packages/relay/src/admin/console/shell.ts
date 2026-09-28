import { LOGOUT_PATH } from '../auth-app.js'
import { escapeHtml, renderPage, type PageAppearance } from '../shared.js'
import { TOTP_PANEL_STYLE } from '../totp-panel.js'

export const ADMIN_PATH_PREFIX = '/_admin'
export const ADMIN_HUB_PATH = `${ADMIN_PATH_PREFIX}/hub`
export const ADMIN_ACCOUNT_PATH = `${ADMIN_PATH_PREFIX}/account`
export const ADMIN_REVOKE_PATH = `${ADMIN_PATH_PREFIX}/devices/revoke`
/** 请求一台断开的机器重新上线；由它的下一次唤醒探测领取。 */
export const ADMIN_WAKEUP_PATH = `${ADMIN_PATH_PREFIX}/machines/wakeup`
export const ADMIN_TOKEN_CREATE_PATH = `${ADMIN_PATH_PREFIX}/tokens/create`
export const ADMIN_PASSWORD_PATH = `${ADMIN_ACCOUNT_PATH}/password`
export const ADMIN_TOTP_RESET_PATH = `${ADMIN_ACCOUNT_PATH}/totp/reset`
export const ADMIN_TOTP_CONFIRM_PATH = `${ADMIN_ACCOUNT_PATH}/totp/confirm`
/** membership 指的是这台机器加入 hub，而不是 hub 的成员机器。 */
export const ADMIN_MEMBERSHIP_JOIN_PATH = `${ADMIN_PATH_PREFIX}/membership/join`
export const ADMIN_MEMBERSHIP_LEAVE_PATH = `${ADMIN_PATH_PREFIX}/membership/leave`
/** 一键恢复 lastHub 记录的上次远程入口；不需要注册令牌。 */
export const ADMIN_MEMBERSHIP_RECONNECT_PATH = `${ADMIN_PATH_PREFIX}/membership/reconnect`

/**
 * 控制台的三个页面，按标签栏显示的顺序排列。
 *
 * 使用标签栏而非 dsh 的侧栏：导航与表单沿用无脚本HTML，仅主题使用固定只读脚本。
 * 不同于 dsh 的会话列表，它们只是偶尔访问的设置页，永久停靠的栏只会
 * 占用手机宽度。
 *
 * 没有活动页面：审计轨迹是写给读取 relay 主机上的 `audit_log` 和 pino 流的人看的，
 * 不是给手机看的。
 */
const TABS: readonly { readonly path: string; readonly label: string }[] = [
  { path: ADMIN_PATH_PREFIX, label: '机器' },
  { path: ADMIN_HUB_PATH, label: '远程入口' },
  { path: ADMIN_ACCOUNT_PATH, label: '账号' },
]

/**
 * 这台机器在自己的控制台上的名称。
 *
 * 所有控制台看起来都一样，因此页面没有名称就无法判断浏览器正在查看哪台机器的控制台；
 * 而每句关于从一台机器打开另一台机器的话都需要明确主语。slug 是隧道、审计轨迹和机器列表
 * 已经使用的名称。
 * @param slug 这台机器自己的 slug；仅当域名部署未配置 direct route 时缺失。
 * @returns 展示给操作员的名称。
 */
export function machineLabel(slug: string | undefined): string {
  return slug ?? '这台机器'
}

export const CONSOLE_STYLE = `
main{width:min(100%,640px)}
/* 顶部对齐，不同于居中的登录页外壳。
   控制台的三个标签属于同一张卡片；整体垂直居中会让内容高度变化时，
   标签栏和刚点击的控件一起上下移动。 */
body{place-items:start center}
form{margin:16px 0 0}
.tabs{display:flex;gap:2px;margin:0 0 18px;padding:3px;border:1px solid var(--line);border-radius:12px;background:var(--inset)}
.tabs a{flex:1 1 0;min-width:0;padding:6px 8px;border-radius:9px;color:var(--ink-3);font-size:13px;line-height:20px;text-align:center;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tabs a:hover{color:var(--ink);background:var(--hover)}
.tabs a[aria-current="page"]{background:var(--card);color:var(--ink);font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.hint{margin:8px 0 0;font-size:13px;line-height:20px;color:var(--ink-3)}
.empty+.actions{margin-top:16px}
.machines{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.machine{border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.machine h2{margin:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;line-height:22px;font-weight:500;color:var(--ink)}
.badge{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border:1px solid var(--line-strong);border-radius:999px;font-size:11px;line-height:16px;font-weight:400;color:var(--ink-2)}
.badge:before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--ink-3)}
/* 本机标记沿用蓝鲸固定品牌色，不表示在线状态。 */
.badge.local:before{background:#4D6BFE}
.badge.on:before{background:var(--success)}
.badge.idle:before{background:var(--warn)}
.badge.gone:before{background:var(--danger)}
.off{color:var(--ink-3)}
.gone{color:var(--danger)}
.meta{margin:0;font-family:var(--mono);font-size:12px;line-height:20px;color:var(--ink-3);overflow-wrap:anywhere}
/* 低频信息按需展开；使用原生details，不增加脚本或隐藏安全确认。 */
.details{min-width:0;font-size:12px;line-height:20px;color:var(--ink-3)}
.details summary{width:fit-content;max-width:100%;border-radius:4px;color:var(--ink-2);cursor:pointer}
.details summary:hover{background:var(--hover);color:var(--ink)}
.details summary:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.details[open]>summary{margin-bottom:8px}
h1,.eyebrow,h2.section,.machine h2,.hub h3,.card h3{overflow-wrap:anywhere}
.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.actions form{margin:0}
.open{display:inline-flex;align-items:center;height:36px;padding:0 14px;border:1px solid var(--line);border-radius:18px;color:var(--ink);font-weight:500;text-decoration:none}
.open:hover{background:var(--hover)}
button.danger{margin:0;border:1px solid var(--line);background:transparent;color:var(--danger)}
button.danger:hover{background:var(--danger-soft)}
button.danger.wide{width:100%;margin-top:16px}
a.danger-link{display:inline-flex;align-items:center;height:36px;padding:0 14px;border:1px solid var(--line);border-radius:18px;color:var(--danger);font-weight:500;text-decoration:none}
a.danger-link:hover{background:var(--danger-soft)}
.consequences{list-style:none;margin:16px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.consequences li{padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:13px;line-height:20px;color:var(--ink-2)}
.back{margin:14px 0 0;font-size:13px;line-height:20px}
.back a{color:var(--ink-3);text-decoration:none}
.back a:hover{color:var(--ink);text-decoration:underline}
h2.section{margin:28px 0 0;font-size:16px;line-height:24px;font-weight:500;color:var(--ink)}
h2.section:first-of-type{margin-top:20px}
.token{margin:20px 0 0;padding:14px;border:1px solid var(--warn);border-radius:12px;background:var(--warn-soft);display:flex;flex-direction:column;gap:10px}
.token h2{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--warn)}
.warn{margin:0;font-size:13px;line-height:20px;color:var(--ink-2)}
.hub{margin:12px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:12px;display:flex;flex-direction:column;gap:8px}
.hub h3{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--ink)}
/* launcher 自动重启进度卡（.restart）：边框颜色区分进行中/完成/失败。 */
.restart{margin:12px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:12px;font-size:13px;line-height:20px;color:var(--ink-2)}
.restart strong{font-weight:500;color:var(--ink)}
.restart[data-state="restarting"]{border-color:var(--warn)}
.restart[data-state="done"]{border-color:var(--success)}
.restart[data-state="failed"]{border-color:var(--danger);color:var(--danger)}
.restart[data-state="failed"] strong{color:var(--danger)}
.paste{font-family:var(--mono);font-size:13px}
.card{margin:12px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:12px}
.card h3{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--ink)}
.card form{margin:12px 0 0}
.signout{margin:20px 0 0;padding-top:14px;border-top:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.signout .foot{margin:0;padding:0;border-top:none}
.signout .open{height:32px;padding:0 12px;font-size:13px}
${TOTP_PANEL_STYLE}
`.trim()

/** 按所有控制台页面显示时间的方式格式化 unix-ms 时间戳。 */
export function formatTime(value: number): string {
  return `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function tabStrip(current: string): string {
  const links = TABS.map((tab) => {
    const active = tab.path === current ? ' aria-current="page"' : ''
    return `<a href="${tab.path}"${active}>${tab.label}</a>`
  }).join('')
  return `<nav class="tabs" aria-label="控制台">${links}</nav>`
}

/**
 * 用共享外壳包裹一个控制台页面：顶部是标签栏，底部是退出登录。
 *
 * `heading`、`intro` 和 `body` 会作为 markup 插入，而不是文本：每个页面都可能在文案中需要
 * `<strong>`。调用方负责转义任何来自请求或 store 的内容。
 * @param options 当前页面（使其标签显示为当前）、标题区块、页面主体、要渲染的外观和登录用户——
 * D15 loopback 豁免时为 null；该豁免根据请求来源而不是会话授权，因此没有可退出的会话。
 * @returns 完整的 HTML 文档。
 */
export function consolePage(options: {
  current: string
  machine: string
  title: string
  heading: string
  intro: string
  body: string
  username: string | null
  appearance: PageAppearance
}): string {
  const who = options.username === null ? '本机免登录' : `已登录：${escapeHtml(options.username)}`
  const signOut = options.username === null
    ? ''
    : `<a class="open" href="${LOGOUT_PATH}?returnTo=${encodeURIComponent(options.current)}">退出登录</a>`
  return renderPage({
    title: `${options.title} · ${options.machine} · DSH 工作站`,
    extraStyle: CONSOLE_STYLE,
    nativeTheme: true,
    appearance: options.appearance,
    body: `${tabStrip(options.current)}
<p class="eyebrow">当前机器：${escapeHtml(options.machine)}</p><h1>${options.heading}</h1>
<p class="intro">${options.intro}</p>
${options.body}
<div class="signout"><p class="foot">${who}</p>${signOut}</div>`,
  })
}

/**
 * 对无法在此撤销的操作显示整页确认。
 *
 * 不依赖客户端 `confirm()` 对话框，防护本身就是一个页面。渲染它的 GET 不会改变任何内容，因此可以安全地通过链接、预取或误输入的 URL 到达。
 * @param options 页面文案、逐行列出的后果、实际执行操作的 POST 目标、请求携带的 CSRF token、
 * 操作所针对的可选机器、取消后返回的路径以及要渲染的外观。
 * @returns 完整的 HTML 文档。
 */
export function confirmPage(options: {
  title: string
  machine: string
  heading: string
  intro: string
  consequences: readonly string[]
  action: string
  csrf: string
  machineId?: string
  submitLabel: string
  cancelPath: string
  cancelLabel: string
  appearance: PageAppearance
}): string {
  const items = options.consequences.map(text => `<li>${escapeHtml(text)}</li>`).join('')
  const machine = options.machineId === undefined
    ? ''
    : `
<input type="hidden" name="machineId" value="${escapeHtml(options.machineId)}">`
  return renderPage({
    title: `${options.title} · ${options.machine} · DSH 工作站`,
    extraStyle: CONSOLE_STYLE,
    nativeTheme: true,
    appearance: options.appearance,
    body: `<p class="eyebrow">当前机器：${escapeHtml(options.machine)}</p><h1>${escapeHtml(options.heading)}</h1>
<p class="intro">${escapeHtml(options.intro)}</p>
<ul class="consequences">${items}</ul>
<form method="post" action="${options.action}">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">${machine}
<button class="danger wide" type="submit">${escapeHtml(options.submitLabel)}</button></form>
<p class="back"><a href="${options.cancelPath}">${escapeHtml(options.cancelLabel)}</a></p>`,
  })
}

/**
 * 目标机器没有活动控制信道时，浏览器导航得到的 502 响应体。
 *
 * 页面承担两种等待：桌面壳双击后 dsh/connector 尚未就绪的启动期，以及机器
 * 真正关机后的离线期。两种情况都无法由页面跳转进入 relay（cross-site 会被
 * 原始安全检查拒绝），因此用 meta refresh 每秒重试同一 URL：机器上线后
 * relay 对 `/` 的下一次回答就是 303，浏览器顺着它进入 dsh。纯 CSS 动画示意
 * 进行中；页面保持无脚本（`default-src 'none'`）。
 * @param slug 浏览器请求的机器。
 * @param appearance 要渲染的外观；返回路径是浏览器当前所在的 URL，因此外观切换会重新渲染同一页面。
 * @returns 独立的 HTML 文档。
 */
export function renderOfflinePage(slug: string, appearance: PageAppearance): string {
  return renderPage({
    title: '机器离线 · DSH 工作站',
    extraStyle: `${CONSOLE_STYLE}
.wait{display:flex;align-items:center;gap:10px}
.spin{flex:none;width:20px;height:20px;border:2px solid var(--line);border-top-color:var(--brand);border-radius:50%;animation:offline-spin 1s linear infinite}
@keyframes offline-spin{to{transform:rotate(360deg)}}
.bar{position:relative;height:4px;margin:18px 0 0;border-radius:999px;background:var(--inset);overflow:hidden}
.bar:after{content:"";position:absolute;top:0;bottom:0;left:-40%;width:40%;border-radius:999px;background:var(--brand);animation:offline-slide 1.4s ease-in-out infinite}
@keyframes offline-slide{to{left:100%}}
@media(prefers-reduced-motion:reduce){.spin{animation:none}.bar:after{animation:none;left:30%}}`,
    appearance,
    refreshSeconds: 1,
    body: `<div class="wait"><span class="spin" aria-hidden="true"></span><p class="eyebrow">等待机器上线</p></div><h1>${escapeHtml(slug)} 当前离线</h1>
<p class="intro">${escapeHtml(slug)} 上的 connector 没有连过来，所以现在没法把请求送到它的 dsh。</p>
<div class="bar" aria-hidden="true"></div>
<p class="empty">本页每秒自动重试：机器正在启动时无需任何操作，connector 连上后会自动进入工作台；如果那台机器已经关机，开机并启动 DSH 工作站 即可，不需要在这里做任何设置。</p>
<div class="actions"><a class="open" href="${ADMIN_PATH_PREFIX}">看看能打开哪些机器 →</a></div>
<p class="foot">DSH 工作站 / relay</p>`,
  })
}
