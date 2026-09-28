import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { Duplex } from 'node:stream'
import type { Logger } from 'pino'
import { renderOfflinePage, renderSplashPage } from '../admin/console-app.js'
import { PAGE_CSP, SPLASH_CSP, type PageAppearance } from '../admin/shared.js'
import { isLoopbackBrowserRequest } from '../auth/loopback.js'
import { TunnelError, type MachineRegistry } from '../tunnel/registry.js'
import { upstreamHeaders } from './security.js'

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = `${message}\n`
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  })
  res.end(body)
}

/**
 * 只有顶层浏览器导航得到 HTML 错误体；API 和 XHR 调用方继续获得它们已经在解析的机器可读文本。
 */
function wantsHtmlPage(req: IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const accept = req.headers.accept
  if (accept === undefined) return false
  return accept.split(',').some(part => part.trim().toLowerCase().startsWith('text/html'))
}

function sendOfflinePage(
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
  setCookieHeaders: readonly string[],
  appearance: PageAppearance,
): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  // 本机（桌面壳/本机浏览器）得到极简启动等待页：这段等待是应用启动的
  // 一部分，不能长得像管理网页；远程访客仍得到带指引的离线页。
  const local = isLoopbackBrowserRequest(req)
  const body = local
    ? renderSplashPage(appearance)
    : renderOfflinePage(slug, appearance)
  res.writeHead(502, {
    'cache-control': 'no-store',
    'content-security-policy': local ? SPLASH_CSP : PAGE_CSP,
    'referrer-policy': 'same-origin',
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    connection: 'close',
    ...setCookieHeaders.length === 0 ? {} : { 'set-cookie': [...setCookieHeaders] },
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function responseHeaders(
  headers: IncomingHttpHeaders,
  setCookieHeaders: readonly string[],
): IncomingHttpHeaders {
  const result = { ...headers }
  delete result.connection
  delete result['proxy-connection']
  delete result['transfer-encoding']
  delete result['keep-alive']
  if (setCookieHeaders.length !== 0) {
    const upstreamCookies = result['set-cookie'] ?? []
    result['set-cookie'] = [...upstreamCookies, ...setCookieHeaders]
  }
  return result
}

/** dsh 渲染 index 的路径；只有这些路径的 401 值得处理。 */
const DSH_INDEX_PATHS: ReadonlySet<string> = new Set(['/', '/index.html'])

/** dsh 用于交换自身浏览器 cookie 的查询参数。 */
const DSH_TOKEN_PARAM = 'token'

/**
 * 此请求是否可以通过 dsh 登录交换恢复。
 *
 * dsh 0.1.2 自己认证浏览器，没有自身 cookie 的 index 请求会返回裸 401。
 * 只有顶层 index GET 会被重定向进入令牌交换：`/api` 的 401 属于页面自己的错误处理，
 * 且已携带令牌的请求绝不能再次重定向，否则被拒绝的令牌会造成无限循环。
 * @param req 浏览器请求。
 * @returns 要重定向到的 URL；401 应原样通过时返回 undefined。
 */
function dshLoginRedirect(req: IncomingMessage, token: string | undefined): string | undefined {
  if (token === undefined || req.method !== 'GET') return undefined
  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://relay.invalid')
  } catch {
    return undefined
  }
  if (!DSH_INDEX_PATHS.has(url.pathname) || url.searchParams.has(DSH_TOKEN_PARAM)) return undefined
  url.searchParams.set(DSH_TOKEN_PARAM, token)
  return `${url.pathname}${url.search}`
}

function sendDshLoginRedirect(
  res: ServerResponse,
  location: string,
  setCookieHeaders: readonly string[],
): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(303, {
    'cache-control': 'no-store',
    location,
    // 令牌位于 URL 中；第三方不得通过 referrer 得到它。
    'referrer-policy': 'no-referrer',
    'content-length': 0,
    ...setCookieHeaders.length === 0 ? {} : { 'set-cookie': [...setCookieHeaders] },
  })
  res.end()
}

export async function proxyHttpRequest(options: {
  req: IncomingMessage
  res: ServerResponse
  slug: string
  registry: MachineRegistry
  logger: Logger
  /** 离线页面使用的外观；这是此处唯一能渲染的页面。 */
  appearance: PageAppearance
  setCookieHeaders?: readonly string[]
}): Promise<void> {
  const { req, res, slug, registry, logger } = options
  const setCookieHeaders = options.setCookieHeaders ?? []
  let tunnel: Duplex
  try {
    tunnel = await registry.openStream(slug)
  } catch (error) {
    const message = error instanceof TunnelError ? error.message : 'tunnel unavailable'
    logger.warn({ err: error, slug }, 'failed to open HTTP tunnel stream')
    if (wantsHtmlPage(req)) sendOfflinePage(req, res, slug, setCookieHeaders, options.appearance)
    else sendError(res, 502, message)
    return
  }

  if (req.destroyed || res.destroyed) {
    tunnel.destroy()
    return
  }

  const headers = upstreamHeaders(req)
  headers.connection = 'close'
  delete headers.upgrade
  delete headers['proxy-connection']

  const upstream = http.request({
    method: req.method,
    path: req.url,
    headers,
    createConnection: () => tunnel,
  })

  let answered = false
  upstream.once('response', (upstreamResponse) => {
    answered = true
    // dsh 自己的浏览器认证：将 index 的 401 换成一次令牌交换；
    // 该交换会签发 dsh cookie 并返回干净 URL。
    if (upstreamResponse.statusCode === 401) {
      const location = dshLoginRedirect(req, registry.getBySlug(slug)?.dshToken)
      if (location !== undefined) {
        upstreamResponse.resume()
        upstreamResponse.once('end', () => tunnel.destroy())
        sendDshLoginRedirect(res, location, setCookieHeaders)
        return
      }
    }
    res.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage,
      responseHeaders(upstreamResponse.headers, setCookieHeaders),
    )
    upstreamResponse.pipe(res)
    upstreamResponse.once('end', () => tunnel.destroy())
  })
  upstream.once('error', (error) => {
    logger.warn({ err: error, slug, path: req.url }, 'upstream HTTP request failed')
    // ClientRequest 已经报告并记录此 socket 失败。直接销毁，而不要在可能没有 listener 的隧道上
    // 再次发出同一错误。
    tunnel.destroy()
    if (!answered) sendError(res, 502, 'upstream request failed')
  })
  req.once('aborted', () => upstream.destroy(new Error('browser request aborted')))
  res.once('close', () => {
    if (!res.writableEnded) upstream.destroy(new Error('browser response closed'))
  })
  req.pipe(upstream)
}
