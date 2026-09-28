import type { BrowserCookiePolicy } from '../auth/cookies.js'

/**
 * dsh 自身提供的三种外观，使用与其
 * （`packages/client/ui-theme/src/theme-settings.ts`）相同的拼写，使机器控制台
 * 与其后的 dsh UI 提供相同选项，而不是两个相似选项。
 *
 * 登录、首次设置和离线页独立用 Cookie 保存偏好。管理页不读取此 Cookie，
 * 而是单向跟随 NativeTheme 的工作站安全投影；relay 不读写原生配置或解析 dsh 协议。
 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 与 dsh 相同的默认值：除非另行指定，否则跟随操作系统。 */
export const DEFAULT_THEME: ThemePreference = 'system'

/**
 * 切换 endpoint。与其他 relay 拥有的路径一样使用 `_` 前缀，
 * 因此不会遮蔽隧道中的 dsh 前端所拥有的路径。
 */
export const THEME_PATH = '/_theme'

/** 复制自 dsh Appearance 行的选项顺序：light、dark、system。 */
export const THEME_VALUES: readonly ThemePreference[] = ['light', 'dark', 'system']

/** 从 dsh 的 zh-CN 字典（`settings.theme`）逐字取出的标签。 */
const THEME_LABELS: Readonly<Record<ThemePreference, string>> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
}

export function themeLabel(preference: ThemePreference): string {
  return THEME_LABELS[preference]
}

/**
 * 解析线路上传来的偏好。
 * @param value 原始查询参数或 cookie 值。
 * @returns 对应偏好；值未命名任何偏好时返回 undefined。
 */
export function parseThemePreference(
  value: string | null | undefined,
): ThemePreference | undefined {
  return THEME_VALUES.find(preference => preference === value)
}

/**
 * 浏览器请求的外观，默认为 `system`。
 *
 * 缺失、过期或手动编辑的 cookie 会解析为默认值，而不是失败：
 * 它只决定页面渲染哪种配色。
 * @param cookies relay 的 cookie 策略，负责 cookie 名称。
 * @param cookieHeader 请求的原始 Cookie header。
 * @returns 用于渲染的偏好。
 */
export function readThemePreference(
  cookies: BrowserCookiePolicy,
  cookieHeader: string | undefined,
): ThemePreference {
  return parseThemePreference(cookies.readTheme(cookieHeader)) ?? DEFAULT_THEME
}

/**
 * 主题切换可以把浏览器送回的地址。
 *
 * 仅允许同源路径，且不能返回 `/_theme` 自身：切换 endpoint 无需会话即可访问，
 * 未经校验的参数会把它变成登录页上的开放重定向。
 * @param value 收到的 `returnTo` 参数。
 * @returns 可安全重定向到的路径。
 */
export function safeThemeReturnTo(value: string | null | undefined): string {
  if (
    value === null || value === undefined
    || value.length > 2_048
    || !value.startsWith('/')
    || value.startsWith('//')
    || value.startsWith('/\\')
    || value === THEME_PATH
    || value.startsWith(`${THEME_PATH}?`)
  ) {
    return '/'
  }
  return value
}

/** server 应对 `/_theme` 请求返回的结果。 */
export type ThemeSwitchResult =
  | {
    readonly kind: 'redirect'
    readonly location: string
    readonly setCookie: string
  }
  | {
    readonly kind: 'error'
    readonly status: 400 | 405
    readonly message: string
  }

/**
 * 解析一次 `/_theme` 请求。
 *
 * 故意在认证前且无需 CSRF token 响应：登录页必须提供切换功能，
 * 而伪造请求唯一能做到的事只是让某人看到深色页面。
 * @param options 请求方法、解析后的 URL 以及负责序列化偏好的 cookie 策略。
 * @returns 要发送的重定向，或要返回的错误。
 */
export function resolveThemeSwitch(options: {
  method: string | undefined
  url: URL
  cookies: BrowserCookiePolicy
}): ThemeSwitchResult {
  const { method, url, cookies } = options
  if (method !== 'GET' && method !== 'HEAD') {
    return { kind: 'error', status: 405, message: 'method not allowed' }
  }
  const preference = parseThemePreference(url.searchParams.get('value'))
  if (preference === undefined) {
    return { kind: 'error', status: 400, message: 'unknown theme' }
  }
  return {
    kind: 'redirect',
    location: safeThemeReturnTo(url.searchParams.get('returnTo')),
    setCookie: cookies.themeHeader(preference),
  }
}
