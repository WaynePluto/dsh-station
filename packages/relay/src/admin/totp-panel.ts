import QRCode from 'qrcode'
import { escapeHtml } from './shared.js'

/**
 * 验证器注册面板的样式，由初始设置向导和控制台验证器重置共用，
 * 使两处步骤外观一致。
 */
export const TOTP_PANEL_STYLE = `
.enroll{margin:14px 0 0;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--inset);display:flex;flex-direction:column;gap:12px}
.qr{align-self:center;padding:10px;border-radius:12px;background:#fff;line-height:0}
.qr svg{display:block;width:min(60vw,200px);height:auto}
.enroll p{margin:0;font-size:13px;line-height:20px;color:var(--ink-2)}
.enroll .otp{background:var(--card);font-size:14px;letter-spacing:.12em;color:var(--ink)}
.enroll form{margin:0}
`.trim()

/** QR code 的绘制方式：白底深色模块，包含静区。 */
const QR_OPTIONS = {
  type: 'svg',
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 200,
  color: { dark: '#0f1115', light: '#ffffff' },
} as const

/**
 * 将 TOTP 配置 URI 绘制为内联 SVG QR code。
 *
 * 使用内联 SVG，而不是 `data:` URL 或提供图片：markup 会成为文档的一部分而不是子资源，
 * 因此 relay 的 `default-src 'none'` 策略无需 `img-src` 例外。渲染器只输出由编码模块构成的
 * `<svg>` 和 `<path>` 元素，绝不输出 URI 文本，因此无需对其中内容做转义。
 * @param uri 要编码的 `otpauth://` 配置 URI。
 * @returns 可插入页面的 SVG markup。
 */
export function totpQrSvg(uri: string): Promise<string> {
  return QRCode.toString(uri, QR_OPTIONS)
}

/** 按四个一组分隔 Base32，符合验证器 App 手动输入时的格式。 */
export function groupedSecret(secret: string): string {
  return (secret.match(/.{1,4}/gu) ?? [secret]).join(' ')
}

/**
 * 渲染注册面板：用于扫描的 QR code、可替代输入的 secret，
 * 以及可选的首次动态码确认字段。
 * @param options 预渲染的 QR markup、base32 secret 和要附加的确认
 * 表单。提交不可能成功时调用方省略 `confirm`——重置会吊销所有会话，
 * 因此远程登录的浏览器必须重新登录，而该次登录会自行确认注册。
 * @returns 面板 markup。
 */
export function enrollmentPanel(options: {
  qrSvg: string
  secret: string
  confirm?: { action: string; csrf: string; label: string }
}): string {
  const confirm = options.confirm === undefined
    ? ''
    : `<form method="post" action="${escapeHtml(options.confirm.action)}">
<input type="hidden" name="csrf" value="${escapeHtml(options.confirm.csrf)}">
<div class="field"><label for="totp">6 位动态码</label><input class="code" id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></div>
<button type="submit">${escapeHtml(options.confirm.label)}</button></form>`
  return `<div class="enroll">
<p>使用验证器 App 扫码添加账号。</p>
<div class="qr" role="img" aria-label="验证器绑定二维码">${options.qrSvg}</div>
<p>无法扫码时，可手动输入密钥：</p>
<p class="otp">${escapeHtml(groupedSecret(options.secret))}</p>
${confirm}
</div>`
}