import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { ADMIN_THEME_CSP_EXTENSION, ADMIN_THEME_SCRIPT } from './theme-client.js'
import {
  PASSWORD_MIN_CHARACTERS,
  PASSWORD_REQUIRED_CLASSES,
  type PasswordPolicyError,
} from '../auth/password.js'
import {
  DEFAULT_THEME,
  THEME_PATH,
  THEME_VALUES,
  themeLabel,
  type ThemePreference,
} from './theme.js'

/**
 * 说明密码策略的一句话。
 *
 * 所有要求输入密码的地方都会在字段旁和拒绝消息中渲染完全相同的文本：
 * 操作员只有失败后才知道规则，正是人们退回复用其他地方密码的原因。
 */
export const PASSWORD_RULE_TEXT = `至少 ${String(PASSWORD_MIN_CHARACTERS)} 个字符，包含大写字母、小写字母、数字、符号中的至少 ${String(PASSWORD_REQUIRED_CLASSES)} 类`

/**
 * @param error - 违反的策略。
 * @returns 展示给操作员的中文句子。
 */
export function passwordPolicyMessage(error: PasswordPolicyError): string {
  return error.reason === 'too-long'
    ? '密码太长了，请换一个短一些的。'
    : `密码不符合要求：${PASSWORD_RULE_TEXT}。`
}

/**
 * 配色的深色部分，操作员选择深色或 `system` 解析为深色时使用。
 * 只写一份并使用两次：下面两个选择器绝不能发生偏差。
 */
const DARK_TOKENS = `
--page:rgb(21,21,23);--card:rgb(35,35,36);--field:rgb(27,27,28);--inset:rgb(27,27,28);
--line:rgba(255,255,255,.12);--line-strong:rgba(255,255,255,.2);--hover:rgba(255,255,255,.08);
--ink:rgb(249,250,251);--ink-2:rgb(207,211,214);--ink-3:rgb(173,178,184);--caption:rgb(129,133,140);
--brand:rgb(86,134,254);--accent:rgb(249,250,251);--accent-hover:rgb(235,238,242);--accent-ink:rgb(15,17,21);
--danger:rgb(242,90,90);--danger-soft:rgba(242,90,90,.15);
--success:rgb(78,209,126);--success-soft:rgba(78,209,126,.12);
--warn:rgb(247,173,49);--warn-soft:rgba(247,173,49,.1);
--shadow:0 16px 40px rgba(0,0,0,.5)
`.trim()

/**
 * 主题与字体 token（深色两处使用完全相同的 DARK_TOKENS），以及所有 relay
 * 文档共用的最小 reset。独立成块供非控制台外壳的页面（启动等待页）复用。
 */
const TOKEN_STYLE = `
:root{
--font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif;
--mono:"SF Mono","JetBrains Mono","Fira Code",Consolas,"Liberation Mono",Menlo,Courier,"PingFang SC","Microsoft YaHei";
--page:rgb(249,250,251);--card:rgb(255,255,255);--field:rgb(255,255,255);--inset:rgb(249,250,251);
--line:rgba(0,0,0,.1);--line-strong:rgba(0,0,0,.16);--hover:rgba(38,49,72,.06);
--ink:rgb(15,17,21);--ink-2:rgb(97,102,107);--ink-3:rgb(129,133,140);--caption:rgb(173,178,184);
--brand:rgb(65,118,230);--accent:rgb(15,17,21);--accent-hover:rgb(67,69,74);--accent-ink:rgb(255,255,255);
--danger:rgb(236,19,19);--danger-soft:rgba(236,19,19,.06);
--success:rgb(34,197,94);--success-soft:rgba(34,197,94,.08);
--warn:rgb(221,134,41);--warn-soft:rgba(245,158,11,.08);
--shadow:0 12px 32px rgba(0,0,0,.08),0 2px 8px rgba(0,0,0,.04);
color-scheme:light
}
html[data-theme="system"]{color-scheme:light dark}
html[data-theme="dark"]{color-scheme:dark;
${DARK_TOKENS}
}
@media(prefers-color-scheme:dark){html[data-theme="system"]{
${DARK_TOKENS}
}}
*{box-sizing:border-box}
/* 始终预留滚动条轨道；页面在可滚动与不可滚动之间切换时，
   卡片不会横向偏移。 */
html{scrollbar-gutter:stable}
`.trim()

/**
 * 所有 relay 页面共用的基础样式表。采用内联方式，因为登录页必须在隧道存在前渲染，
 * 因此没有可向未认证浏览器提供样式表的路由。
 *
 * 配色、字号比例和几何尺寸使用 dsh 自己的设计 token，复制自
 * `packages/client/ui-theme/src/styles/design-platform.css` 和 `ui-primitives` 组件样式
 * （input h32/r8、胶囊按钮 h36/r18、card r12、dialog r24），使 relay 页面与其后的 dsh UI
 * 看起来像同一个产品。dsh 用内联脚本解析 `system`；relay 的明暗解析仍用CSS，
 * 因此通过 media query 解析，两个显式选项则由 server 从 cookie 渲染成 attribute。
 */
const PAGE_STYLE = `
${TOKEN_STYLE}
/* 页面留白与桌面标题栏占位分开；窄屏时变量也随媒体查询更新。 */
body{--dsh-station-page-top-gap:24px;margin:0;min-height:100dvh;display:grid;place-items:center;padding:var(--dsh-station-page-top-gap) 16px 24px;background:var(--page);color:var(--ink);font-family:var(--font);font-size:14px;line-height:22px;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
main{width:min(100%,440px);border:1px solid var(--line);border-radius:24px;background:var(--card);box-shadow:var(--shadow);overflow:hidden}
.brand{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 24px 0;font-size:13px;line-height:20px;font-weight:500;color:var(--ink-2)}
.mark{display:inline-flex;align-items:center;gap:8px;min-width:0}
.brand img{display:block;width:22px;height:22px;border-radius:6px}
.theme{flex:none;display:flex;gap:2px;padding:2px;border:1px solid var(--line);border-radius:999px;background:var(--inset)}
.theme a{padding:2px 8px;border-radius:999px;font-size:11px;line-height:18px;font-weight:400;color:var(--ink-3);text-decoration:none;white-space:nowrap}
.theme a:hover{color:var(--ink);background:var(--hover)}
.theme a[aria-current]{background:var(--card);color:var(--ink);font-weight:500}
.panel{padding:16px 24px 24px}
.eyebrow{margin:0 0 6px;font-size:12px;line-height:18px;font-weight:500;color:var(--caption)}
h1{margin:0;font-size:20px;line-height:28px;font-weight:500;color:var(--ink)}
p{margin:0}
.intro{margin:8px 0 20px;color:var(--ink-3)}
strong{font-weight:500;color:var(--ink)}
form{margin:0}
.field{display:flex;flex-direction:column;gap:6px;margin:0 0 14px}
label{font-size:12px;line-height:18px;font-weight:500;color:var(--ink-2)}
input{width:100%;height:36px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:var(--field);color:var(--ink);font:inherit}
input:focus{outline:none;border-color:var(--brand)}
input::placeholder{color:var(--caption)}
.code{font-family:var(--mono);letter-spacing:.12em}
button{display:inline-flex;align-items:center;justify-content:center;height:36px;margin:2px 0 0;padding:0 18px;border:none;border-radius:18px;background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:500;cursor:pointer}
button:hover{background:var(--accent-hover)}
button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.error,.notice{margin:0 0 14px;padding:10px 12px;border-radius:8px;font-size:13px;line-height:20px}
.error{background:var(--danger-soft);color:var(--danger)}
.notice{background:var(--success-soft);color:var(--success)}
.hint{margin:8px 0 0;font-size:12px;line-height:18px;color:var(--caption)}
.hint+.field{margin-top:12px}
.empty{margin:12px 0 0;padding:14px;border:1px dashed var(--line-strong);border-radius:12px;font-size:13px;line-height:20px;color:var(--ink-3)}
.cmd,.secret,.otp{margin:0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--inset);font-family:var(--mono);font-size:13px;line-height:20px;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere;user-select:all}
.foot{margin:20px 0 0;padding-top:14px;border-top:1px solid var(--line);font-size:12px;line-height:18px;color:var(--caption)}
@media(max-width:460px){body{--dsh-station-page-top-gap:12px;padding:var(--dsh-station-page-top-gap) 8px 12px}.brand{padding:16px 18px 0}.panel{padding:14px 18px 20px}.theme a{padding:2px 6px}}
`.trim()

/**
 * 公开图标路由。relay 自己提供控制台和登录页，因此也必须提供它们的 favicon——并且和
 * manifest 一样在认证前提供：浏览器无凭据获取图标，而这些字节是与机器无关的固定构建期资源。
 *
 * 使用 `/_icon` 命名空间而不是常规 `/favicon.ico`，避免 relay 遮蔽隧道中 dsh 前端拥有的路径。
 */
export const ICON_PATH_PREFIX = '/_icon'
export const ICON_SVG_PATH = `${ICON_PATH_PREFIX}/dsh-station.svg`
export const ICON_ICO_PATH = `${ICON_PATH_PREFIX}/dsh-station.ico`
export const ICON_PNG_PATH = `${ICON_PATH_PREFIX}/dsh-station.png`

/** 每个 relay 页面都携带的 <link> 区块。 */
const ICON_LINKS = [
  `<link rel="icon" href="${ICON_SVG_PATH}" type="image/svg+xml">`,
  `<link rel="alternate icon" href="${ICON_ICO_PATH}" sizes="16x16 32x32 48x48">`,
  `<link rel="apple-touch-icon" href="${ICON_PNG_PATH}">`,
].join('\n')

/** 转义插入 HTML 的文本；存储值绝不能跳过此步骤。 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 每个 relay 页面携带的外观信息。
 *
 * `returnTo` 是切换器链接返回的位置，因此必须是可由 GET 重新渲染的路径；
 * 没有该路径的页面不显示切换器（因为没有可返回的位置）。
 */
export interface PageAppearance {
  readonly theme: ThemePreference
  readonly returnTo?: string
}

/** 调用方未指定外观时页面使用的默认值。 */
export const DEFAULT_APPEARANCE: PageAppearance = { theme: DEFAULT_THEME }

/**
 * 页面头部显示的外观控制。
 *
 * 使用普通链接，因为这些页面没有脚本：每个链接都是一个 GET，保存偏好后
 * 直接把浏览器送回 `returnTo`。
 * @param appearance 当前偏好和要返回的页面。
 * @returns 切换器 markup；没有返回路径时返回空字符串。
 */
function themeSwitcher(appearance: PageAppearance): string {
  const { returnTo } = appearance
  if (returnTo === undefined) return ''
  const links = THEME_VALUES.map((value) => {
    const current = value === appearance.theme ? ' aria-current="true"' : ''
    const href = `${THEME_PATH}?value=${value}&amp;returnTo=${encodeURIComponent(returnTo)}`
    return `<a href="${href}"${current}>${themeLabel(value)}</a>`
  }).join('')
  return `<nav class="theme" aria-label="外观">${links}</nav>`
}

/**
 * 将页面内容包进共享 relay 文档外壳。
 * @param options 页面标题、面板主体 markup、追加在共享样式表后的可选页面专属 CSS，
 * 要渲染的外观、管理页只读主题脚本开关，以及可选的自动重试间隔（秒）。
 * 非管理页保持无脚本，自动重试用 meta refresh 表达。
 * @returns 完整的 HTML 文档。
 */
export function renderPage(options: {
  title: string
  body: string
  extraStyle?: string
  appearance?: PageAppearance
  /** 仅管理页启用固定的只读主题流，登录与首次设置仍无脚本。 */
  nativeTheme?: boolean
  refreshSeconds?: number
}): string {
  const extra = options.extraStyle === undefined ? '' : `\n${options.extraStyle}`
  const refresh = options.refreshSeconds === undefined
    ? ''
    : `\n<meta http-equiv="refresh" content="${String(Math.max(1, Math.floor(options.refreshSeconds)))}">`
  const appearance = options.appearance ?? DEFAULT_APPEARANCE
  return `<!doctype html>
<html lang="zh-CN" data-theme="${appearance.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${refresh}
<title>${escapeHtml(options.title)}</title>
${ICON_LINKS}
<style>
${PAGE_STYLE}${extra}
</style>
</head>
<body><main>
<header class="brand"><span class="mark"><img src="${ICON_SVG_PATH}" alt="" width="22" height="22">DSH 工作站</span>${options.nativeTheme ? '' : themeSwitcher(appearance)}</header>
<section class="panel">
${options.body}
</section></main>${options.nativeTheme ? `<script>${ADMIN_THEME_SCRIPT}</script>` : ''}</body></html>`
}

/** 固定脚本只探测当前同源 URL；不跟随或读取 token 重定向，就绪后交给顶层导航交换。 */
const SPLASH_SCRIPT = `(() => {
  let stopped = false;
  let retry;
  let controller;
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearTimeout(retry);
    controller?.abort();
  }, { once: true });
  async function probe() {
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    let ready = false;
    try {
      const response = await fetch(location.href, {
        mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
        redirect: 'manual', headers: { Accept: 'text/plain' }, signal: controller.signal
      });
      ready = response.ok || response.type === 'opaqueredirect'
        || (response.status >= 400 && response.status < 500 && response.status !== 429);
      await response.body?.cancel();
    } catch {
      // 网络失败与超时保持等待，不中断动画。
    } finally {
      clearTimeout(timeout);
    }
    if (stopped) return;
    if (ready) location.reload();
    else retry = setTimeout(probe, 200);
  }
  void probe();
})();`

/**
 * 本机 loopback 启动等待页：保留 HARNESS 字标、三元素布局与主题色。
 * 24px 外径（border-box）与 dsh 启动页的 20px 内容 + 2px 边框等大。
 * 固定弧长匀速转圈只表示正在等待，不模拟进度；探测不重建文档，避免动画相位重置。
 * 脚本禁用时才用每秒刷新兜底。远程离线页与管理页不使用此脚本及其 CSP。
 * @param appearance 要渲染的外观。
 * @returns 独立的 HTML 文档。
 */
export function renderSplashPage(appearance: PageAppearance): string {
  return `<!doctype html>
<html lang="zh-CN" data-theme="${appearance.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<noscript><meta http-equiv="refresh" content="1"></noscript>
<title>DSH 工作站</title>
${ICON_LINKS}
<style>
${TOKEN_STYLE}
html,body{height:100%;margin:0}
body{display:grid;place-items:center;background:var(--page);color:var(--ink);font-family:var(--font);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.card{display:flex;flex-direction:column;align-items:center;gap:16px}
.wordmark{font-size:16px;line-height:24px;font-weight:600;letter-spacing:.08em;color:var(--ink)}
.hint{font-size:12px;line-height:18px;color:var(--ink-3)}
.spin{width:24px;height:24px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--ink);animation:splash-spin 1s linear infinite}
@keyframes splash-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
</head>
<body>
<div class="card">
<div class="wordmark">HARNESS</div>
<div class="spin" aria-hidden="true"></div>
<div class="hint" role="status">正在启动 DSH 工作站…</div>
</div>
<script>${SPLASH_SCRIPT}</script>
</body></html>`
}

/** 读取表单字段；客户端可能将其作为文件发送，也可能完全省略。 */
export function textField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function csrfToken(): string {
  return randomBytes(32).toString('base64url')
}

export function equalCsrf(cookie: string | undefined, submitted: string): boolean {
  if (cookie === undefined || submitted === '') return false
  const left = Buffer.from(cookie)
  const right = Buffer.from(submitted)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

export function sameOrigin(
  request: Request,
  publicScheme: 'http' | 'https',
  loopback = false,
): boolean {
  const origin = request.headers.get('origin')
  if (origin === null) return true
  const host = request.headers.get('host')
  if (host === null) return false
  try {
    const parsed = new URL(origin)
    const expectedScheme = loopback ? 'http' : publicScheme
    return parsed.protocol === `${expectedScheme}:` && parsed.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/** 默认页面无脚本；本机启动等待页的唯一例外使用下方独立 CSP。 */
// `img-src 'self'` 只覆盖 favicon：Firefox 会将页面 CSP 应用于图标获取，
// 没有它每次加载页面都会记录违规。页面内容本身仍不携带外部图片——TOTP QR code
// 特意使用内联 SVG。
export const PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

/** 只允许上述固定脚本与同源探测，不向默认页面放开脚本权限。 */
export const SPLASH_CSP = `${PAGE_CSP}; script-src 'sha256-${createHash('sha256').update(SPLASH_SCRIPT).digest('base64')}'; connect-src 'self'`

export const ADMIN_CSP = `${PAGE_CSP}; ${ADMIN_THEME_CSP_EXTENSION}`

export function htmlHeaders(setCookies: readonly string[] = [], policy = PAGE_CSP): Headers {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-security-policy': policy,
    'content-type': 'text/html; charset=utf-8',
    // 在 no-referrer 下，Chromium 会将表单 POST Origin 序列化为 "null"，
    // 使合法的同源登录无法与 sandbox 区分。
    // same-origin 仍不会向其他站点发送 referrer，同时保留 CSRF 检查所需的
    // 具体 Origin。
    'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
  })
  for (const cookie of setCookies) headers.append('set-cookie', cookie)
  return headers
}

export function emptyResponse(status: number, setCookies: readonly string[] = []): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  for (const cookie of setCookies) headers.append('set-cookie', cookie)
  return new Response(null, { status, headers })
}

export function redirectResponse(location: string, setCookies: readonly string[]): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    location,
  })
  for (const cookie of setCookies) headers.append('set-cookie', cookie)
  return new Response(null, { status: 303, headers })
}
