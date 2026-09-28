import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RelayConfig } from '../config.js'
import { isLoopbackBrowserRequest } from '../auth/loopback.js'
import { checkBrowserRequest, isPublicDomainHost } from '../http/security.js'
import type { RelayStore } from '../store/store.js'
import type { AdminConsoleSession } from './console/request-context.js'
import type { NativeTheme } from './native-theme.js'

export const THEME_STREAM_LEASE_MS = 5 * 60_000
export const THEME_STREAM_HEARTBEAT_MS = 25_000
export const THEME_STREAM_LIMIT = 32
export const THEME_STREAM_VIEWER_LIMIT = 8

/** 接口位于管理认证之后；同源fetch凭据与精确Origin/Fetch Metadata再约束读取来源。 */
export function trustedThemeRequest(req: IncomingMessage, config: RelayConfig): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  const local = isLoopbackBrowserRequest(req)
  if (!local && !isPublicDomainHost(host, config) && !checkBrowserRequest(req, config).ok) return false
  try {
    const expected = new URL(`${local ? 'http' : config.publicScheme}://${host}`)
    if (expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash) return false
    if (local && Number(expected.port || 80) !== req.socket.localPort) return false
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin') return false
    if (req.headers.origin !== undefined) return req.headers.origin === expected.origin
    return site === 'same-origin' && req.headers['sec-fetch-mode'] === 'same-origin'
  } catch { return false }
}

/** 有界只读流；续租才重发HTTP，空闲保活不采集/查询主题。 */
export class ThemeEvents {
  readonly #active = new Map<ServerResponse, { viewer: string; close: () => void }>()
  #closed = false

  constructor(
    readonly source: NativeTheme,
    readonly store: RelayStore,
    readonly config: RelayConfig,
    readonly leaseMs = THEME_STREAM_LEASE_MS,
    readonly heartbeatMs = THEME_STREAM_HEARTBEAT_MS,
  ) {}

  handle(req: IncomingMessage, res: ServerResponse, session: AdminConsoleSession): void {
    const fail = (status: number): void => {
      res.writeHead(status, { 'cache-control': 'no-store', 'content-length': 0 })
      res.end()
    }
    if (this.#closed) { fail(503); return }
    if (req.method !== 'GET' || (req.url ?? '').includes('?')) { fail(405); return }
    if (!trustedThemeRequest(req, this.config)) { fail(403); return }
    if (req.headers.accept !== 'application/x-ndjson') { fail(406); return }
    const viewer = session.userId ?? req.socket.remoteAddress ?? 'loopback'
    if (this.#active.size >= THEME_STREAM_LIMIT
      || [...this.#active.values()].filter(item => item.viewer === viewer).length >= THEME_STREAM_VIEWER_LIMIT) {
      fail(429); return
    }
    const authorized = (): boolean => {
      if (session.userId === null) return isLoopbackBrowserRequest(req)
      if (session.sessionId === undefined) return false
      const stored = this.store.getSessionById(session.sessionId)
      const user = this.store.getUserById(session.userId)
      return stored !== undefined && stored.userId === session.userId && stored.revokedAt === null
        && stored.expiresAt > Date.now() && user !== undefined && user.disabledAt === null && user.totpEnabled
    }
    if (!authorized()) { fail(401); return }
    let closed = false
    let last: string | undefined
    let unsubscribe: (() => void) | undefined
    const writes = new Set<ReturnType<typeof setTimeout>>()
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    const close = (): void => {
      if (closed) return
      closed = true
      unsubscribe?.()
      clearInterval(heartbeat)
      clearTimeout(deadline)
      for (const timer of writes) clearTimeout(timer)
      writes.clear()
      this.#active.delete(res)
      res.off('close', close)
      req.off('aborted', close)
      res.end()
    }
    const send = (keepalive = false): void => {
      if (closed) return
      try {
        // 只读检查会话失效；不在已发送响应头的流内刷新/旋转凭据。
        if (!authorized()) { close(); return }
        const preference = this.source.preference
        if (!keepalive && preference === last) return
        const frame = keepalive ? '\n' : `${JSON.stringify({ version: 1, preference })}\n`
        if (Buffer.byteLength(frame) > 128 || res.writableLength > 1024) { close(); res.destroy(); return }
        const timer = setTimeout(() => { close(); res.destroy() }, 3_000)
        timer.unref()
        writes.add(timer)
        const accepted = res.write(frame, () => { clearTimeout(timer); writes.delete(timer) })
        if (!accepted) { close(); res.destroy(); return }
        if (!keepalive) last = preference
      } catch { close(); res.destroy() }
    }
    res.writeHead(200, {
      'content-type': 'application/x-ndjson', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'referrer-policy': 'same-origin',
      ...session.setCookieHeaders.length === 0 ? {} : { 'set-cookie': [...session.setCookieHeaders] },
    })
    this.#active.set(res, { viewer, close })
    res.on('close', close)
    req.on('aborted', close)
    // 同一事件循环中先订阅再读快照；状态变更不会落进两者之间的空隙。
    unsubscribe = this.source.subscribe(() => send())
    heartbeat = setInterval(() => send(true), this.heartbeatMs)
    heartbeat.unref()
    deadline = setTimeout(close, this.leaseMs)
    deadline.unref()
    send()
  }

  close(): void {
    this.#closed = true
    for (const stream of this.#active.values()) stream.close()
  }
}
