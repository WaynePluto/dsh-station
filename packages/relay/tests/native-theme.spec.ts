/* eslint-disable no-await-in-loop -- 顺序替换同一投影文件，逐次确认坏文件不覆盖上次有效值。 */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeTheme } from '../src/admin/native-theme.js'

const resources: { home: string; source: NativeTheme }[] = []

function fixture(initial?: string | Uint8Array) {
  const home = mkdtempSync(join(tmpdir(), 'native-theme-'))
  const path = join(home, 'dsh-theme.json')
  if (initial !== undefined) writeFileSync(path, initial)
  const source = new NativeTheme(home, pino({ level: 'silent' }))
  resources.push({ home, source })
  const changes = vi.fn()
  source.subscribe(changes)
  source.start()
  return {
    home, path, source, changes,
    replace: (raw: string | Uint8Array) => {
      const temporary = join(home, 'projection.tmp')
      writeFileSync(temporary, raw)
      renameSync(temporary, path)
    },
  }
}

const projection = (preference: string) => JSON.stringify({ version: 1, preference })

afterEach(() => {
  for (const { home, source } of resources.splice(0)) {
    source.close()
    rmSync(home, { recursive: true, force: true })
  }
})

describe('NativeTheme projection watcher', () => {
  it.each(['light', 'dark', 'system'] as const)('reads initial %s synchronously and starts only once', (theme) => {
    const { source, changes } = fixture(projection(theme))
    expect(source.preference).toBe(theme)
    source.start()
    expect(changes).toHaveBeenCalledTimes(theme === 'system' ? 0 : 1)
  })

  it.each([
    undefined, '{', 'null', '[]', '{}',
    '{"version":2,"preference":"dark"}',
    '{"version":1,"preference":"sepia"}',
    '{"version":1,"preference":"dark","extra":true}',
    `${projection('dark')}${' '.repeat(1024)}`,
    Buffer.from([0xff, 0xfe]),
  ])('keeps system on missing or invalid initial projection %#', (raw) => {
    const { source, changes } = fixture(raw)
    expect(source.preference).toBe('system')
    expect(changes).not.toHaveBeenCalled()
  })

  it('accepts exactly 1024 UTF-8 bytes but rejects a larger valid JSON document', () => {
    const raw = projection('dark')
    const { source } = fixture(raw.padEnd(1024, ' '))
    expect(source.preference).toBe('dark')
    expect(fixture(raw.padEnd(1025, ' ')).source.preference).toBe('system')
  })

  it('watches the directory across atomic replacements, invalid files, deletion and recovery', async () => {
    const { source, replace, path, changes, home } = fixture()
    replace(projection('dark'))
    await vi.waitFor(() => expect(source.preference).toBe('dark'))
    expect(changes).toHaveBeenCalledTimes(1)
    for (const raw of ['{', projection('unknown'), `${projection('light')}${' '.repeat(1024)}`, Buffer.from([0xff])]) {
      replace(raw)
      await delay(80)
      expect(source.preference).toBe('dark')
      expect(changes).toHaveBeenCalledTimes(1)
    }
    rmSync(path)
    await delay(80)
    expect(source.preference).toBe('dark')
    replace(projection('dark'))
    await delay(80)
    writeFileSync(join(home, 'unrelated.json'), projection('light'))
    await delay(80)
    expect(changes).toHaveBeenCalledTimes(1)
    replace(projection('light'))
    await vi.waitFor(() => expect(source.preference).toBe('light'))
    replace(projection('system'))
    await vi.waitFor(() => expect(source.preference).toBe('system'))
    expect(changes).toHaveBeenCalledTimes(3)
  })

  it('unsubscribes individual listeners and closes pending work permanently', async () => {
    const { source, replace, changes } = fixture(projection('dark'))
    const extra = vi.fn()
    const unsubscribe = source.subscribe(extra)
    unsubscribe()
    replace(projection('light'))
    await vi.waitFor(() => expect(source.preference).toBe('light'))
    expect(extra).not.toHaveBeenCalled()
    replace(projection('system'))
    source.close()
    source.close()
    source.start()
    source.subscribe(extra)
    await delay(80)
    replace(projection('dark'))
    await delay(80)
    expect(source.preference).toBe('light')
    expect(changes).toHaveBeenCalledTimes(2)
    expect(extra).not.toHaveBeenCalled()
  })
})
