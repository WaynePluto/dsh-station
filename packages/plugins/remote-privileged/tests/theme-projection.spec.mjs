import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as protocol from '../../../protocol/src/theme-projection.ts'
import { SHELL_OVERLAY_FILES } from '../../../../scripts/pack/manifest.mjs'
import * as plugin from '../theme-projection.mjs'

const faults = vi.hoisted(() => ({ write: false, rename: false }))
vi.mock('node:fs', async (original) => {
  const fs = await original()
  return {
    ...fs,
    renameSync: vi.fn((...args) => {
      if (faults.rename) throw new Error('secret token https://private.invalid')
      return fs.renameSync(...args)
    }),
    writeFileSync: (...args) => {
      if (faults.write && typeof args[0] === 'number') {
        fs.writeFileSync(args[0], '{')
        throw new Error('secret native config')
      }
      return fs.writeFileSync(...args)
    },
  }
})

const temporary = []
const contexts = []
function destination() {
  const root = mkdtempSync(join(tmpdir(), 'station-theme-'))
  temporary.push(root)
  return join(root, protocol.THEME_FILE_NAME)
}
function context(preference = 'system') {
  const callbacks = new Map()
  const effects = []
  const entry = {
    options: { id: 'ui-theme' },
    parent: { tree: { ctx: { fiber: { entry: { id: 'include' } } } } },
    fiber: { state: 2, runtime: {}, config: { preference: { get: () => preference } } },
  }
  const entries = [entry]
  const ctx = {
    entry, entries,
    set(value) { preference = value },
    emit(event = 'app-boot/config-reload') { callbacks.get(event)?.() },
    close() { for (const cleanup of effects.splice(0)) cleanup() },
    logger: { warn: vi.fn() },
    loader: { entries: vi.fn(() => entries.values()), await: vi.fn(() => Promise.resolve()) },
    on: vi.fn((event, callback) => {
      callbacks.set(event, callback)
      return () => callbacks.delete(event)
    }),
    effect: setup => effects.push(setup()),
    callbacks,
  }
  contexts.push(ctx)
  return ctx
}
async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
function read(path) { return protocol.parseThemeProjection(readFileSync(path, 'utf8')) }
function start(path, ctx = context()) {
  vi.stubEnv(protocol.THEME_FILE_ENV_NAME, path)
  plugin.apply(ctx)
  return ctx
}
beforeEach(() => {
  faults.write = false
  faults.rename = false
})
afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.close()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('native theme projection', () => {
  it('纯 mjs 契约与 protocol 一致，且发行文件清单包含运行时代码', () => {
    for (const key of ['THEME_FILE_NAME', 'THEME_FILE_ENV_NAME', 'MAX_THEME_PROJECTION_BYTES']) {
      expect(plugin[key]).toBe(protocol[key])
    }
    const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(manifest.files).toContain('theme-projection.mjs')
    expect(manifest.dependencies).toBeUndefined()
    expect(readFileSync(join(root, 'dsh-overlay.yml'), 'utf8')).toContain("name: './theme-projection.mjs'")
    expect(SHELL_OVERLAY_FILES).toContain('node_modules/@dsh-station/dsh-plugin-remote-privileged/theme-projection.mjs')
  })

  it('无环境变量不读取配置、不订阅、不猜 home', async () => {
    vi.stubEnv(protocol.THEME_FILE_ENV_NAME, undefined)
    const ctx = context()
    plugin.apply(ctx)
    await settle()
    expect(ctx.on).not.toHaveBeenCalled()
    expect(ctx.loader.await).not.toHaveBeenCalled()
    expect(ctx.loader.entries).not.toHaveBeenCalled()
  })

  it.each(['', 'dsh-theme.json', './dsh-theme.json'])('拒绝相对目标 %s', async (path) => {
    const ctx = start(path)
    await settle()
    expect(ctx.on).not.toHaveBeenCalled()
    expect(ctx.logger.warn).toHaveBeenCalledWith('[dsh-station] theme projection: invalid destination')
  })

  it('拒绝把原生 profile 文件作为输出', () => {
    const path = destination()
    const ctx = start(join(dirname(path), 'cordis.patch.yml'))
    expect(ctx.on).not.toHaveBeenCalled()
    expect(readdirSync(dirname(path))).toEqual([])
  })

  it.each(['light', 'dark', 'system'])('启动时输出严格投影 %s', async (preference) => {
    const path = destination()
    start(path, context(preference))
    await settle()
    expect(read(path)).toEqual({ version: 1, preference })
    expect(Buffer.byteLength(readFileSync(path))).toBeLessThanOrEqual(protocol.MAX_THEME_PROJECTION_BYTES)
    expect(readdirSync(dirname(path))).toEqual([protocol.THEME_FILE_NAME])
  })

  it('仅提交事件触发刷新，合并同轮事件并只读取最新值', async () => {
    const path = destination()
    const ctx = start(path)
    await settle()
    ctx.set('dark')
    ctx.emit('theme/change')
    ctx.emit('loader/volatile-update')
    await settle()
    expect(read(path).preference).toBe('system')
    ctx.emit()
    ctx.set('light')
    ctx.emit()
    await settle()
    expect(read(path).preference).toBe('light')
    expect(ctx.loader.entries).toHaveBeenCalledTimes(2)
    expect(ctx.on.mock.calls.map(([event]) => event)).toEqual(['app-boot/config-reload'])
  })

  it('启动等待结束后才读取最新值，不保存旧异步快照', async () => {
    const path = destination()
    const ctx = context('light')
    let ready
    ctx.loader.await.mockImplementation(() => new Promise(resolve => { ready = resolve }))
    start(path, ctx)
    ctx.set('dark')
    ctx.emit()
    await settle()
    expect(existsSync(path)).toBe(false)
    ready()
    await settle()
    expect(read(path).preference).toBe('dark')
  })

  it('同值事件不重写投影', async () => {
    const { renameSync } = await import('node:fs')
    const path = destination()
    const ctx = start(path)
    await settle()
    ctx.emit()
    await settle()
    expect(renameSync).toHaveBeenCalledTimes(1)
  })

  it('不活跃、重复、非法和读取失败均保留最后有效投影', async () => {
    const path = destination()
    const ctx = start(path, context('dark'))
    await settle()
    ctx.set('invalid')
    ctx.emit()
    await settle()
    ctx.set('light')
    ctx.entry.fiber.state = 0
    ctx.emit()
    await settle()
    ctx.entry.fiber.state = 2
    ctx.entries.push(ctx.entry)
    ctx.emit()
    await settle()
    ctx.entries.pop()
    ctx.loader.entries.mockImplementationOnce(() => { throw new Error('secret native configuration') })
    ctx.emit()
    await settle()
    expect(read(path).preference).toBe('dark')
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(ctx.logger.warn.mock.calls)).not.toMatch(/secret|configuration/u)
    ctx.emit()
    await settle()
    expect(read(path).preference).toBe('light')
  })

  it.each(['write', 'rename'])('原子 %s 失败不损坏缓存，清理临时文件并可在下次提交重试', async (fault) => {
    const path = destination()
    const ctx = start(path, context('dark'))
    await settle()
    faults[fault] = true
    ctx.set('light')
    ctx.emit()
    await settle()
    expect(read(path).preference).toBe('dark')
    expect(readdirSync(dirname(path))).toEqual([protocol.THEME_FILE_NAME])
    expect(ctx.logger.warn).toHaveBeenCalledWith('[dsh-station] theme projection: write failed')
    faults[fault] = false
    ctx.emit()
    await settle()
    expect(read(path).preference).toBe('light')
  })

  it('父目录不可用仅安全诊断，不让宿主抛错', async () => {
    const path = destination()
    const blocked = join(dirname(path), 'blocked')
    writeFileSync(blocked, '')
    const ctx = start(join(blocked, protocol.THEME_FILE_NAME))
    await settle()
    expect(ctx.logger.warn).toHaveBeenCalledWith('[dsh-station] theme projection: write failed')
  })

  it('释放取消订阅和排队写入，缓存仍在', async () => {
    const path = destination()
    const ctx = start(path, context('dark'))
    await settle()
    ctx.set('light')
    ctx.emit()
    ctx.close()
    await settle()
    expect(ctx.callbacks.size).toBe(0)
    expect(read(path).preference).toBe('dark')
  })

  it('启动等待中的释放不会在异步结束后写文件', async () => {
    const path = destination()
    const ctx = context()
    let ready
    ctx.loader.await.mockImplementation(() => new Promise(resolve => { ready = resolve }))
    start(path, ctx)
    ctx.close()
    ready()
    await settle()
    expect(existsSync(path)).toBe(false)
  })

  it('loader 失败仅安全诊断并保留磁盘缓存', async () => {
    const path = destination()
    writeFileSync(path, JSON.stringify({ version: 1, preference: 'dark' }))
    const ctx = context()
    ctx.loader.await.mockRejectedValue(new Error('secret token'))
    start(path, ctx)
    await settle()
    expect(read(path).preference).toBe('dark')
    expect(ctx.logger.warn).toHaveBeenCalledWith('[dsh-station] theme projection: loader unavailable')
  })

  it('两个工作站的输出路径与状态完全独立', async () => {
    const first = destination()
    const second = destination()
    const a = start(first, context('dark'))
    start(second, context('light'))
    await settle()
    a.set('system')
    a.emit()
    await settle()
    expect(read(first).preference).toBe('system')
    expect(read(second).preference).toBe('light')
  })
})
