import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import {
  createAuthenticationService,
  createRelayServer,
  memberPortBaseFor,
  openRelayStore,
  resolveRelayConfig,
} from '../src/index.js'

describe('relay authentication configuration', () => {
  it('allows non-loopback bind only for explicit authenticated LAN HTTP mode', () => {
    expect(resolveRelayConfig({
      host: '0.0.0.0',
      port: 30_809,
      directSlug: 'pc1',
      publicScheme: 'http',
      browserAuth: { cookieMode: 'lan-http' },
    })).toMatchObject({ host: '0.0.0.0', browserAuth: { cookieMode: 'lan-http' } })

    expect(() => resolveRelayConfig({
      host: '0.0.0.0',
      directSlug: 'pc1',
      publicScheme: 'http',
    })).toThrow(/non-loopback bind/)
    expect(() => resolveRelayConfig({
      host: '0.0.0.0',
      publicDomain: 'dsh.test',
      publicScheme: 'https',
      browserAuth: { cookieMode: 'domain-https' },
    })).toThrow(/non-loopback bind/)
  })

  it('rejects cookie modes that do not match their transport and routing mode', () => {
    expect(() => resolveRelayConfig({
      directSlug: 'pc1',
      publicScheme: 'https',
      browserAuth: { cookieMode: 'lan-http' },
    })).toThrow(/lan-http authentication requires/)
    expect(() => resolveRelayConfig({
      directSlug: 'pc1',
      publicScheme: 'http',
      browserAuth: { cookieMode: 'domain-https' },
    })).toThrow(/domain-https authentication requires/)
  })

  it('derives the member port range for a LAN hub only', () => {
    const lan = resolveRelayConfig({ port: 30_809, directSlug: 'pc1', publicScheme: 'http' })
    expect(memberPortBaseFor(lan)).toBe(30_810)
    expect(lan.memberPortCount).toBe(64)

    // 子域名已经为每台机器提供地址，因此不会静默绑定端口。
    const domain = resolveRelayConfig({ port: 30_809, publicDomain: 'dsh.test' })
    expect(memberPortBaseFor(domain)).toBeUndefined()
    expect(memberPortBaseFor({ ...domain, memberPortBase: 40_000 })).toBe(40_000)

    // 临时主端口没有可供推导的确定邻近范围。
    expect(memberPortBaseFor({ port: 0, publicDomain: undefined })).toBeUndefined()
  })

  it('rejects a member port range that overlaps the main port or leaves the port space', () => {
    expect(() => resolveRelayConfig({
      port: 30_809,
      directSlug: 'pc1',
      memberPortBase: 30_800,
      memberPortCount: 32,
    })).toThrow(/must not contain the relay main port/)
    expect(() => resolveRelayConfig({
      port: 30_809,
      directSlug: 'pc1',
      memberPortBase: 65_500,
      memberPortCount: 64,
    })).toThrow(/at or below port 65535/)
  })

  it('prints an explicit high-risk warning for LAN HTTP mode', async () => {
    const store = openRelayStore({ path: ':memory:' })
    const lines: string[] = []
    const logger = pino({ level: 'trace' }, { write: (line: string) => { lines.push(line) } })
    const authentication = await createAuthenticationService({
      store,
      jwtSecret: new Uint8Array(32).fill(0x44),
    })
    const home = mkdtempSync(join(tmpdir(), 'relay-config-'))
    const relay = createRelayServer({
      home,
      host: '127.0.0.1',
      port: 0,
      directSlug: 'pc1',
      publicScheme: 'http',
      browserAuth: { cookieMode: 'lan-http' },
    }, { authentication, logger, store })
    try {
      await relay.listen()
      expect(lines.some(line => line.includes('HIGH RISK') && line.includes('without TLS'))).toBe(true)
    } finally {
      await relay.close()
      store.close()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('requires auth config and runtime service to be supplied together', async () => {
    const store = openRelayStore({ path: ':memory:' })
    try {
      const authentication = await createAuthenticationService({
        store,
        jwtSecret: new Uint8Array(32).fill(0x33),
      })
      expect(() => createRelayServer({
        directSlug: 'pc1',
        publicScheme: 'http',
      }, { authentication, logger: pino({ level: 'silent' }), store })).toThrow(/provided together/)
      expect(() => createRelayServer({
        directSlug: 'pc1',
        publicScheme: 'http',
        browserAuth: { cookieMode: 'lan-http' },
      }, { logger: pino({ level: 'silent' }), store })).toThrow(/provided together/)
    } finally {
      store.close()
    }
  })
})
