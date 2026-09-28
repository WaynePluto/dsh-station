import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import net from 'node:net'
import pino from 'pino'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { WebSocket, createWebSocketStream } from 'ws'
import {
  PROTOCOL_VERSION,
  TUNNEL_CONTROL_PATH,
  TUNNEL_STREAM_PATH,
  decodeControlFrame,
  deviceChallengeMessage,
  type RelayToConnectorFrame,
} from '@dsh-station/protocol'
import {
  BrowserCookiePolicy,
  createAuthenticationService,
  createRelayServer,
  generateTotp,
  hashOpaqueToken,
  initializeAdmin,
  openRelayStore,
  readCookie,
  type AuthenticationService,
  type CreateUserInput,
  type RelayConfigInput,
  type RelayServer,
  type RelayStore,
} from '../src/index.js'

export interface DeviceIdentity {
  readonly publicKey: string
  sign(message: Uint8Array): string
}

export function createDeviceIdentity(): DeviceIdentity {
  const pair = generateKeyPairSync('ed25519')
  const jwk = pair.publicKey.export({ format: 'jwk' })
  if (typeof jwk.x !== 'string') throw new Error('Ed25519 export is missing raw public key material')
  return {
    publicKey: jwk.x,
    sign: message => sign(null, message, pair.privateKey).toString('base64url'),
  }
}

/**
 * 完成一次唤醒探测握手：hello 携带 probe 标记并按正常流程认证。
 * @returns relay 的应答：是否收到 reconnect-offer，以及 socket 以什么码关闭
 * （没有 offer 时真实 relay 会以 1000 礼貌关闭）。
 */
export function probeWakeup(options: {
  relayPort: number
  identity: DeviceIdentity
  machineId: string
  slug: string
}): Promise<{ offered: boolean; closeCode: number | undefined }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(options.relayPort)}${TUNNEL_CONTROL_PATH}`)
    let offered = false
    let closeCode: number | undefined
    let nonce: string | undefined
    ws.on('error', error => reject(error))
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        version: PROTOCOL_VERSION,
        machineId: options.machineId,
        slug: options.slug,
        connectorVersion: '0.0.1-test',
        probe: true,
      }))
    })
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      if (nonce === undefined) reject(new Error('probe closed before the challenge arrived'))
      else resolve({ offered, closeCode })
    }
    ws.on('message', (data) => {
      const frame = decodeControlFrame(data as Buffer)
      if (frame.type === 'challenge') {
        nonce = frame.nonce
        ws.send(JSON.stringify({
          type: 'auth',
          version: PROTOCOL_VERSION,
          machineId: options.machineId,
          nonce: frame.nonce,
          credential: {
            method: 'ed25519',
            publicKey: options.identity.publicKey,
            signature: options.identity.sign(deviceChallengeMessage({
              nonce: frame.nonce,
              machineId: options.machineId,
              slug: options.slug,
            })),
          },
        }))
        return
      }
      if (frame.type === 'reconnect-offer') {
        // offer 路径的 relay 不关连接（真实 connector 收到后自行离开）。
        offered = true
        ws.close(1000)
        settle()
      }
    })
    ws.on('close', (code) => {
      closeCode = code
      settle()
    })
  })
}

export function issueEnrollToken(store: RelayStore, slug: string): string {
  const token = randomBytes(32).toString('base64url')
  store.createEnrollToken({
    tokenHash: hashOpaqueToken(token),
    requestedSlug: slug,
    expiresAt: Date.now() + 300_000,
  })
  return token
}

/** 按注册流程登记设备，但不实际运行 connector。 */
/**
 * 注册一台已知私钥的设备：唤醒探测要签名 challenge，测试必须持有密钥。
 * @returns 注册时使用的身份。
 */
export function registerKnownDevice(
  store: RelayStore,
  options: { machineId: string; slug: string },
): DeviceIdentity {
  const identity = createDeviceIdentity()
  const token = issueEnrollToken(store, options.slug)
  const device = store.consumeEnrollToken({
    tokenHash: hashOpaqueToken(token),
    device: {
      machineId: options.machineId,
      slug: options.slug,
      publicKey: identity.publicKey,
    },
  })
  if (device === undefined) throw new Error('test device registration failed')
  return identity
}

export function registerTestDevice(store: RelayStore, options: {
  machineId: string
  slug: string
}): void {
  const token = issueEnrollToken(store, options.slug)
  const device = store.consumeEnrollToken({
    tokenHash: hashOpaqueToken(token),
    device: {
      machineId: options.machineId,
      slug: options.slug,
      publicKey: createDeviceIdentity().publicKey,
    },
  })
  if (device === undefined) throw new Error('test device registration failed')
}

function tryListen(port: number): Promise<net.Server | undefined> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(undefined))
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

/**
 * 为成员 listener 查找当前空闲的连续端口块。
 * relay 分配固定范围，因此测试不能向 OS 请求临时
 * 端口，而必须探测候选端口块。
 * @param count relay 需要的连续端口数。
 * @param attempt 递归保护；调用方不传入。
 * @returns 刚刚确认空闲的端口块的第一个端口。
 */
export async function findFreePortBlock(count: number, attempt = 0): Promise<number> {
  if (attempt >= 30) throw new Error('could not find a free port block for the test relay')
  const base = 21_000 + Math.floor(Math.random() * 20_000)
  const probed = await Promise.all(
    Array.from({ length: count }, (_unused, offset) => tryListen(base + offset)),
  )
  await Promise.all(probed.filter(server => server !== undefined).map(server => closeServer(server)))
  if (probed.every(server => server !== undefined)) return base
  return findFreePortBlock(count, attempt + 1)
}

export interface HttpResult {
  status: number | undefined
  body: string
  headers: http.IncomingHttpHeaders
}

/** 纯 Node 请求辅助函数：必须通过真实 socket 测试 relay。 */
export function httpRequest(options: {
  port: number
  path: string
  method?: string
  headers?: http.OutgoingHttpHeaders
  body?: string
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: options.port,
      path: options.path,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
      }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.end(options.body)
    else req.end()
  })
}

/** 将 Set-Cookie header 转换为浏览器会带回的 Cookie header。 */
export function cookieHeader(setCookieHeaders: readonly string[]): string {
  return setCookieHeaders.map(header => header.split(';', 1)[0]).join('; ')
}

export function setCookieArray(headers: http.IncomingHttpHeaders): string[] {
  const value = headers['set-cookie']
  return value === undefined ? [] : value
}

/** connector 替身：真实控制信道握手，真实数据 WebSocket。 */
export class MockConnector {
  readonly machineId: string
  readonly slug: string
  readonly control: WebSocket
  readonly dataSockets = new Set<WebSocket>()
  openStreamCount = 0
  lastError: { code: string; message: string; fatal: boolean } | undefined

  readonly #relayPort: number
  readonly #upstreamPort: number
  readonly #identity: DeviceIdentity
  readonly #enrollToken: string
  readonly #dshToken: string | undefined
  readonly #ready: Promise<void>
  #resolveReady!: () => void

  constructor(options: {
    relayPort: number
    upstreamPort: number
    identity: DeviceIdentity
    enrollToken: string
    machineId: string
    slug: string
    /** dsh 自己的浏览器登录 token，像真实 connector 一样在 auth-ok 后上报。 */
    dshToken?: string | undefined
  }) {
    this.machineId = options.machineId
    this.slug = options.slug
    this.#relayPort = options.relayPort
    this.#upstreamPort = options.upstreamPort
    this.#identity = options.identity
    this.#enrollToken = options.enrollToken
    this.#dshToken = options.dshToken
    this.#ready = new Promise(resolve => { this.#resolveReady = resolve })
    this.control = new WebSocket(`ws://127.0.0.1:${String(options.relayPort)}${TUNNEL_CONTROL_PATH}`)
    this.control.on('error', () => {})
    this.control.on('open', () => {
      this.control.send(JSON.stringify({
        type: 'hello',
        version: PROTOCOL_VERSION,
        machineId: this.machineId,
        slug: this.slug,
        connectorVersion: '0.0.1-test',
      }))
    })
    this.control.on('message', data => this.#onFrame(decodeControlFrame(data as Buffer) as RelayToConnectorFrame))
  }

  ready(): Promise<void> {
    return this.#ready
  }

  close(): void {
    for (const ws of this.dataSockets) ws.terminate()
    this.dataSockets.clear()
    this.control.close()
  }

  #onFrame(frame: RelayToConnectorFrame): void {
    if (frame.type === 'challenge') {
      this.control.send(JSON.stringify({
        type: 'auth',
        version: PROTOCOL_VERSION,
        machineId: this.machineId,
        nonce: frame.nonce,
        credential: {
          method: 'ed25519-enroll',
          publicKey: this.#identity.publicKey,
          signature: this.#identity.sign(deviceChallengeMessage({
            nonce: frame.nonce,
            machineId: this.machineId,
            slug: this.slug,
          })),
          enrollToken: this.#enrollToken,
        },
      }))
      return
    }
    if (frame.type === 'auth-ok') {
      if (this.#dshToken !== undefined) {
        this.control.send(JSON.stringify({
          type: 'dsh-auth',
          version: PROTOCOL_VERSION,
          token: this.#dshToken,
        }), () => this.#resolveReady())
        return
      }
      this.#resolveReady()
      return
    }
    if (frame.type === 'ping') {
      this.control.send(JSON.stringify({ ...frame, type: 'pong' }))
      return
    }
    if (frame.type === 'error') {
      this.lastError = { code: frame.code, message: frame.message, fatal: frame.fatal }
      return
    }
    if (frame.type !== 'open-stream') return
    this.openStreamCount += 1
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(this.#relayPort)}${TUNNEL_STREAM_PATH}?token=${encodeURIComponent(frame.streamToken)}`,
    )
    this.dataSockets.add(ws)
    ws.on('error', () => {})
    ws.once('open', () => {
      const tunnel = createWebSocketStream(ws)
      const local = net.connect({ host: '127.0.0.1', port: this.#upstreamPort })
      tunnel.on('error', () => {})
      local.on('error', () => {})
      tunnel.pipe(local).pipe(tunnel)
    })
    ws.once('close', () => this.dataSockets.delete(ws))
  }
}

export interface RelayTestFixture {
  readonly relay: RelayServer
  readonly port: number
  readonly store: RelayStore
}

export interface AuthenticatedRelayTestFixture extends RelayTestFixture {
  readonly sessionCookie: string
  readonly userId: string
  readonly totpSecret: string
  readonly connector: MockConnector | undefined
}

export interface CsrfPage extends HttpResult {
  readonly csrf: string
  readonly csrfPair: string
}

type RelayConfigOverrides = Omit<RelayConfigInput, 'host' | 'port'>

interface RelayFixtureStartOptions {
  jwtSecret: Uint8Array
  relay: RelayConfigOverrides
  loggerLevel?: string
  prepare?: (context: {
    store: RelayStore
    authentication: AuthenticationService
  }) => void | Promise<void>
}

type AuthenticatedAccount =
  | {
      kind: 'initialize-admin'
      username: string
      password: string
    }
  | {
      kind: 'existing-user'
      input: CreateUserInput & { readonly totpSecret: string }
    }

type TestDevice =
  | {
      mode: 'online'
      machineId: string
      slug: string
      upstreamPort: number
      dshToken?: string
    }
  | {
      mode: 'offline'
      machineId: string
      slug: string
    }

const defaultAuthenticatedRelay: RelayConfigOverrides = {
  publicDomain: 'dsh.test',
  publicScheme: 'https',
  browserAuth: { cookieMode: 'domain-https' },
}

const ownedHomes = new WeakMap<RelayServer, string>()

async function listenRelayFixture(
  options: RelayFixtureStartOptions,
  store: RelayStore,
  authentication: AuthenticationService,
): Promise<RelayTestFixture> {
  const home = options.relay.home ?? mkdtempSync(join(tmpdir(), 'relay-fixture-'))
  const relay = createRelayServer({
    host: '127.0.0.1',
    port: 0,
    ...options.relay,
    home,
  }, {
    authentication,
    logger: pino({
      level: options.loggerLevel ?? process.env.RELAY_TEST_LOG ?? 'silent',
    }),
    store,
  })
  if (options.relay.home === undefined) ownedHomes.set(relay, home)
  const address = await relay.listen()
  return { relay, port: address.port, store }
}

export async function startRelayFixture(options: RelayFixtureStartOptions): Promise<RelayTestFixture> {
  const store = openRelayStore({ path: ':memory:' })
  const authentication = await createAuthenticationService({
    store,
    jwtSecret: options.jwtSecret,
  })
  await options.prepare?.({ store, authentication })
  return listenRelayFixture(options, store, authentication)
}

export async function startAuthenticatedRelayFixture(options: {
  jwtSecret: Uint8Array
  account: AuthenticatedAccount
  relay?: RelayConfigOverrides
  cookiePolicy?: BrowserCookiePolicy
  sourceIp?: string
  device?: TestDevice
  loggerLevel?: string
}): Promise<AuthenticatedRelayTestFixture> {
  const store = openRelayStore({ path: ':memory:' })
  const authentication = await createAuthenticationService({
    store,
    jwtSecret: options.jwtSecret,
  })
  const sourceIp = options.sourceIp ?? '127.0.0.1'
  const cookies = options.cookiePolicy
    ?? new BrowserCookiePolicy({ mode: 'domain-https', domain: 'dsh.test' })
  let userId: string
  let totpSecret: string
  let sessionCookie: string

  if (options.account.kind === 'initialize-admin') {
    const initialized = await initializeAdmin({
      store,
      username: options.account.username,
      password: options.account.password,
    })
    const tokens = await authentication.login({
      username: options.account.username,
      password: options.account.password,
      totpToken: await generateTotp(initialized.enrollment.secret),
      sourceIp,
    })
    userId = initialized.user.id
    totpSecret = initialized.enrollment.secret
    sessionCookie = cookieHeader(cookies.sessionHeaders(tokens))
  } else {
    const user = store.createUser(options.account.input)
    const tokens = await authentication.sessions.issue({ user, sourceIp })
    userId = user.id
    totpSecret = options.account.input.totpSecret
    sessionCookie = cookieHeader(cookies.sessionHeaders(tokens))
  }

  const fixture = await listenRelayFixture({
    jwtSecret: options.jwtSecret,
    relay: { ...defaultAuthenticatedRelay, ...options.relay },
    loggerLevel: options.loggerLevel ?? process.env.RELAY_TEST_LOG ?? 'silent',
  }, store, authentication)

  let connector: MockConnector | undefined
  if (options.device?.mode === 'online') {
    connector = new MockConnector({
      relayPort: fixture.port,
      upstreamPort: options.device.upstreamPort,
      identity: createDeviceIdentity(),
      enrollToken: issueEnrollToken(store, options.device.slug),
      machineId: options.device.machineId,
      slug: options.device.slug,
      dshToken: options.device.dshToken,
    })
    await connector.ready()
  } else if (options.device?.mode === 'offline') {
    registerTestDevice(store, {
      machineId: options.device.machineId,
      slug: options.device.slug,
    })
  }

  return {
    ...fixture,
    sessionCookie,
    userId,
    totpSecret,
    connector,
  }
}

export interface CloseFixturesOptions<T extends RelayTestFixture> {
  beforeRelayClose?: (fixture: T) => void | Promise<void>
  afterStoreClose?: (fixture: T) => void | Promise<void>
}

export async function closeFixtures<T extends RelayTestFixture>(
  fixtures: T[],
  options: CloseFixturesOptions<T> = {},
): Promise<void> {
  const pending = fixtures.splice(0)
  await Promise.all(pending.map(async (fixture) => {
    try {
      await options.beforeRelayClose?.(fixture)
    } finally {
      try {
        await fixture.relay.close()
      } finally {
        fixture.store.close()
        const home = ownedHomes.get(fixture.relay)
        if (home !== undefined) rmSync(home, { recursive: true, force: true })
        await options.afterStoreClose?.(fixture)
      }
    }
  }))
}

export function openPage(fixture: RelayTestFixture, options: {
  path: string
  host: string
  cookie?: string
  accept?: string
}): Promise<HttpResult> {
  const headers: http.OutgoingHttpHeaders = {
    host: options.host,
    accept: options.accept ?? 'text/html',
  }
  if (options.cookie !== undefined) headers.cookie = options.cookie
  return httpRequest({ port: fixture.port, path: options.path, headers })
}

export function openAuthenticatedPage(fixture: AuthenticatedRelayTestFixture, options: {
  path: string
  host: string
  cookie?: string
  accept?: string
}): Promise<HttpResult> {
  return openPage(fixture, {
    ...options,
    cookie: options.cookie ?? fixture.sessionCookie,
  })
}

export function csrfTokensFromResponse(result: HttpResult, options: {
  cookieName: string
  label: string
}): { csrf: string; csrfPair: string } {
  const setCookie = setCookieArray(result.headers)
    .find(header => header.includes('dsh_csrf='))
  if (setCookie === undefined) throw new Error(`${options.label} did not issue a CSRF cookie`)
  const csrfPair = setCookie.split(';', 1)[0] ?? ''
  const csrf = readCookie(csrfPair, options.cookieName)
  if (csrf === undefined) throw new Error(`could not parse the ${options.label} CSRF cookie`)
  return { csrf, csrfPair }
}

export async function openCsrfPage(fixture: RelayTestFixture, options: {
  path: string
  host: string
  cookie?: string
  accept?: string
  csrfCookieName?: string
  label?: string
}): Promise<CsrfPage> {
  const cookie = options.cookie
    ?? ('sessionCookie' in fixture && typeof fixture.sessionCookie === 'string'
      ? fixture.sessionCookie
      : undefined)
  const page = await openPage(fixture, {
    ...options,
    ...(cookie === undefined ? {} : { cookie }),
  })
  const tokens = csrfTokensFromResponse(page, {
    cookieName: options.csrfCookieName ?? '__Secure-dsh_csrf',
    label: options.label ?? 'page',
  })
  return { ...page, ...tokens }
}

export function postForm(fixture: RelayTestFixture, options: {
  path: string
  host: string
  origin?: string
  cookie?: string
  accept?: string
  fields: Record<string, string>
}): Promise<HttpResult> {
  const headers: http.OutgoingHttpHeaders = {
    host: options.host,
    'content-type': 'application/x-www-form-urlencoded',
  }
  if (options.origin !== undefined) headers.origin = options.origin
  if (options.cookie !== undefined) headers.cookie = options.cookie
  if (options.accept !== undefined) headers.accept = options.accept
  return httpRequest({
    port: fixture.port,
    path: options.path,
    method: 'POST',
    headers,
    body: new URLSearchParams(options.fields).toString(),
  })
}

export function postCsrfForm(fixture: RelayTestFixture, options: {
  path: string
  host: string
  origin: string
  csrfPair: string
  sessionCookie?: string
  accept?: string
  fields: Record<string, string> & { csrf: string }
}): Promise<HttpResult> {
  const cookie = [options.sessionCookie, options.csrfPair]
    .filter((value): value is string => value !== undefined)
    .join('; ')
  return postForm(fixture, {
    path: options.path,
    host: options.host,
    origin: options.origin,
    cookie,
    ...(options.accept === undefined ? {} : { accept: options.accept }),
    fields: options.fields,
  })
}
