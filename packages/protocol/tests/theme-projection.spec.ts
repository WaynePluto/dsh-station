import { describe, expect, it } from 'vitest'
import {
  MAX_THEME_PROJECTION_BYTES, THEME_FILE_ENV_NAME, THEME_FILE_NAME,
  parseThemeProjection, themeProjectionSchema,
} from '../src/index.js'

describe('theme projection contract', () => {
  it('固定安全投影文件名和环境变量', () => {
    expect(THEME_FILE_NAME).toBe('dsh-theme.json')
    expect(THEME_FILE_ENV_NAME).toBe('DSH_STATION_THEME_FILE')
    expect(MAX_THEME_PROJECTION_BYTES).toBe(1024)
  })

  it.each(['light', 'dark', 'system'])('接受原生偏好 %s，不在宿主解析 system', (preference) => {
    const value = { version: 1, preference }
    expect(parseThemeProjection(JSON.stringify(value))).toEqual(value)
    expect(themeProjectionSchema.parse(value)).toEqual(value)
  })

  it('只有缺失内容返回 undefined', () => {
    expect(parseThemeProjection(undefined)).toBeUndefined()
    for (const raw of ['', ' ', 'null', '[]', '{}', 'true', '{']) {
      expect(() => parseThemeProjection(raw)).toThrow()
    }
  })

  it.each([
    { version: 2, preference: 'dark' },
    { version: '1', preference: 'dark' },
    { preference: 'dark' },
    { version: 1, preference: 'auto' },
    { version: 1, preference: 'dark', url: 'https://invalid.example' },
    { version: 1, preference: 'dark', token: 'secret' },
  ])('拒绝不符合严格 schema 的对象 %j', (value) => {
    expect(() => parseThemeProjection(JSON.stringify(value))).toThrow()
  })

  it('按 UTF-8 字节限制，而不是 JS 字符数', () => {
    const raw = JSON.stringify({ version: 1, preference: 'system' })
    expect(parseThemeProjection(raw.padEnd(MAX_THEME_PROJECTION_BYTES, ' '))).toEqual({ version: 1, preference: 'system' })
    expect(() => parseThemeProjection(raw.padEnd(MAX_THEME_PROJECTION_BYTES + 1, ' '))).toThrow('byte limit')
    expect(() => parseThemeProjection(JSON.stringify({ value: '汉'.repeat(350) }))).toThrow('byte limit')
  })
})
