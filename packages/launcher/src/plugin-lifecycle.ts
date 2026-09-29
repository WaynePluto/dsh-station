import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire, findPackageJSON } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runPluginCommand } from '@deepseek-ai/dsh-plugin-manager/operations'
import { isMap, isSeq, parseDocument } from 'yaml'
import type { PluginDistribution } from './plugin-catalog.js'
import { PLUGIN_DISTRIBUTIONS } from './plugin-catalog.js'
import { LauncherError } from './errors.js'
import { copyPluginTrees, type PluginCopyTree } from './plugin-copy.js'
import { DSH_BASE_BUNDLE, DSH_WEB_APP_BUNDLE, profileDirectory } from './profile.js'

const STATE_FILE = 'dsh-station-bundles-state.json'
const PACKAGE_MANAGER_MIGRATION_DIRECTORY = '.dsh-station-package-manager-migration'
const PROFILE_MEDIA_DIRECTORY = '.dsh-station-plugin-media'
const MEDIA_PENDING_FILE = '.dsh-station-plugin-media.pending'
const LEGACY_FILES = '@dsh-station/dsh-plugin-files'
const SHARED_MODEL_CATALOG = '@earendil-works/pi-ai'
const SHARED_HTTP_PROXY = '@deepseek-ai/dsh-http-proxy'

interface JsonObject { [key: string]: unknown }

interface MediaEntry {
  readonly name: string
  readonly version: string
  readonly directory: string
  readonly components: readonly { readonly name: string, readonly rowId: string, readonly toggleable?: boolean }[]
}

interface LifecycleState {
  readonly schemaVersion: 2
  readonly offered: readonly string[]
  readonly versions: Readonly<Record<string, string>>
  /** 介质目录内容指纹；旧状态文件缺失时走一次完整同步后补齐。 */
  readonly stamps?: Readonly<Record<string, string>>
}

interface PackageManagerCommand {
  readonly command: string
  readonly args?: readonly string[]
  readonly version?: string
}

export interface PluginSyncTiming {
  readonly phase: 'check' | 'plugin-copy' | 'dependency-resolve' | 'dependency-copy' | 'install' | 'state-write'
  readonly durationMs: number
}

type TimingReporter = (timing: PluginSyncTiming) => void

export interface PluginSyncResult {
  readonly installed: readonly string[]
  readonly upgraded: readonly string[]
  readonly skippedRemoved: readonly string[]
  readonly migrated: boolean
}

/** 定位开发或绿色发行版生成的插件安装介质目录。 */
export function resolvePluginMediaDirectory(options: {
  readonly launcherDirectory: string
  readonly configured?: string | undefined
}): string {
  const candidates = [
    options.configured,
    // 绿色包入口位于 <release>/dist/index.js。
    join(options.launcherDirectory, '..', 'plugins'),
    // 源码入口位于 packages/launcher/{src,dist}。
    join(options.launcherDirectory, '..', '..', '..', '.dev', 'plugins'),
  ].filter((candidate): candidate is string => candidate !== undefined && candidate !== '')
  const found = candidates.map(candidate => resolve(candidate))
    .find(candidate => fs.existsSync(join(candidate, 'catalog.json')))
  if (found === undefined) {
    throw new LauncherError(
      '找不到 dsh-station 插件安装目录。',
      { hint: '开发模式请重新运行 pnpm run dev；发行包应包含 plugins/catalog.json。' },
    )
  }
  return found
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(path: string): unknown {
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}

function writeTextAtomically(path: string, text: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' })
    fs.renameSync(temporary, path)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

function readState(directory: string): LifecycleState | { readonly ensured: readonly string[] } | undefined {
  try {
    const value = readJson(join(directory, STATE_FILE))
    if (!isObject(value)) return undefined
    if (value.schemaVersion === 2 && Array.isArray(value.offered) && value.offered.every(item => typeof item === 'string')
      && isObject(value.versions) && Object.values(value.versions).every(item => typeof item === 'string')
      && (value.stamps === undefined
        || (isObject(value.stamps) && Object.values(value.stamps).every(item => typeof item === 'string')))) {
      return {
        schemaVersion: 2,
        offered: value.offered,
        versions: value.versions as Record<string, string>,
        ...value.stamps === undefined ? {} : { stamps: value.stamps as Record<string, string> },
      }
    }
    if (Array.isArray(value.ensured) && value.ensured.every(item => typeof item === 'string')) {
      return { ensured: value.ensured }
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * 介质目录的内容指纹：目录树内全部相对路径与文件字节一并哈希。
 * 开发栈每次构建都会重写 `.dev/plugins`，版本号不变内容也会变，
 * 因此快路径不能只比对版本；目录按名称排序保证不同平台遍历顺序稳定。
 */
function directoryStamp(directory: string): string {
  const hash = createHash('sha256')
  const walk = (current: string, prefix: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      hash.update(`${relative}\0`)
      if (entry.isDirectory()) {
        walk(join(current, entry.name), relative)
        continue
      }
      // 符号链接按目标内容哈希（readFileSync 跟随链接），与物化复制语义一致。
      if (entry.isFile() || entry.isSymbolicLink()) hash.update(fs.readFileSync(join(current, entry.name)))
    }
  }
  walk(directory, '')
  return hash.digest('hex')
}

function readMedia(directory: string): readonly MediaEntry[] {
  const raw = readJson(join(directory, 'catalog.json'))
  if (!isObject(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.plugins)) {
    throw new TypeError(`插件安装目录 ${directory} 的 catalog.json 格式无效`)
  }
  return raw.plugins.map((value) => {
    if (!isObject(value) || typeof value.name !== 'string' || typeof value.version !== 'string'
      || typeof value.directory !== 'string' || !Array.isArray(value.components)
      || !value.components.every(component => isObject(component)
        && typeof component.name === 'string' && typeof component.rowId === 'string'
        && (component.toggleable === undefined || typeof component.toggleable === 'boolean'))) {
      throw new TypeError(`插件安装目录 ${directory} 的 catalog.json 包含无效条目`)
    }
    const packageDirectory = resolve(directory, value.directory)
    if (!isAbsolute(packageDirectory) || !fs.existsSync(join(packageDirectory, 'package.json'))) {
      throw new Error(`插件安装介质不存在：${packageDirectory}`)
    }
    return {
      name: value.name,
      version: value.version,
      directory: packageDirectory,
      components: value.components as unknown as MediaEntry['components'],
    }
  })
}

function runtimeDependencyNames(media: readonly MediaEntry[]): ReadonlySet<string> {
  const names = new Set<string>()
  for (const entry of media) {
    const packageDirectories = [entry.directory, ...entry.components
      .filter(component => component.name !== entry.name)
      .map(component => join(entry.directory, 'node_modules', ...component.name.split('/')))]
    for (const packageDirectory of packageDirectories) {
      const manifestPath = join(packageDirectory, 'package.json')
      if (!fs.existsSync(manifestPath)) continue
      const manifest = readJson(manifestPath)
      if (!isObject(manifest)) continue
      for (const dependencies of [manifest.dependencies, manifest.optionalDependencies]) {
        if (!isObject(dependencies)) continue
        for (const name of Object.keys(dependencies)) {
          if (!name.startsWith('@dsh-station/dsh-plugin-')) names.add(name)
        }
      }
    }
  }
  return names
}

/** 找到 llm-pi-ai 实际引用的目录，避免插件修改另一份同版本的模型表。 */
function dshModelCatalog(installAnchor: string): string {
  const adapter = createRequire(installAnchor).resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')
  const catalog = adapter === undefined ? undefined : findPackageJSON(SHARED_MODEL_CATALOG, pathToFileURL(adapter).href)
  if (catalog === undefined) throw new Error('找不到 dsh llm-pi-ai 使用的 pi-ai 模型目录')
  return fs.realpathSync(dirname(catalog))
}

/** 网页抓取通过模块内的 proxyRouteFor 读取策略，插件必须链接 dsh 实际导入的同一份实例。 */
function dshHttpProxy(installAnchor: string): string {
  const dsh = createRequire(installAnchor).resolve('@deepseek-ai/dsh/package.json')
  const proxy = createRequire(dsh).resolve(`${SHARED_HTTP_PROXY}/package.json`)
  return fs.realpathSync(dirname(proxy))
}

async function copyRuntimeDependencyClosure(
  sourceModules: string,
  targetModules: string,
  seeds: ReadonlySet<string>,
  installAnchor: string,
  onTiming: TimingReporter | undefined,
): Promise<void> {
  const started = performance.now()
  const trees: PluginCopyTree[] = []
  const links: { source: string, target: string }[] = []
  const pending = [...seeds]
  const copied = new Set<string>()
  while (pending.length > 0) {
    const requested = pending.shift() as string
    if (copied.has(requested)) continue
    const source = join(sourceModules, ...requested.split('/'))
    const manifestPath = join(source, 'package.json')
    if (!fs.existsSync(manifestPath)) throw new Error(`随包运行时缺少插件依赖：${requested}`)
    const manifest = readJson(manifestPath)
    if (!isObject(manifest) || typeof manifest.name !== 'string') {
      throw new TypeError(`随包运行时依赖 manifest 无效：${manifestPath}`)
    }
    const existing = copied.has(manifest.name)
    if (existing) continue
    copied.add(manifest.name)
    const target = join(targetModules, ...manifest.name.split('/'))
    if (manifest.name === SHARED_MODEL_CATALOG) {
      const shared = dshModelCatalog(installAnchor)
      const sharedManifest = readJson(join(shared, 'package.json'))
      if (!isObject(sharedManifest) || sharedManifest.version !== manifest.version) {
        throw new Error(`dsh 与模型插件使用的 pi-ai 版本不一致：${String(sharedManifest && isObject(sharedManifest) ? sharedManifest.version : '?')} / ${String(manifest.version)}`)
      }
      // Node 按真实路径缓存 ESM；复制目录即使版本相同也会产生互不可见的 model map。
      links.push({ source: shared, target })
    } else if (manifest.name === SHARED_HTTP_PROXY) {
      const shared = dshHttpProxy(installAnchor)
      const sharedManifest = readJson(join(shared, 'package.json'))
      if (!isObject(sharedManifest) || sharedManifest.version !== manifest.version) {
        throw new Error(`dsh 与代理插件使用的 http-proxy 版本不一致：${String(sharedManifest && isObject(sharedManifest) ? sharedManifest.version : '?')} / ${String(manifest.version)}`)
      }
      links.push({ source: shared, target })
    } else {
      // 先解析 pnpm 的目录链接，普通依赖仍复制成自包含文件，不扩大共享范围。
      trees.push({ source: fs.realpathSync(source), target, excludeNodeModules: true })
    }
    if (isObject(manifest.dependencies)) pending.push(...Object.keys(manifest.dependencies))
    if (isObject(manifest.optionalDependencies)) {
      for (const name of Object.keys(manifest.optionalDependencies)) {
        if (fs.existsSync(join(sourceModules, ...name.split('/')))) pending.push(name)
      }
    }
  }
  onTiming?.({ phase: 'dependency-resolve', durationMs: performance.now() - started })
  const copyStarted = performance.now()
  for (const link of links) {
    fs.mkdirSync(dirname(link.target), { recursive: true })
    fs.symlinkSync(link.source, link.target, process.platform === 'win32' ? 'junction' : 'dir')
  }
  await copyPluginTrees(trees)
  onTiming?.({ phase: 'dependency-copy', durationMs: performance.now() - copyStarted })
}

async function materializeProfileMedia(
  directory: string,
  media: readonly MediaEntry[],
  runtimeModulesDirectory: string | undefined,
  installAnchor: string,
  onTiming: TimingReporter | undefined,
): Promise<readonly MediaEntry[]> {
  const started = performance.now()
  const cache = join(directory, PROFILE_MEDIA_DIRECTORY)
  fs.mkdirSync(cache, { recursive: true })
  const result = media.map((entry) => {
    const target = join(cache, basename(entry.directory))
    // dsh 尚未启动，直接刷新缓存可避开 Windows 对含嵌套包目录 rename 的限制。
    fs.rmSync(target, { recursive: true, force: true })
    return { ...entry, directory: target }
  })
  await copyPluginTrees(result.map((entry, index) => ({ source: (media[index] as MediaEntry).directory, target: entry.directory })))
  onTiming?.({ phase: 'plugin-copy', durationMs: performance.now() - started })
  const dependencies = runtimeDependencyNames(result)
  if (dependencies.size > 0) {
    if (runtimeModulesDirectory === undefined) throw new Error('没有提供随包运行时依赖目录')
    const targetModules = join(cache, 'node_modules')
    fs.rmSync(targetModules, { recursive: true, force: true })
    fs.mkdirSync(targetModules, { recursive: true })
    await copyRuntimeDependencyClosure(runtimeModulesDirectory, targetModules, dependencies, installAnchor, onTiming)
  }
  return result
}

function profileManifest(path: string): JsonObject & {
  dependencies: Record<string, string>
  dsh: { profile: { bundles: string[] } }
} {
  const value = readJson(path)
  if (!isObject(value) || !isObject(value.dependencies) || !isObject(value.dsh)
    || !isObject(value.dsh.profile) || !Array.isArray(value.dsh.profile.bundles)
    || !value.dsh.profile.bundles.every(item => typeof item === 'string')) {
    throw new TypeError(`无效的 dsh profile manifest：${path}`)
  }
  return value as JsonObject & { dependencies: Record<string, string>, dsh: { profile: { bundles: string[] } } }
}

function insertDistributions(existing: readonly string[], enabled: ReadonlySet<string>): string[] {
  const allComponents = new Set(PLUGIN_DISTRIBUTIONS.flatMap(item => item.components.map(component => component.name)))
  const allDistributions = new Set(PLUGIN_DISTRIBUTIONS.map(item => item.name))
  const kept = existing.filter(name => !allComponents.has(name) && !allDistributions.has(name))
  const insertion = PLUGIN_DISTRIBUTIONS.filter(item => enabled.has(item.name)).map(item => item.name)
  const webIndex = kept.indexOf(DSH_WEB_APP_BUNDLE)
  kept.splice(webIndex < 0 ? kept.length : webIndex + 1, 0, ...insertion)
  return kept
}

function preserveDisabledRows(path: string, rows: readonly { readonly rowId: string }[]): void {
  if (rows.length === 0) return
  const text = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '[]\n'
  const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new TypeError(`Profile patch 必须是 YAML 数组：${path}`)
  let changed = false
  for (const row of rows) {
    const present = document.contents.items.some((item, index) => isMap(item)
      && document.getIn([index, 'id']) === row.rowId && !item.has('insert'))
    if (present) continue
    document.add({ id: row.rowId, disabled: true })
    changed = true
  }
  if (changed) writeTextAtomically(path, String(document))
}

function sameDistribution(a: PluginDistribution, b: MediaEntry): boolean {
  return a.name === b.name
    && a.components.length === b.components.length
    && a.components.every((component, index) => component.name === b.components[index]?.name
      && component.rowId === b.components[index]?.rowId
      && component.toggleable === b.components[index]?.toggleable)
}

function pnpmMajor(value: string | undefined): number | undefined {
  const match = /^(?:pnpm@)?(\d+)(?:\.|$)/u.exec(value ?? '')
  return match === null ? undefined : Number(match[1])
}

function profilePackageManager(directory: string): string | undefined {
  const modulesManifest = join(directory, 'node_modules', '.modules.yaml')
  if (!fs.existsSync(modulesManifest)) return undefined
  try {
    const metadata = parseDocument(fs.readFileSync(modulesManifest, 'utf8')).toJS() as { packageManager?: unknown }
    return typeof metadata.packageManager === 'string' ? metadata.packageManager : undefined
  } catch {
    return undefined
  }
}

function restorePackageManagerMigration(directory: string): void {
  const migration = join(directory, PACKAGE_MANAGER_MIGRATION_DIRECTORY)
  if (!fs.existsSync(migration)) return
  const savedModules = join(migration, 'node_modules')
  if (fs.existsSync(savedModules)) {
    fs.rmSync(join(directory, 'node_modules'), { recursive: true, force: true })
    fs.renameSync(savedModules, join(directory, 'node_modules'))
  }
  const savedManifest = join(migration, 'package.json')
  if (fs.existsSync(savedManifest)) fs.copyFileSync(savedManifest, join(directory, 'package.json'))
  const savedLockfile = join(migration, 'pnpm-lock.yaml')
  if (fs.existsSync(savedLockfile)) fs.copyFileSync(savedLockfile, join(directory, 'pnpm-lock.yaml'))
  else {
    const metadataPath = join(migration, 'metadata.json')
    const metadata = fs.existsSync(metadataPath) ? readJson(metadataPath) : undefined
    if (isObject(metadata) && metadata.lockfileExisted === false) {
      fs.rmSync(join(directory, 'pnpm-lock.yaml'), { force: true })
    }
  }
  fs.rmSync(migration, { recursive: true, force: true })
}

/** 暂存旧 node_modules；pnpm 主版本改变时只能删除后重装，失败则恢复原 profile。 */
function beginPackageManagerMigration(directory: string): { commit: () => void, rollback: () => void } {
  restorePackageManagerMigration(directory)
  const migration = join(directory, PACKAGE_MANAGER_MIGRATION_DIRECTORY)
  fs.mkdirSync(migration)
  const lockfile = join(directory, 'pnpm-lock.yaml')
  writeTextAtomically(join(migration, 'metadata.json'), `${JSON.stringify({ lockfileExisted: fs.existsSync(lockfile) })}\n`)
  fs.copyFileSync(join(directory, 'package.json'), join(migration, 'package.json'))
  if (fs.existsSync(lockfile)) fs.copyFileSync(lockfile, join(migration, 'pnpm-lock.yaml'))
  const modules = join(directory, 'node_modules')
  if (fs.existsSync(modules)) fs.renameSync(modules, join(migration, 'node_modules'))
  return {
    commit: () => fs.rmSync(migration, { recursive: true, force: true }),
    rollback: () => restorePackageManagerMigration(directory),
  }
}

/**
 * 首次安装、旧 profile 迁移以及后续配套升级。
 * 当前安装事实来自 profile dependencies；状态文件只区分“尚未提供”和“用户已经卸载”。
 */
export async function synchronizePluginDistributions(options: {
  readonly home: string
  readonly profile: string
  readonly mediaDirectory: string
  readonly installAnchor: string
  readonly runtimeModulesDirectory?: string
  readonly profileCreated: boolean
  readonly packageManager?: PackageManagerCommand
  readonly onOutput?: (text: string, stream: 'stdout' | 'stderr') => void
  readonly onTiming?: TimingReporter
}): Promise<PluginSyncResult> {
  const started = performance.now()
  const directory = profileDirectory(options.home, options.profile)
  restorePackageManagerMigration(directory)
  const manifestPath = join(directory, 'package.json')
  const patchPath = join(directory, 'cordis.patch.yml')
  const pendingPath = join(directory, MEDIA_PENDING_FILE)
  const sourceMedia = readMedia(options.mediaDirectory)
  if (sourceMedia.length !== PLUGIN_DISTRIBUTIONS.length
    || sourceMedia.some((entry, index) => !sameDistribution(PLUGIN_DISTRIBUTIONS[index] as PluginDistribution, entry))) {
    throw new Error('插件安装介质与 launcher 清单不一致')
  }
  const before = profileManifest(manifestPath)
  const dependencies = new Set(Object.keys(before.dependencies))
  const selected = new Set(before.dsh.profile.bundles)
  const previousState = readState(directory)
  const currentState = previousState !== undefined && 'schemaVersion' in previousState ? previousState : undefined
  const legacyEnsured = new Set(previousState !== undefined && 'ensured' in previousState ? previousState.ensured : [])
  const hasLegacySelection = PLUGIN_DISTRIBUTIONS.some(item => item.components.some(component => selected.has(component.name)))
  const migrate = currentState === undefined && (legacyEnsured.size > 0 || hasLegacySelection)

  // 启动快路径：状态文件记录的版本与介质指纹一致、profile 依赖与链接完好时，
  // 介质物化和 pnpm 安装无需重复执行，可直接跳过。
  // 任一条件不满足（新介质条目、版本或内容变化、链接缺失、迁移）走完整路径。
  if (currentState !== undefined && !migrate && !options.profileCreated && !fs.existsSync(pendingPath)
    && sourceMedia.every((entry) => {
      if (!currentState.offered.includes(entry.name)) return false
      if (!dependencies.has(entry.name)) return true
      if (currentState.versions[entry.name] !== entry.version) return false
      if (currentState.stamps?.[entry.name] !== directoryStamp(entry.directory)) return false
      return fs.existsSync(join(directory, 'node_modules', ...entry.name.split('/'), 'package.json'))
    })) {
    options.onTiming?.({ phase: 'check', durationMs: performance.now() - started })
    return {
      installed: [],
      upgraded: [],
      skippedRemoved: sourceMedia
        .filter(entry => currentState.offered.includes(entry.name) && !dependencies.has(entry.name))
        .map(entry => entry.name),
      migrated: false,
    }
  }

  options.onTiming?.({ phase: 'check', durationMs: performance.now() - started })
  // 保留旧 offered 状态；中断标记阻止半成品在下次启动误入快路径。
  writeTextAtomically(pendingPath, 'pending\n')
  // profile 可能与安装介质分处不同 Windows 盘符；先复制到同盘缓存再交给 pnpm 建 link。
  const media = await materializeProfileMedia(directory, sourceMedia, options.runtimeModulesDirectory, options.installAnchor, options.onTiming)
  const offered = new Set(currentState?.offered ?? [])
  const install: MediaEntry[] = []
  const enabled = new Set<string>()
  const disabledRows: { rowId: string }[] = []

  for (const entry of media) {
    const known = offered.has(entry.name)
    const alreadyInstalled = dependencies.has(entry.name)
    const newlyOffered = !known && !migrate
    let shouldInstall = alreadyInstalled || options.profileCreated || newlyOffered
    let shouldEnable = selected.has(entry.name) || options.profileCreated || newlyOffered

    if (migrate) {
      const componentInstalled = entry.components.some(component => dependencies.has(component.name))
      const componentSelected = entry.components.filter(component => selected.has(component.name))
      const componentKnown = entry.components.some(component => legacyEnsured.has(component.name))
      const legacyFilesRemoved = entry.name === LEGACY_FILES
        && !componentInstalled && componentSelected.length === 0
      shouldInstall = alreadyInstalled || componentInstalled || componentSelected.length > 0 || (componentKnown && !legacyFilesRemoved)
      shouldEnable = selected.has(entry.name) || componentSelected.length > 0
      if (shouldInstall && entry.components.length > 1) {
        for (const component of entry.components) {
          if (component.toggleable !== false && !selected.has(component.name)) disabledRows.push({ rowId: component.rowId })
        }
      }
    } else if (known && !alreadyInstalled) {
      shouldInstall = false
      shouldEnable = false
    }

    offered.add(entry.name)
    if (shouldInstall) install.push(entry)
    if (shouldInstall && shouldEnable) enabled.add(entry.name)
  }

  const installedBefore = new Set(media.filter(entry => dependencies.has(entry.name)).map(entry => entry.name))
  const { version: packageManagerVersion, ...packageManager } = options.packageManager ?? {}
  const existingPackageManager = profilePackageManager(directory)
  const needsPackageManagerMigration = install.length > 0
    && pnpmMajor(existingPackageManager) !== undefined
    && pnpmMajor(packageManagerVersion) !== undefined
    && pnpmMajor(existingPackageManager) !== pnpmMajor(packageManagerVersion)
  const migration = needsPackageManagerMigration ? beginPackageManagerMigration(directory) : undefined
  if (migration !== undefined) {
    options.onOutput?.(
      `[dsh-station] Profile 由 ${existingPackageManager} 安装，正在用随包 pnpm@${packageManagerVersion} 重建依赖链接。\n`,
      'stdout',
    )
  }
  if (install.length > 0) {
    const installStarted = performance.now()
    const result = await runPluginCommand({
      profile: options.profile,
      dir: directory,
      home: options.home,
      installAnchor: options.installAnchor,
      cwd: process.cwd(),
    }, ['add', ...install.map(entry => entry.directory)], {
      execution: 'service',
      outputBytes: 64 * 1024,
      activateNewBundles: false,
      ...packageManager,
      ...options.onOutput === undefined ? {} : { onOutput: options.onOutput },
    })
    if (result.exitCode !== 0) {
      migration?.rollback()
      throw new Error(`安装或升级随附插件失败：${result.output || result.logPath}`)
    }
    migration?.commit()
    options.onTiming?.({ phase: 'install', durationMs: performance.now() - installStarted })
  }

  if (migrate) {
    const groupedComponents = media.flatMap(entry => entry.components)
      .filter(component => !media.some(candidate => candidate.name === component.name))
      .map(component => component.name)
      .filter(name => profileManifest(manifestPath).dependencies[name] !== undefined)
    if (groupedComponents.length > 0) {
      const result = await runPluginCommand({
        profile: options.profile,
        dir: directory,
        home: options.home,
        installAnchor: options.installAnchor,
        cwd: process.cwd(),
      }, ['remove', ...groupedComponents], {
        execution: 'service',
        outputBytes: 64 * 1024,
        activateNewBundles: false,
        ...packageManager,
        ...options.onOutput === undefined ? {} : { onOutput: options.onOutput },
      })
      if (result.exitCode !== 0) throw new Error(`清理旧插件依赖失败：${result.output || result.logPath}`)
    }
    preserveDisabledRows(patchPath, disabledRows)
  }

  const stateStarted = performance.now()
  const after = profileManifest(manifestPath)
  after.dsh.profile.bundles = insertDistributions(after.dsh.profile.bundles, enabled)
  writeTextAtomically(manifestPath, `${JSON.stringify(after, undefined, 2)}\n`)
  // 指纹从源介质计算：物化副本是逐字节复制，两者一致，而源是快路径比对的对象。
  const versions = Object.fromEntries(install.map(entry => [entry.name, entry.version]))
  const stamps = Object.fromEntries(install.map((entry) => {
    const source = sourceMedia.find(candidate => candidate.name === entry.name)
    return [entry.name, directoryStamp((source ?? entry).directory)]
  }))
  writeTextAtomically(join(directory, STATE_FILE), `${JSON.stringify({
    schemaVersion: 2,
    offered: [...offered],
    versions,
    stamps,
  } satisfies LifecycleState, undefined, 2)}\n`)
  fs.rmSync(pendingPath)
  options.onTiming?.({ phase: 'state-write', durationMs: performance.now() - stateStarted })

  return {
    installed: install.filter(entry => !installedBefore.has(entry.name)).map(entry => entry.name),
    upgraded: install.filter(entry => installedBefore.has(entry.name)).map(entry => entry.name),
    skippedRemoved: media.filter(entry => offered.has(entry.name) && !install.includes(entry)).map(entry => entry.name),
    migrated: migrate,
  }
}

/** 默认 profile 的最小基础层；第三方插件由 synchronizePluginDistributions 安装。 */
export const BASE_PROFILE_BUNDLES = [DSH_BASE_BUNDLE, DSH_WEB_APP_BUNDLE] as const
