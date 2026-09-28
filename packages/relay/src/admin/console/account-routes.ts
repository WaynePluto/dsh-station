import type { HttpBindings } from '@hono/node-server'
import type { Hono } from 'hono'
import { changeAdminPassword, confirmAdminTotp, resetAdminTotp } from '../../auth/admin.js'
import {
  PasswordPolicyError,
  validateNewPassword,
  verifyPassword,
} from '../../auth/password.js'
import {
  passwordPolicyMessage,
  textField,
  type PageAppearance,
} from '../shared.js'
import { totpQrSvg } from '../totp-panel.js'
import type { UserRecord } from '../../store/types.js'
import {
  ADMIN_ACCOUNT_PATH,
  ADMIN_PASSWORD_PATH,
  ADMIN_TOTP_CONFIRM_PATH,
  ADMIN_TOTP_RESET_PATH,
} from './shell.js'
import {
  accountPage,
  accountUnavailablePage,
  type EnrollmentView,
} from './account.js'
import type {
  AdminConsoleRequestContext,
  AdminConsoleSession,
} from './request-context.js'

/** 账号页面及密码、验证器变更相关的路由。 */
export function registerAccountRoutes(
  app: Hono<{ Bindings: HttpBindings }>,
  dependencies: AdminConsoleRequestContext,
): void {
  const {
    sessionOf,
    appearanceOf,
    page,
    adminAccount,
    machine,
    rejectForgedSubmit,
    store,
    audit,
    logger,
  } = dependencies

  const renderAccount = (context: {
    session: AdminConsoleSession
    appearance: PageAppearance
    status: number
    notice?: string
    error?: string
    enrollment?: EnrollmentView
  }): Response => {
    const account = adminAccount(context.session)
    if (account === undefined) {
      return page({
        session: context.session,
        status: context.status === 200 ? 400 : context.status,
        render: () => accountUnavailablePage({
          machine,
          username: context.session.username,
          appearance: context.appearance,
        }),
      })
    }
    return page({
      session: context.session,
      status: context.status,
      render: csrf => accountPage({
        csrf,
        account: account.username,
        machine,
        username: context.session.username,
        appearance: context.appearance,
        ...context.notice === undefined ? {} : { notice: context.notice },
        ...context.error === undefined ? {} : { error: context.error },
        ...context.enrollment === undefined ? {} : { enrollment: context.enrollment },
      }),
    })
  }

  const requireCurrentPassword = async (input: {
    session: AdminConsoleSession
    appearance: PageAppearance
    currentPassword: string
    sourceIp: string
    failureEvent: 'admin.password-changed' | 'admin.totp-reset'
    mismatchMessage: string
  }): Promise<
    { readonly ok: true; readonly account: UserRecord }
    | { readonly ok: false; readonly response: Response }
  > => {
    const { session } = input
    const account = adminAccount(session)
    // renderAccount 自己会回答“没有唯一管理员”的页面。
    if (account === undefined) {
      return {
        ok: false,
        response: renderAccount({ session, appearance: input.appearance, status: 400 }),
      }
    }
    if (!await verifyPassword(account.passwordHash, input.currentPassword)) {
      audit.record({
        event: input.failureEvent,
        success: false,
        actorUserId: account.id,
        sourceIp: input.sourceIp,
        // 记录失败原因的引用，绝不是提交的密码本身。
        metadata: { reason: 'current-password-mismatch', via: 'admin-console' },
      })
      return {
        ok: false,
        response: renderAccount({
          session,
          appearance: input.appearance,
          status: 403,
          error: input.mismatchMessage,
        }),
      }
    }
    return { ok: true, account }
  }

  app.get(ADMIN_ACCOUNT_PATH, context => {
    const session = sessionOf(context.env.incoming)
    return renderAccount({
      session,
      appearance: appearanceOf(context, ADMIN_ACCOUNT_PATH),
      status: 200,
    })
  })

  app.post(ADMIN_PASSWORD_PATH, async (context) => {
    const session = sessionOf(context.env.incoming)
    const body = await context.req.parseBody()
    const forged = rejectForgedSubmit(context, body)
    if (forged !== undefined) return forged
    const appearance = appearanceOf(context, ADMIN_ACCOUNT_PATH)
    const guard = await requireCurrentPassword({
      session,
      appearance,
      currentPassword: textField(body.currentPassword),
      sourceIp: context.env.incoming.socket.remoteAddress ?? 'unknown',
      failureEvent: 'admin.password-changed',
      mismatchMessage: '当前密码不正确，密码没有修改。',
    })
    if (!guard.ok) return guard.response

    const password = textField(body.newPassword)
    if (password !== textField(body.confirmPassword)) {
      return renderAccount({
        session,
        appearance,
        status: 400,
        error: '两次输入的新密码不一致，密码没有修改。',
      })
    }
    try {
      validateNewPassword(password)
    } catch (error) {
      if (!(error instanceof PasswordPolicyError)) throw error
      return renderAccount({
        session,
        appearance,
        status: 400,
        error: `${passwordPolicyMessage(error)}密码没有修改。`,
      })
    }
    const result = await changeAdminPassword({
      store,
      username: guard.account.username,
      password,
      logger,
    })
    // 直接渲染而不是重定向：响应必须带上警告，并且所有会话（包括当前浏览器的会话）刚刚都已吊销。
    return renderAccount({
      session,
      appearance,
      status: 200,
      notice: `密码已修改，${String(result.revokedSessions)} 个会话已注销。请使用新密码重新登录。`,
    })
  })

  app.post(ADMIN_TOTP_RESET_PATH, async (context) => {
    const session = sessionOf(context.env.incoming)
    const body = await context.req.parseBody()
    const forged = rejectForgedSubmit(context, body)
    if (forged !== undefined) return forged
    const appearance = appearanceOf(context, ADMIN_ACCOUNT_PATH)
    const guard = await requireCurrentPassword({
      session,
      appearance,
      currentPassword: textField(body.currentPassword),
      sourceIp: context.env.incoming.socket.remoteAddress ?? 'unknown',
      failureEvent: 'admin.totp-reset',
      mismatchMessage: '当前密码不正确，验证器没有重置。',
    })
    if (!guard.ok) return guard.response

    const reset = resetAdminTotp({ store, username: guard.account.username, logger })
    return renderAccount({
      session,
      appearance,
      status: 200,
      enrollment: {
        secret: reset.enrollment.secret,
        qrSvg: await totpQrSvg(reset.enrollment.uri),
        confirmable: session.userId === null,
      },
      notice: `验证器已重置，旧动态码已失效，${String(reset.revokedSessions)} 个会话已注销。`,
    })
  })

  app.post(ADMIN_TOTP_CONFIRM_PATH, async (context) => {
    const session = sessionOf(context.env.incoming)
    const body = await context.req.parseBody()
    const forged = rejectForgedSubmit(context, body)
    if (forged !== undefined) return forged
    const account = adminAccount(session)
    const appearance = appearanceOf(context, ADMIN_ACCOUNT_PATH)
    if (account === undefined) return renderAccount({ session, appearance, status: 400 })
    const confirmed = await confirmAdminTotp({
      store,
      userId: account.id,
      token: textField(body.totp),
      logger,
    })
    return renderAccount({
      session,
      appearance,
      status: confirmed ? 200 : 400,
      ...confirmed
        ? { notice: '验证器已绑定。' }
        : { error: '动态码无效或绑定已失效，请重置验证器后重试。' },
    })
  })
}
