import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { materializePluginDistributions } from '../../../scripts/plugin-distributions.mjs'

const root = join(import.meta.dirname, '..', '..', '..')
const temporary: string[] = []

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('plugin installation media', () => {
  it('materializes movable distributions with grouped component packages', () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-station-plugins-'))
    temporary.push(base)
    // 输出目录带空格：绿色包会被解压到用户任选的目录，介质必须与位置无关。
    // 不用非 ASCII 目录名——CI 的英文代码页 runner 上 cpSync/existsSync 组合
    // 对非 ASCII 路径不可靠（本机中文环境无法复现），可移植性由空格路径覆盖。
    const output = join(base, 'with space', 'plugins')
    const result = materializePluginDistributions({ root, output })

    expect(result.plugins).toHaveLength(10)
    expect(existsSync(join(output, 'catalog.json'))).toBe(true)
    const group = join(output, 'conversation-enhancements')
    expect(lstatSync(group).isDirectory()).toBe(true)
    expect(existsSync(join(
      group,
      'node_modules',
      '@dsh-station',
      'dsh-plugin-turn-retry',
      'dist',
      'index.js',
    ))).toBe(true)

    const manifest = JSON.parse(readFileSync(join(group, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(manifest.dependencies['@dsh-station/dsh-plugin-turn-retry']).toBe('0.0.2-20260928')
    expect(JSON.stringify(manifest)).not.toContain('workspace:')
  })

  it('keeps standalone host and browser artifacts beside their manifest', () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-station-plugins-'))
    temporary.push(base)
    const output = join(base, 'plugins')
    materializePluginDistributions({ root, output })

    expect(existsSync(join(output, 'files', 'dist', 'index.js'))).toBe(true)
    expect(existsSync(join(output, 'files', 'dist', 'client.js'))).toBe(true)
    expect(existsSync(join(output, 'files', 'cordis.patch.yml'))).toBe(true)
  })
})
