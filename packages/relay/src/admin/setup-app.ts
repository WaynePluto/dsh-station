import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestListener, type HttpBindings } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Logger } from 'pino'
import { AdminAlreadyInitializedError, confirmAdminTotp, initializeAdmin } from '../auth/admin.js'
import type { BrowserAuthenticator } from '../auth/browser.js'
import type { BrowserCookiePolicy } from '../auth/cookies.js'
import { isLoopbackBrowserRequest } from '../auth/loopback.js'
import { PASSWORD_MIN_CHARACTERS, PasswordPolicyError, validateNewPassword } from '../auth/password.js'
import {
  DEFAULT_ADMIN_USERNAME,
  USERNAME_MAX_CHARACTERS,
  UsernamePolicyError,
  normalizeUsername,
  validateNewUsername,
} from '../auth/username.js'
import { totpProvisioningUri } from '../auth/totp.js'
import type { RelayStore } from '../store/store.js'
import type { UserRecord } from '../store/types.js'
import { ADMIN_PATH_PREFIX } from './console-app.js'
import {
  PASSWORD_RULE_TEXT,
  csrfToken,
  emptyResponse,
  equalCsrf,
  escapeHtml,
  htmlHeaders,
  passwordPolicyMessage,
  redirectResponse,
  renderPage,
  sameOrigin,
  textField,
  type PageAppearance,
} from './shared.js'
import { readThemePreference } from './theme.js'
import { TOTP_PANEL_STYLE, enrollmentPanel, totpQrSvg } from './totp-panel.js'

export const SETUP_PATH_PREFIX = '/_setup'
export const SETUP_CREATE_PATH = `${SETUP_PATH_PREFIX}/create`
export const SETUP_CONFIRM_PATH = `${SETUP_PATH_PREFIX}/confirm`

export function isSetupPath(pathname: string): boolean {
  return pathname === SETUP_PATH_PREFIX || pathname.startsWith(`${SETUP_PATH_PREFIX}/`)
}

const SETUP_STYLE = `
.steps{margin:12px 0 0;padding-left:20px;font-size:13px;line-height:22px;color:var(--ink-3)}
.steps li{margin:4px 0}
${TOTP_PANEL_STYLE}
`.trim()

/**
 * 唯一 v1 管理员完成到哪一步。`pending-totp` 是真实的稳定状态：
 * `initializeAdmin` 暂存 secret 但保持 TOTP 禁用，relay 可以在向导两步之间重启。
 */
type SetupState =
  | { readonly kind: 'uninitialized' }
  | { readonly kind: 'pending-totp'; readonly user: UserRecord; readonly secret: string }
  | { readonly kind: 'complete' }

function setupState(store: RelayStore): SetupState {
  const users = store.listUsers()
  if (users.length === 0) return { kind: 'uninitialized' }
  const admin = users[0]
  if (users.length !== 1 || admin === undefined) return { kind: 'complete' }
  if (admin.totpEnabled || admin.totpSecret === null || admin.disabledAt !== null) {
    return { kind: 'complete' }
  }
  return { kind: 'pending-totp', user: admin, secret: admin.totpSecret }
}

function alertMarkup(error: string | undefined): string {
  return error === undefined ? '' : `<p class="error" role="alert">${escapeHtml(error)}</p>`
}

/**
 * 向导仅限 loopback，且 relay 从不自行终止 TLS，因此浏览器通过 loopback 访问时
 * 始终报告 `http:` Origin——即使反向代理后的部署公网 scheme 是 https。
 */
function originOk(request: Request): boolean {
  return sameOrigin(request, 'http')
}

/**
 * D15 loopback 检查的两半，在每个 handler 内再次检查。
 *
 * server 会在路由到这里前执行检查；这里是纵深防御，因为忘记检查的调用方
 * 会把管理员账号交给局域网中最先提出请求的人。
 */
function reachable(incoming: IncomingMessage): boolean {
  return isLoopbackBrowserRequest(incoming)
}

function passwordPage(options: {
  csrf: string
  appearance: PageAppearance
  username?: string
  error?: string
}): string {
  return renderPage({
    title: '初始设置 · DSH 工作站',
    extraStyle: SETUP_STYLE,
    appearance: options.appearance,
    body: `<p class="eyebrow">初始设置</p><h1>创建管理员账号</h1>
<p class="intro">设置远程访问账号，仅限本机操作。</p>
${alertMarkup(options.error)}
<form method="post" action="${SETUP_CREATE_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<div class="field"><label for="username">管理员账号（字母、数字或 . _ -）</label><input id="username" name="username" value="${escapeHtml(options.username ?? DEFAULT_ADMIN_USERNAME)}" autocomplete="username" required maxlength="${String(USERNAME_MAX_CHARACTERS)}" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" autofocus></div>
<div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="new-password" aria-describedby="passwordRule" required minlength="${String(PASSWORD_MIN_CHARACTERS)}" maxlength="256"><p class="hint" id="passwordRule">${PASSWORD_RULE_TEXT}</p></div>
<div class="field"><label for="confirmPassword">确认密码</label><input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required maxlength="256"></div>
<button type="submit">下一步：绑定验证器</button></form>
<p class="hint">此账号可远程执行命令和读写文件，请勿复用其他网站的密码。</p>`,
  })
}

function enrollmentPage(options: {
  csrf: string
  qrSvg: string
  secret: string
  appearance: PageAppearance
  error?: string
}): string {
  return renderPage({
    title: '绑定验证器 · DSH 工作站',
    extraStyle: SETUP_STYLE,
    appearance: options.appearance,
    body: `<p class="eyebrow">初始设置</p><h1>绑定验证器</h1>
<p class="intro">远程登录需同时验证密码和动态码。</p>
${alertMarkup(options.error)}
${enrollmentPanel({
      qrSvg: options.qrSvg,
      secret: options.secret,
      confirm: { action: SETUP_CONFIRM_PATH, csrf: options.csrf, label: '完成设置并进入控制台' },
    })}
<p class="hint">请安全备份密钥，以便更换验证器时恢复。</p>`,
  })
}

/**
 * 未初始化 relay 被机器外的浏览器请求任意内容时返回 503 HTML；账号尚不存在，
 * 因此不提供访问者无法完成的登录表单，只给出在 relay 机器上打开 loopback URL 的唯一指引。
 * @param loopbackUrl relay 机器上的 `http://127.0.0.1:<port>/_setup` 地址。
 * @param appearance 要渲染的外观；返回路径是浏览器当前所在的 URL，切换外观会重渲染同一页面。
 * @returns 独立的 HTML 文档。
 */
export function renderSetupRequiredPage(
  loopbackUrl: string,
  appearance: PageAppearance,
): string {
  return renderPage({
    title: '尚未完成初始设置 · DSH 工作站',
    extraStyle: SETUP_STYLE,
    appearance,
    body: `<p class="eyebrow">初始设置</p><h1>请先创建管理员账号</h1>
<p class="intro">在运行工作站的电脑上，用本机浏览器打开下方地址完成账号与验证器设置。</p>
<p class="cmd">${escapeHtml(loopbackUrl)}</p>
<p class="hint">完成后返回此设备登录。</p>`,
  })
}

function renderSetupPage(
  body: string,
  status: number,
  csrf: string,
  cookiePolicy: BrowserCookiePolicy,
): Response {
  return new Response(body, { status, headers: htmlHeaders([cookiePolicy.csrfHeader(csrf)]) })
}

/**
 * 构建 `/_setup` 初始设置向导 listener。
 *
 * 调用方必须在路由到这里前确认请求通过 D15 loopback 检查的两半；每个 handler
 * 仍会再次检查，因为遗漏检查会把管理员账号交给局域网中最先请求的人。
 * @param options CSRF cookie 策略、relay store、设置完成后用于登录操作员的浏览器
 * authenticator（loopback-only 开发模式中不存在），以及审计轨迹镜像到的 logger。
 * @returns `/_setup` 的 Node request listener；账号不存在时也处理其他浏览器路径。
 */
export function createSetupRequestListener(options: {
  cookies: BrowserCookiePolicy
  store: RelayStore
  authenticator: BrowserAuthenticator | undefined
  logger: Logger
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const { cookies, store, authenticator, logger } = options
  const cookiesOf = (context: { readonly env: { readonly incoming: IncomingMessage } }) =>
    cookies.forRequest(context.env.incoming)
  const app = new Hono<{ Bindings: HttpBindings }>()
  app.use('*', bodyLimit({ maxSize: 16 * 1_024 }))

  /**
   * 向导页面渲染所用的外观。两步都由同一个 GET 提供，因此切换器返回这里，
   * 向导也会从上次停下的位置继续。
   * @param context 正在响应的请求。
   * @returns 交给渲染器的外观。
   */
  const appearanceOf = (
    context: {
      req: { header: (name: string) => string | undefined }
      env: { incoming: IncomingMessage }
    },
  ): PageAppearance => ({
    theme: readThemePreference(cookiesOf(context), context.req.header('cookie')),
    returnTo: SETUP_PATH_PREFIX,
  })

  const enrollmentResponse = async (context: {
    secret: string
    username: string
    status: number
    appearance: PageAppearance
    cookiePolicy: BrowserCookiePolicy
    error?: string
  }): Promise<Response> => {
    const csrf = csrfToken()
    const qrSvg = await totpQrSvg(totpProvisioningUri({
      label: context.username,
      secret: context.secret,
    }))
    return renderSetupPage(enrollmentPage({
      csrf,
      qrSvg,
      secret: context.secret,
      appearance: context.appearance,
      ...context.error === undefined ? {} : { error: context.error },
    }), context.status, csrf, context.cookiePolicy)
  }

  app.get(SETUP_PATH_PREFIX, async (context) => {
    if (!reachable(context.env.incoming)) return emptyResponse(403)
    const state = setupState(store)
    // 设置是单向门：账号一旦存在，向导就消失，
    // 操作员应进入控制台（那里会执行普通认证检查）。
    if (state.kind === 'complete') return redirectResponse(ADMIN_PATH_PREFIX, [])
    if (state.kind === 'pending-totp') {
      return enrollmentResponse({
        secret: state.secret,
        username: state.user.username,
        status: 200,
        appearance: appearanceOf(context),
        cookiePolicy: cookiesOf(context),
      })
    }
    const csrf = csrfToken()
    return renderSetupPage(passwordPage({ csrf, appearance: appearanceOf(context) }), 200, csrf, cookiesOf(context))
  })

  app.post(SETUP_CREATE_PATH, async (context) => {
    if (!reachable(context.env.incoming)) return emptyResponse(403)
    if (!originOk(context.req.raw)) return emptyResponse(403)
    const body = await context.req.parseBody()
    const cookiePolicy = cookiesOf(context)
    if (!equalCsrf(cookiePolicy.readCsrf(context.req.header('cookie')), textField(body.csrf))) {
      return emptyResponse(403)
    }
    if (setupState(store).kind !== 'uninitialized') return redirectResponse(SETUP_PATH_PREFIX, [])

    const password = textField(body.password)
    const username = normalizeUsername(textField(body.username))
    const reject = (message: string): Response => {
      const csrf = csrfToken()
      return renderSetupPage(
        passwordPage({ csrf, appearance: appearanceOf(context), username, error: message }),
        400,
        csrf,
        cookiePolicy,
      )
    }
    try {
      validateNewUsername(username)
    } catch (error) {
      if (!(error instanceof UsernamePolicyError)) throw error
      return reject(`账号名只能用 ${String(USERNAME_MAX_CHARACTERS)} 个以内的字母、数字和 . _ -，且要以字母或数字开头。`)
    }
    if (password !== textField(body.confirmPassword)) {
      return reject('两次输入的密码不一致，请重新输入。')
    }
    try {
      validateNewPassword(password)
    } catch (error) {
      if (!(error instanceof PasswordPolicyError)) throw error
      return reject(passwordPolicyMessage(error))
    }

    let created
    try {
      created = await initializeAdmin({
        store,
        username,
        password,
        logger,
      })
    } catch (error) {
      // 两个标签页同时操作同一个空 store：失败者跟随成功者，
      // 而不是报告一个无人能处理的错误。
      if (!(error instanceof AdminAlreadyInitializedError)) throw error
      return redirectResponse(SETUP_PATH_PREFIX, [])
    }
    // 直接渲染而不是重定向，使 secret 只存在于一个响应中；刷新会到达上面的 GET，
    // 从暂存 secret 重新绘制，而不是签发新的 secret。
    return enrollmentResponse({
      secret: created.enrollment.secret,
      username: created.user.username,
      status: 200,
      appearance: appearanceOf(context),
      cookiePolicy,
    })
  })

  app.post(SETUP_CONFIRM_PATH, async (context) => {
    if (!reachable(context.env.incoming)) return emptyResponse(403)
    if (!originOk(context.req.raw)) return emptyResponse(403)
    const body = await context.req.parseBody()
    const cookiePolicy = cookiesOf(context)
    if (!equalCsrf(cookiePolicy.readCsrf(context.req.header('cookie')), textField(body.csrf))) {
      return emptyResponse(403)
    }
    const state = setupState(store)
    if (state.kind === 'complete') return redirectResponse(ADMIN_PATH_PREFIX, [])
    if (state.kind === 'uninitialized') return redirectResponse(SETUP_PATH_PREFIX, [])

    const confirmed = await confirmAdminTotp({
      store,
      userId: state.user.id,
      token: textField(body.totp),
      logger,
    })
    if (!confirmed) {
      return enrollmentResponse({
        secret: state.secret,
        username: state.user.username,
        status: 400,
        appearance: appearanceOf(context),
        cookiePolicy,
        error: '动态码不正确或已经过期，请输入验证器上当前显示的 6 位数字。',
      })
    }

    // 重新读取：只有 TOTP 确实启用后才能签发会话。
    const user = store.getUserById(state.user.id)
    if (authenticator === undefined || user === undefined) {
      return redirectResponse(ADMIN_PATH_PREFIX, [])
    }
    const tokens = await authenticator.service.sessions.issue({
      user,
      sourceIp: context.env.incoming.socket.remoteAddress ?? 'unknown',
      userAgent: context.req.header('user-agent') ?? null,
    })
    return redirectResponse(ADMIN_PATH_PREFIX, [
      ...cookiePolicy.sessionHeaders(tokens),
      cookiePolicy.clearCsrfHeader(),
    ])
  })

  app.all(`${SETUP_PATH_PREFIX}/*`, () => emptyResponse(404))
  app.all(SETUP_PATH_PREFIX, () => emptyResponse(405))

  // 其余内容只有在 relay 完全没有账号时才会到达此 listener，
  // 此时其中任何页面都还无法工作。
  app.all('*', (context) => {
    if (!reachable(context.env.incoming) || setupState(store).kind === 'complete') {
      return emptyResponse(404)
    }
    const method = context.req.method
    if (method !== 'GET' && method !== 'HEAD') return emptyResponse(503)
    return redirectResponse(SETUP_PATH_PREFIX, [])
  })

  return getRequestListener(app.fetch, {
    overrideGlobalObjects: false,
    autoCleanupIncoming: true,
  }) as (request: IncomingMessage, response: ServerResponse) => Promise<void>
}