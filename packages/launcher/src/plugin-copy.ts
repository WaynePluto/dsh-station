import fs from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface PluginCopyTree {
  readonly source: string
  readonly target: string
  /** 运行时依赖单独展开闭包，不复制包内部的 node_modules。 */
  readonly excludeNodeModules?: boolean
}

const DEFAULT_CONCURRENCY = 8

/** 将尚不存在的尾部路径接到真实祖先上，识别经过 junction 的自复制。 */
function resolvedDestination(path: string): string {
  const suffix: string[] = []
  let ancestor = resolve(path)
  while (true) {
    try { return join(fs.realpathSync(ancestor), ...suffix.toReversed()) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      suffix.push(basename(ancestor))
      ancestor = parent
    }
  }
}

/** 调用方提供互不重叠的目标；保留真实文件、空目录、权限及原有链接语义。 */
export async function copyPluginTrees(trees: readonly PluginCopyTree[], concurrency = DEFAULT_CONCURRENCY): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new RangeError('Plugin copy concurrency must be an integer between 1 and 16')
  }
  for (const tree of trees) {
    const suffix = relative(fs.realpathSync(tree.source), resolvedDestination(tree.target))
    if (suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))) {
      throw new Error('Plugin copy target must not be inside its source')
    }
  }
  const directories: { readonly path: string, readonly mode: number }[] = []
  function* walk(source: string, target: string, excludeNodeModules: boolean): Generator<() => Promise<void>> {
    const mode = fs.statSync(source).mode
    fs.mkdirSync(target, { recursive: true })
    directories.push({ path: target, mode })
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (excludeNodeModules && entry.name === 'node_modules') continue
      const from = join(source, entry.name)
      const to = join(target, entry.name)
      if (entry.isDirectory()) yield* walk(from, to, excludeNodeModules)
      else if (entry.isFile()) yield () => fs.promises.copyFile(from, to)
      // 链接及特殊文件交给原生 cp，保持其默认不解引用与错误处理语义。
      else yield () => fs.promises.cp(from, to, { recursive: true })
    }
  }
  function* operations(): Generator<() => Promise<void>> {
    for (const tree of trees) {
      if (fs.lstatSync(tree.source).isDirectory()) yield* walk(tree.source, tree.target, tree.excludeNodeModules ?? false)
      else yield () => fs.promises.cp(tree.source, tree.target, { recursive: true })
    }
  }
  const pending = operations()
  let failed = false
  let failure: unknown
  const worker = async (): Promise<void> => {
    while (!failed) {
      try {
        const next = pending.next()
        if (next.done) return
        // eslint-disable-next-line no-await-in-loop -- 每个 worker 串行取任务以限制总并发
        await next.value()
      } catch (error) {
        if (!failed) { failed = true; failure = error }
      }
    }
  }
  // 失败后停止取新任务，但必须等在途写入完成，调用方才能安全重试或清理。
  await Promise.all(Array.from({ length: concurrency }, worker))
  if (failed) throw failure
  // 最后恢复目录权限，避免只读目录提前阻止其子文件复制。
  for (const directory of directories.toReversed()) fs.chmodSync(directory.path, directory.mode)
}
