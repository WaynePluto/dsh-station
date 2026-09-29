import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyPluginTrees } from '../src/plugin-copy.js'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-station-plugin-copy-'))
  roots.push(root)
  return root
}

function write(path: string, content: string | Buffer = '') {
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, content)
}

function fileTree(root: string, name: string, count: number) {
  const source = join(root, name)
  const target = join(root, `${name}-copy`)
  for (let index = 0; index < count; index++) write(join(source, `${index}.bin`), Buffer.from([index]))
  return { source, target }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// 只跨事件循环检查点，让已释放任务的微任务排空，不依赖计时延迟。
function checkpoint() {
  return new Promise<void>(resolve => setImmediate(resolve))
}

function controlledCopies() {
  const gates: ReturnType<typeof deferred>[] = []
  let active = 0
  let maximum = 0
  let draining = false
  const spy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(() => {
    const gate = deferred()
    gates.push(gate)
    active++
    maximum = Math.max(maximum, active)
    if (draining) gate.resolve()
    return gate.promise.finally(() => { active-- })
  })
  return {
    spy,
    gates,
    get active() { return active },
    get maximum() { return maximum },
    releaseAll() {
      // 断言失败也放行后续调度，finally 不会被测试自己留下的闸门卡住。
      draining = true
      for (const gate of gates) gate.resolve()
    },
  }
}

function observe(promise: Promise<void>) {
  let settled = false
  const outcome = promise.then(
    () => { settled = true; return { ok: true as const } },
    error => { settled = true; return { ok: false as const, error: error as unknown } },
  )
  return { outcome, get settled() { return settled } }
}

describe('copyPluginTrees', () => {
  it('copies multiple trees, binary and empty files, empty directories and Chinese paths without hard links', async () => {
    const root = fixture()
    const binary = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 256))
    const trees = [
      { source: join(root, '插件甲'), target: join(root, '目标甲') },
      { source: join(root, '插件乙'), target: join(root, '目标乙') },
    ]
    for (const tree of trees) {
      write(join(tree.source, '中文目录', '原始数据.bin'), binary)
      write(join(tree.source, '空文件'))
      fs.mkdirSync(join(tree.source, '空目录', '子目录'), { recursive: true })
    }

    await copyPluginTrees(trees)

    for (const tree of trees) {
      const sourceFile = join(tree.source, '中文目录', '原始数据.bin')
      const targetFile = join(tree.target, '中文目录', '原始数据.bin')
      expect(fs.readFileSync(targetFile)).toEqual(binary)
      expect(fs.readFileSync(join(tree.target, '空文件'))).toEqual(Buffer.alloc(0))
      expect(fs.readdirSync(join(tree.target, '空目录', '子目录'))).toEqual([])
      expect(fs.statSync(targetFile).nlink).toBe(1)
      fs.writeFileSync(targetFile, 'changed target')
      expect(fs.readFileSync(sourceFile)).toEqual(binary)
      expect(fs.readFileSync(join(tree.source, '空文件'))).toEqual(Buffer.alloc(0))
      expect(fs.readdirSync(join(tree.source, '空目录', '子目录'))).toEqual([])
    }
  })

  it('filters node_modules at every runtime depth but retains component trees with false or omitted flags', async () => {
    const root = fixture()
    const trees = [true, false, undefined].map((excludeNodeModules, index) => ({
      source: join(root, `source-${index}`), target: join(root, `target-${index}`),
      ...(excludeNodeModules === undefined ? {} : { excludeNodeModules }),
    }))
    const dependencies = ['node_modules/root/index.js', 'nested/node_modules/leaf/index.js', 'nested/deeper/node_modules/empty']
    for (const tree of trees) {
      for (const path of dependencies) write(join(tree.source, path), path)
      write(join(tree.source, 'nested', 'node_modules-extra', 'keep.js'), 'keep')
      write(join(tree.source, 'nested', 'keep.js'), 'component')
    }

    await copyPluginTrees(trees)

    for (const tree of trees) {
      for (const path of dependencies) {
        expect(fs.readFileSync(join(tree.source, path), 'utf8')).toBe(path)
        if (tree.excludeNodeModules) expect(fs.existsSync(join(tree.target, path))).toBe(false)
        else expect(fs.readFileSync(join(tree.target, path), 'utf8')).toBe(path)
      }
      if (tree.excludeNodeModules) {
        for (const path of ['node_modules', 'nested/node_modules', 'nested/deeper/node_modules']) {
          expect(fs.existsSync(join(tree.target, path))).toBe(false)
        }
      }
      expect(fs.readFileSync(join(tree.target, 'nested', 'node_modules-extra', 'keep.js'), 'utf8')).toBe('keep')
      expect(fs.readFileSync(join(tree.target, 'nested', 'keep.js'), 'utf8')).toBe('component')
    }
  })

  it.each([1, 4, 16, undefined])('bounds in-flight copyFile calls and fills available slots (concurrency %s)', async (concurrency) => {
    const root = fixture()
    const trees = [fileTree(root, 'first', 20), fileTree(root, 'second', 20)]
    const copies = controlledCopies()
    const run = observe(copyPluginTrees(trees, concurrency))
    const limit = concurrency ?? 8
    try {
      await checkpoint()
      expect(copies.spy).toHaveBeenCalledTimes(limit)
      expect(copies.active).toBe(limit)
      expect(run.settled).toBe(false)
      copies.gates[0]!.resolve()
      await checkpoint()
      expect(copies.spy).toHaveBeenCalledTimes(limit + 1)
      expect(copies.active).toBe(limit)
      copies.releaseAll()
      expect(await run.outcome).toEqual({ ok: true })
      expect(copies.spy).toHaveBeenCalledTimes(40)
      expect(copies.maximum).toBe(limit)
      expect(copies.active).toBe(0)
    } finally {
      copies.releaseAll()
      await run.outcome
    }
  })

  it('stops scheduling after rejection and drains both successful and failed in-flight copies before rejecting the original error', async () => {
    const root = fixture()
    const trees = [fileTree(root, 'first', 6), fileTree(root, 'later', 2)]
    const copies = controlledCopies()
    const original = new Error('first copy failed')
    const run = observe(copyPluginTrees(trees, 3))
    try {
      await checkpoint()
      expect(copies.spy).toHaveBeenCalledTimes(3)
      copies.gates[0]!.reject(original)
      await checkpoint()
      expect(run.settled).toBe(false)
      expect(copies.active).toBe(2)
      expect(copies.spy).toHaveBeenCalledTimes(3)
      copies.gates[1]!.resolve()
      await checkpoint()
      expect(run.settled).toBe(false)
      expect(copies.spy).toHaveBeenCalledTimes(3)
      copies.gates[2]!.reject(new Error('later copy failed'))
      const result = await run.outcome
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe(original)
      expect(copies.active).toBe(0)
      expect(copies.spy).toHaveBeenCalledTimes(3)
      expect(fs.existsSync(trees[1]!.target)).toBe(false)
    } finally {
      copies.releaseAll()
      await run.outcome
    }
  })

  it('drains in-flight copies when synchronous directory traversal throws and does not begin later trees', async () => {
    const root = fixture()
    const first = fileTree(root, 'first', 2)
    const broken = fileTree(root, 'broken', 1)
    const later = fileTree(root, 'later', 2)
    const original = new Error('readdir failed')
    const readdirSync = fs.readdirSync
    vi.spyOn(fs, 'readdirSync').mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
      if (args[0] === broken.source) throw original
      return readdirSync(...args)
    }) as typeof fs.readdirSync)
    const copies = controlledCopies()
    const run = observe(copyPluginTrees([first, broken, later], 4))
    try {
      await checkpoint()
      expect(copies.spy).toHaveBeenCalledTimes(2)
      expect(copies.active).toBe(2)
      expect(run.settled).toBe(false)
      copies.gates[0]!.resolve()
      await checkpoint()
      expect(run.settled).toBe(false)
      expect(copies.spy).toHaveBeenCalledTimes(2)
      copies.gates[1]!.resolve()
      const result = await run.outcome
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe(original)
      expect(copies.active).toBe(0)
      expect(copies.spy).toHaveBeenCalledTimes(2)
      expect(fs.existsSync(later.target)).toBe(false)
    } finally {
      copies.releaseAll()
      await run.outcome
    }
  })

  it('rejects a missing source without creating the target', async () => {
    const root = fixture()
    const target = join(root, 'target')
    await expect(copyPluginTrees([{ source: join(root, 'missing'), target }])).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fs.existsSync(target)).toBe(false)
  })

  it.each([0, -1, 17, 1.5, NaN, Infinity, -Infinity])('rejects invalid concurrency %s before copying', async (concurrency) => {
    const tree = fileTree(fixture(), 'source', 1)
    const spy = vi.spyOn(fs.promises, 'copyFile')
    await expect(copyPluginTrees([tree], concurrency)).rejects.toBeInstanceOf(RangeError)
    expect(spy).not.toHaveBeenCalled()
    expect(fs.existsSync(tree.target)).toBe(false)
  })

  it.each(['.', 'child', 'nested/../child', '..child'])('rejects targets at or inside the source (%s) before starting any tree', async (suffix) => {
    const root = fixture()
    const valid = fileTree(root, 'valid', 1)
    const tree = fileTree(root, 'source', 1)
    // 防止校验回归把目标递归复制进自身；任何落盘都必须晚于完整校验。
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => { throw new Error('Copy started before containment validation') })
    await expect(copyPluginTrees([valid, { ...tree, target: join(tree.source, suffix) }])).rejects.toThrow(/inside its source/u)
    expect(mkdir).not.toHaveBeenCalled()
    expect(fs.existsSync(valid.target)).toBe(false)
    expect(fs.readdirSync(tree.source)).toEqual(['0.bin'])
  })

  it('rejects a destination routed into the source through a directory junction', async () => {
    const root = fixture()
    const tree = fileTree(root, 'source', 1)
    const alias = join(root, 'alias')
    fs.symlinkSync(tree.source, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(copyPluginTrees([{ source: tree.source, target: join(alias, 'nested', 'copy') }]))
      .rejects.toThrow(/inside its source/u)
    expect(fs.readdirSync(tree.source)).toEqual(['0.bin'])
  })

  it('accepts empty input and sibling targets with a shared source-name prefix', async () => {
    await expect(copyPluginTrees([])).resolves.toBeUndefined()
    const tree = fileTree(fixture(), 'source', 1)
    await copyPluginTrees([tree])
    expect(fs.readFileSync(join(tree.target, '0.bin'))).toEqual(Buffer.from([0]))
  })

  it.skipIf(process.platform === 'win32')('preserves file and directory modes, including non-writable source directories', async () => {
    const root = fixture()
    const tree = fileTree(root, 'source', 1)
    const nested = join(tree.source, 'nested')
    write(join(nested, 'executable'), '#!/usr/bin/env node\n')
    fs.chmodSync(join(tree.source, '0.bin'), 0o640)
    fs.chmodSync(join(nested, 'executable'), 0o751)
    fs.chmodSync(nested, 0o550)
    fs.chmodSync(tree.source, 0o750)
    try {
      await copyPluginTrees([tree])
      for (const [path, mode] of [['', 0o750], ['0.bin', 0o640], ['nested', 0o550], ['nested/executable', 0o751]] as const) {
        expect(fs.statSync(join(tree.target, path)).mode & 0o777).toBe(mode)
        expect(fs.statSync(join(tree.source, path)).mode & 0o777).toBe(mode)
      }
    } finally {
      for (const path of [nested, join(tree.target, 'nested')]) {
        if (fs.existsSync(path)) fs.chmodSync(path, 0o750)
      }
    }
  })

  it.for(['root', 'embedded'] as const)('matches native cp for a %s directory link without traversing it', async (placement, context) => {
    const root = fixture()
    const external = join(root, 'external')
    write(join(external, 'node_modules', 'kept.js'), 'linked dependency')
    const source = join(root, 'source')
    const link = placement === 'root' ? source : join(source, 'linked')
    fs.mkdirSync(dirname(link), { recursive: true })
    const nativeTarget = join(root, 'native')
    const target = join(root, 'target')
    try {
      fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (['EPERM', 'ENOTSUP', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip('Native symlink creation/copy is unavailable on this filesystem')
        return
      }
      throw error
    }
    let nativeError: NodeJS.ErrnoException | undefined
    try { await fs.promises.cp(source, nativeTarget, { recursive: true }) }
    catch (error) { nativeError = error as NodeJS.ErrnoException }
    const readdir = vi.spyOn(fs, 'readdirSync')
    const copyFile = vi.spyOn(fs.promises, 'copyFile')
    if (nativeError !== undefined) {
      await expect(copyPluginTrees([{ source, target, excludeNodeModules: true }])).rejects.toMatchObject({ code: nativeError.code })
      expect(copyFile).not.toHaveBeenCalled()
      expect(readdir.mock.calls.some(([path]) => path === link || path === external)).toBe(false)
      return
    }
    await copyPluginTrees([{ source, target, excludeNodeModules: true }])
    const copiedLink = placement === 'root' ? target : join(target, 'linked')
    const nativeLink = placement === 'root' ? nativeTarget : join(nativeTarget, 'linked')
    expect(fs.lstatSync(copiedLink).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(copiedLink)).toBe(fs.readlinkSync(nativeLink))
    expect(fs.realpathSync(copiedLink)).toBe(fs.realpathSync(external))
    expect(fs.readFileSync(join(copiedLink, 'node_modules', 'kept.js'), 'utf8')).toBe('linked dependency')
    expect(copyFile).not.toHaveBeenCalled()
    expect(readdir.mock.calls.some(([path]) => path === link || path === external)).toBe(false)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
  })
})
