import { describe, expect, it } from 'vitest'
import { createDesktopLink, DESKTOP_LINE_PREFIX } from '../src/desktop-link.js'
import type { DesktopLinkIo, DesktopMessage } from '../src/desktop-link.js'

/** 内存 IO：收集写入的状态行，手动喂入 stdin 行。 */
function memoryIo(): DesktopLinkIo & { written: string[]; feed(line: string): void } {
  const written: string[] = []
  let handler: ((line: string) => void) | undefined
  return {
    written,
    feed(line: string): void {
      handler?.(line)
    },
    write(text: string): void {
      written.push(text)
    },
    listen(onLine: (line: string) => void): void {
      handler = onLine
    },
    close(): void {
      handler = undefined
    },
  }
}

const statusMessage: DesktopMessage = {
  type: 'status',
  protocol: 1,
  phase: 'ready',
  pid: 4242,
  urls: { local: 'http://127.0.0.1:30809/', admin: 'http://127.0.0.1:30809/_admin', dsh: 'http://127.0.0.1:3080/' },
  adminReady: false,
}

describe('desktop link', () => {
  it('is disabled without --desktop', () => {
    const io = memoryIo()
    const link = createDesktopLink([], io)
    expect(link.enabled).toBe(false)
    link.emit(statusMessage)
    link.listen(() => undefined)
    link.close()
    expect(io.written).toEqual([])
  })

  it('emits one prefixed NDJSON line per status message', () => {
    const io = memoryIo()
    const link = createDesktopLink(['--desktop'], io)
    expect(link.enabled).toBe(true)
    link.emit(statusMessage)
    expect(io.written).toHaveLength(1)
    const line = io.written[0] ?? ''
    expect(line.startsWith(DESKTOP_LINE_PREFIX)).toBe(true)
    expect(line.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(line.slice(DESKTOP_LINE_PREFIX.length)) as Record<string, unknown>
    expect(parsed).toMatchObject({ type: 'status', protocol: 1, phase: 'ready', pid: 4242, adminReady: false })
    expect(parsed.urls).toMatchObject({ local: 'http://127.0.0.1:30809/', admin: 'http://127.0.0.1:30809/_admin' })
  })

  it('carries dshToken and remoteEnabled for the local-mode shell (D25)', () => {
    const io = memoryIo()
    const link = createDesktopLink(['--desktop'], io)
    link.emit({
      type: 'status',
      protocol: 1,
      phase: 'ready',
      pid: 4242,
      urls: { local: 'http://127.0.0.1:3080/', admin: 'http://127.0.0.1:30809/_admin', dsh: 'http://127.0.0.1:3080/' },
      dshToken: 'tok_base64url',
      remoteEnabled: false,
    })
    const parsed = JSON.parse(io.written[0]?.slice(DESKTOP_LINE_PREFIX.length) ?? '') as Record<string, unknown>
    expect(parsed.dshToken).toBe('tok_base64url')
    expect(parsed.remoteEnabled).toBe(false)
  })

  it('carries the plugin stage marker for loading-page labels', () => {
    const io = memoryIo()
    const link = createDesktopLink(['--desktop'], io)
    link.emit({
      type: 'status',
      protocol: 1,
      phase: 'plugins',
      pid: 4242,
      pluginStage: 'install',
    })
    const parsed = JSON.parse(io.written[0]?.slice(DESKTOP_LINE_PREFIX.length) ?? '') as Record<string, unknown>
    expect(parsed.pluginStage).toBe('install')
  })

  it.each([
    { phase: 'ready', remoteState: 'idle', remoteEnabled: false },
    { phase: 'remote', remoteState: 'starting', remoteEnabled: false },
    { phase: 'ready', remoteState: 'ready', remoteEnabled: true },
    { phase: 'remote', remoteState: 'stopping', remoteEnabled: false },
    { phase: 'restarting', remoteState: 'stopping', remoteEnabled: false },
    { phase: 'ready', remoteState: 'failed', remoteEnabled: false, remoteError: '启用远程服务失败：HTTP 502\n请退出重开' },
  ] as const)('serializes independent remote state $remoteState without changing the protocol', (state) => {
    const io = memoryIo()
    const link = createDesktopLink(['--desktop'], io)
    link.emit({ ...statusMessage, ...state })
    const line = io.written[0] ?? ''
    expect(line.split('\n')).toHaveLength(2)
    expect(JSON.parse(line.slice(DESKTOP_LINE_PREFIX.length))).toMatchObject({ protocol: 1, type: 'status', ...state })
  })

  it('dispatches stop commands and ignores malformed or unknown lines', () => {
    const io = memoryIo()
    const link = createDesktopLink(['--desktop'], io)
    const commands: string[] = []
    link.listen(command => commands.push(command.type))
    io.feed('{"type":"stop"}')
    io.feed('not json')
    io.feed('{"type":"restart"}')
    io.feed('{"type":"unknown-remote"}')
    io.feed('   ')
    io.feed('{"type":"stop"}')
    expect(commands).toEqual(['stop', 'stop'])
  })

  it('dispatches remote lifecycle commands (D25) without closing the channel', () => {
    const io = memoryIo()
    const link = createDesktopLink(['--desktop'], io)
    const commands: string[] = []
    link.listen(command => commands.push(command.type))
    io.feed('{"type":"start-remote"}')
    io.feed('{"type":"stop-remote"}')
    io.feed('{"type":"restart-remote"}')
    io.feed('{"type":"stop"}')
    expect(commands).toEqual(['start-remote', 'stop-remote', 'restart-remote', 'stop'])
    link.close()
    io.feed('{"type":"start-remote"}')
    expect(commands).toEqual(['start-remote', 'stop-remote', 'restart-remote', 'stop'])
  })
})
