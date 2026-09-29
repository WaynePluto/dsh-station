import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_DISTRIBUTIONS } from '../src/plugin-catalog.js'
import { BASE_PROFILE_BUNDLES, resolvePluginMediaDirectory, synchronizePluginDistributions } from '../src/plugin-lifecycle.js'
import { ensureProfile, profileDirectory } from '../src/profile.js'

const runPluginCommand = vi.hoisted(() => vi.fn(async (
  context: { dir?: string },
  args: readonly string[],
  _options?: { readonly command?: string, readonly args?: readonly string[] },
) => {
  const directory = context.dir as string
  const path = join(directory, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(path, 'utf8')) as { dependencies: Record<string, string> }
  if (args[0] === 'add') {
    for (const source of args.slice(1)) {
      const plugin = JSON.parse(fs.readFileSync(join(source, 'package.json'), 'utf8')) as { name: string }
      manifest.dependencies[plugin.name] = `link:${source}`
    }
  } else if (args[0] === 'remove') {
    for (const name of args.slice(1)) delete manifest.dependencies[name]
  }
  fs.writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`)
  return { exitCode: 0, output: '', truncated: false, logPath: join(directory, 'mock.log') }
}))

vi.mock('@deepseek-ai/dsh-plugin-manager/operations', () => ({ runPluginCommand }))

const roots: string[] = []

afterEach(() => {
  runPluginCommand.mockClear()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-station-lifecycle-'))
  roots.push(root)
  const home = join(root, 'home')
  const media = join(root, 'plugins')
  fs.mkdirSync(media, { recursive: true })
  const plugins = PLUGIN_DISTRIBUTIONS.map((distribution) => {
    const directory = distribution.name.slice(distribution.name.lastIndexOf('/') + 1).replace(/^dsh-plugin-/u, '')
    fs.mkdirSync(join(media, directory), { recursive: true })
    fs.writeFileSync(join(media, directory, 'package.json'), JSON.stringify({
      name: distribution.name,
      version: '1.2.3',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    fs.writeFileSync(join(media, directory, 'cordis.patch.yml'), '[]\n')
    return { ...distribution, directory, version: '1.2.3' }
  })
  fs.writeFileSync(join(media, 'catalog.json'), JSON.stringify({ schemaVersion: 1, plugins }))
  return { root, home, media }
}

function readManifest(home: string) {
  return JSON.parse(fs.readFileSync(join(profileDirectory(home, 'dsh-station-web'), 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
}

describe('third-party plugin lifecycle', () => {
  it('finds media beside a packaged dist directory before a source-tree fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-station-media-'))
    roots.push(root)
    const packedDist = join(root, 'release', 'dist')
    const packedMedia = join(root, 'release', 'plugins')
    fs.mkdirSync(packedDist, { recursive: true })
    fs.mkdirSync(packedMedia, { recursive: true })
    fs.writeFileSync(join(packedMedia, 'catalog.json'), '{}')
    expect(resolvePluginMediaDirectory({ launcherDirectory: packedDist })).toBe(packedMedia)
  })

  it('installs and enables every distribution for a new profile', async () => {
    const { home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-station-web', bundles: BASE_PROFILE_BUNDLES })

    const result = await synchronizePluginDistributions({
      home,
      profile: 'dsh-station-web',
      mediaDirectory: media,
      installAnchor: import.meta.filename,
      profileCreated: true,
    })

    expect(result.installed).toEqual(PLUGIN_DISTRIBUTIONS.map(item => item.name))
    const manifest = readManifest(home)
    expect(Object.keys(manifest.dependencies)).toEqual(PLUGIN_DISTRIBUTIONS.map(item => item.name))
    const directory = profileDirectory(home, 'dsh-station-web')
    expect(Object.values(manifest.dependencies).every(spec => spec.startsWith(`link:${join(directory, '.dsh-station-plugin-media')}`))).toBe(true)
    expect(manifest.dsh.profile.bundles).toEqual([...BASE_PROFILE_BUNDLES, ...PLUGIN_DISTRIBUTIONS.map(item => item.name)])
  })

  it('copies the runtime dependency closure beside profile-local plugin media', async () => {
    const { root, home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-station-web', bundles: BASE_PROFILE_BUNDLES })
    const first = PLUGIN_DISTRIBUTIONS[0] as (typeof PLUGIN_DISTRIBUTIONS)[number]
    const source = join(media, first.name.slice(first.name.lastIndexOf('/') + 1).replace(/^dsh-plugin-/u, ''))
    const manifest = JSON.parse(fs.readFileSync(join(source, 'package.json'), 'utf8')) as Record<string, unknown>
    manifest.dependencies = { 'runtime-entry': '1.0.0' }
    fs.writeFileSync(join(source, 'package.json'), JSON.stringify(manifest))
    const runtimeModules = join(root, 'runtime-node-modules')
    for (const [name, dependencies] of [['runtime-entry', { 'runtime-leaf': '1.0.0' }], ['runtime-leaf', {}]] as const) {
      fs.mkdirSync(join(runtimeModules, name), { recursive: true })
      fs.writeFileSync(join(runtimeModules, name, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies }))
    }

    await synchronizePluginDistributions({
      home,
      profile: 'dsh-station-web',
      mediaDirectory: media,
      installAnchor: import.meta.filename,
      runtimeModulesDirectory: runtimeModules,
      profileCreated: true,
    })

    const cache = join(profileDirectory(home, 'dsh-station-web'), '.dsh-station-plugin-media', 'node_modules')
    expect(fs.existsSync(join(cache, 'runtime-entry', 'package.json'))).toBe(true)
    expect(fs.existsSync(join(cache, 'runtime-leaf', 'package.json'))).toBe(true)
  })

  it('links the same HTTP proxy module used by dsh web-fetch', async () => {
    const { root, home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-station-web', bundles: BASE_PROFILE_BUNDLES })
    const entry = PLUGIN_DISTRIBUTIONS.find(item => item.name === '@dsh-station/dsh-plugin-proxy')
    expect(entry).toBeDefined()
    const plugin = join(media, 'proxy')
    const pluginManifest = JSON.parse(fs.readFileSync(join(plugin, 'package.json'), 'utf8')) as Record<string, unknown>
    pluginManifest.dependencies = { '@deepseek-ai/dsh-http-proxy': '0.1.7-rc.1' }
    fs.writeFileSync(join(plugin, 'package.json'), JSON.stringify(pluginManifest))

    const modules = join(root, 'runtime', 'node_modules')
    const dsh = join(modules, '@deepseek-ai', 'dsh')
    const source = join(modules, '@deepseek-ai', 'dsh-http-proxy')
    const shared = join(dsh, 'node_modules', '@deepseek-ai', 'dsh-http-proxy')
    for (const directory of [dsh, source, shared]) fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.1' }))
    for (const directory of [source, shared]) {
      fs.writeFileSync(join(directory, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-http-proxy', version: '0.1.7-rc.1', dependencies: {},
      }))
    }
    fs.writeFileSync(join(source, 'identity'), 'plugin copy')
    fs.writeFileSync(join(shared, 'identity'), 'dsh module')

    await synchronizePluginDistributions({
      home, profile: 'dsh-station-web', mediaDirectory: media,
      installAnchor: join(dsh, 'package.json'), runtimeModulesDirectory: modules, profileCreated: true,
    })

    const linked = join(profileDirectory(home, 'dsh-station-web'), '.dsh-station-plugin-media',
      'node_modules', '@deepseek-ai', 'dsh-http-proxy')
    expect(fs.realpathSync(linked)).toBe(fs.realpathSync(shared))
    expect(fs.readFileSync(join(linked, 'identity'), 'utf8')).toBe('dsh module')
  })

  it('shares the exact pi-ai module used by the installed dsh adapter', async () => {
    const { root, home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-station-web', bundles: BASE_PROFILE_BUNDLES })
    const first = PLUGIN_DISTRIBUTIONS[0] as (typeof PLUGIN_DISTRIBUTIONS)[number]
    const plugin = join(media, first.name.slice(first.name.lastIndexOf('/') + 1).replace(/^dsh-plugin-/u, ''))
    const pluginManifest = JSON.parse(fs.readFileSync(join(plugin, 'package.json'), 'utf8')) as Record<string, unknown>
    pluginManifest.dependencies = { '@earendil-works/pi-ai': '0.85.1' }
    fs.writeFileSync(join(plugin, 'package.json'), JSON.stringify(pluginManifest))

    const modules = join(root, 'runtime', 'node_modules')
    const adapter = join(modules, '@deepseek-ai', 'dsh-llm-pi-ai')
    const catalog = join(adapter, 'node_modules', '@earendil-works', 'pi-ai')
    const source = join(modules, '@earendil-works', 'pi-ai')
    const dsh = join(modules, '@deepseek-ai', 'dsh')
    for (const [directory, name] of [[adapter, '@deepseek-ai/dsh-llm-pi-ai'], [catalog, '@earendil-works/pi-ai'],
      [source, '@earendil-works/pi-ai'], [dsh, '@deepseek-ai/dsh']] as const) {
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '0.85.1', exports: { '.': './index.js', './package.json': './package.json' } }))
      fs.writeFileSync(join(directory, 'index.js'), '')
    }
    fs.writeFileSync(join(catalog, 'identity'), 'dsh module')
    fs.writeFileSync(join(source, 'identity'), 'plugin copy')

    await synchronizePluginDistributions({
      home,
      profile: 'dsh-station-web',
      mediaDirectory: media,
      installAnchor: join(dsh, 'package.json'),
      runtimeModulesDirectory: modules,
      profileCreated: true,
    })

    const linked = join(profileDirectory(home, 'dsh-station-web'), '.dsh-station-plugin-media',
      'node_modules', '@earendil-works', 'pi-ai')
    expect(fs.realpathSync(linked)).toBe(fs.realpathSync(catalog))
    expect(fs.readFileSync(join(linked, 'identity'), 'utf8')).toBe('dsh module')
  })

  it('rebuilds links created by another pnpm major version', async () => {
    const { home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-station-web', bundles: BASE_PROFILE_BUNDLES })
    const directory = profileDirectory(home, 'dsh-station-web')
    fs.mkdirSync(join(directory, 'node_modules'), { recursive: true })
    fs.writeFileSync(join(directory, 'node_modules', '.modules.yaml'), 'packageManager: pnpm@12.4.1\n')
    const output = vi.fn()

    await synchronizePluginDistributions({
      home,
      profile: 'dsh-station-web',
      mediaDirectory: media,
      installAnchor: import.meta.filename,
      profileCreated: true,
      packageManager: { command: 'node', args: ['pnpm.cjs'], version: '10.17.0' },
      onOutput: output,
    })

    expect(runPluginCommand.mock.calls[0]?.[2]?.args).toEqual(['pnpm.cjs'])
    expect(fs.existsSync(join(directory, '.dsh-station-package-manager-migration'))).toBe(false)
    expect(output).toHaveBeenCalledWith(expect.stringContaining('pnpm@12.4.1'), 'stdout')
  })

  it('restores the old profile when package-manager migration fails', async () => {
    const { home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-station-web', bundles: BASE_PROFILE_BUNDLES })
    const directory = profileDirectory(home, 'dsh-station-web')
    fs.mkdirSync(join(directory, 'node_modules'), { recursive: true })
    fs.writeFileSync(join(directory, 'node_modules', '.modules.yaml'), 'packageManager: pnpm@12.4.1\n')
    fs.writeFileSync(join(directory, 'node_modules', 'sentinel'), 'old modules')
    const originalManifest = fs.readFileSync(join(directory, 'package.json'), 'utf8')
    runPluginCommand.mockImplementationOnce(async () => ({
      exitCode: 1,
      output: 'install failed',
      truncated: false,
      logPath: join(directory, 'mock.log'),
    }))

    await expect(synchronizePluginDistributions({
      home,
      profile: 'dsh-station-web',
      mediaDirectory: media,
      installAnchor: import.meta.filename,
      profileCreated: true,
      packageManager: { command: 'node', args: ['pnpm.cjs'], version: '10.17.0' },
    })).rejects.toThrow('install failed')

    expect(fs.readFileSync(join(directory, 'node_modules', 'sentinel'), 'utf8')).toBe('old modules')
    expect(fs.readFileSync(join(directory, 'package.json'), 'utf8')).toBe(originalManifest)
    expect(fs.existsSync(join(directory, '.dsh-station-package-manager-migration'))).toBe(false)
  })

  it('upgrades installed but disabled bundles without re-enabling removed bundles', async () => {
    const { home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-station-web', bundles: BASE_PROFILE_BUNDLES })
    await synchronizePluginDistributions({
      home,
      profile: 'dsh-station-web',
      mediaDirectory: media,
      installAnchor: import.meta.filename,
      profileCreated: true,
    })
    const directory = profileDirectory(home, 'dsh-station-web')
    const manifest = readManifest(home)
    const disabled = PLUGIN_DISTRIBUTIONS[1]?.name as string
    const removed = PLUGIN_DISTRIBUTIONS[7]?.name as string
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== disabled && name !== removed)
    delete manifest.dependencies[removed]
    fs.writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
    runPluginCommand.mockClear()

    const result = await synchronizePluginDistributions({
      home,
      profile: 'dsh-station-web',
      mediaDirectory: media,
      installAnchor: import.meta.filename,
      profileCreated: false,
    })

    expect(result.upgraded).toContain(disabled)
    expect(result.skippedRemoved).toContain(removed)
    const after = readManifest(home)
    expect(after.dsh.profile.bundles).not.toContain(disabled)
    expect(after.dsh.profile.bundles).not.toContain(removed)
    expect(after.dependencies[removed]).toBeUndefined()
  })

  it('does not silently uninstall an existing package removed from the project catalog', async () => {
    const { home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-station-web', bundles: BASE_PROFILE_BUNDLES })
    await synchronizePluginDistributions({ home, profile: 'dsh-station-web', mediaDirectory: media,
      installAnchor: import.meta.filename, profileCreated: true })
    const directory = profileDirectory(home, 'dsh-station-web')
    const manifest = readManifest(home)
    const old = '@example/retired-optional-plugin'
    manifest.dependencies[old] = 'link:old-installed-package'
    manifest.dsh.profile.bundles.push(old)
    fs.writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)

    await synchronizePluginDistributions({ home, profile: 'dsh-station-web', mediaDirectory: media,
      installAnchor: import.meta.filename, profileCreated: false })
    expect(readManifest(home).dependencies[old]).toBe('link:old-installed-package')
    expect(readManifest(home).dsh.profile.bundles).toContain(old)
  })

  it('skips media refresh and the package manager when nothing changed since the last sync', async () => {
    const { home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-station-web', bundles: BASE_PROFILE_BUNDLES })
    await synchronizePluginDistributions({ home, profile: 'dsh-station-web', mediaDirectory: media,
      installAnchor: import.meta.filename, profileCreated: true })
    const directory = profileDirectory(home, 'dsh-station-web')
    // 快路径用 profile node_modules 里的包存在性校验链接完好；mock 的包管理器
    // 不会真的安装，这里手动补齐等价物。
    for (const item of PLUGIN_DISTRIBUTIONS) {
      const target = join(directory, 'node_modules', ...item.name.split('/'))
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(join(target, 'package.json'), JSON.stringify({ name: item.name, version: '1.2.3' }))
    }
    const stateBefore = fs.readFileSync(join(directory, 'dsh-station-bundles-state.json'), 'utf8')
    const manifestBefore = fs.readFileSync(join(directory, 'package.json'), 'utf8')
    runPluginCommand.mockClear()

    const result = await synchronizePluginDistributions({ home, profile: 'dsh-station-web', mediaDirectory: media,
      installAnchor: import.meta.filename, profileCreated: false })

    expect(runPluginCommand).not.toHaveBeenCalled()
    expect(result.installed).toEqual([])
    expect(result.upgraded).toEqual([])
    expect(fs.readFileSync(join(directory, 'dsh-station-bundles-state.json'), 'utf8')).toBe(stateBefore)
    expect(fs.readFileSync(join(directory, 'package.json'), 'utf8')).toBe(manifestBefore)
  })

  it('leaves the fast path when a media version changes even with intact links', async () => {
    const { home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-station-web', bundles: BASE_PROFILE_BUNDLES })
    await synchronizePluginDistributions({ home, profile: 'dsh-station-web', mediaDirectory: media,
      installAnchor: import.meta.filename, profileCreated: true })
    const directory = profileDirectory(home, 'dsh-station-web')
    for (const item of PLUGIN_DISTRIBUTIONS) {
      const target = join(directory, 'node_modules', ...item.name.split('/'))
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(join(target, 'package.json'), JSON.stringify({ name: item.name, version: '1.2.3' }))
    }
    const first = PLUGIN_DISTRIBUTIONS[0] as (typeof PLUGIN_DISTRIBUTIONS)[number]
    const catalogPath = join(media, 'catalog.json')
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as { plugins: { name: string, version: string }[] }
    const entry = catalog.plugins.find(item => item.name === first.name)
    if (entry === undefined) throw new Error('catalog entry missing')
    entry.version = '1.3.0'
    fs.writeFileSync(catalogPath, JSON.stringify(catalog))
    runPluginCommand.mockClear()

    const result = await synchronizePluginDistributions({ home, profile: 'dsh-station-web', mediaDirectory: media,
      installAnchor: import.meta.filename, profileCreated: false })

    expect(runPluginCommand).toHaveBeenCalled()
    expect(result.upgraded).toContain(first.name)
  })

  it('leaves the fast path when media content changes without a version bump', async () => {
    const { home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-station-web', bundles: BASE_PROFILE_BUNDLES })
    await synchronizePluginDistributions({ home, profile: 'dsh-station-web', mediaDirectory: media,
      installAnchor: import.meta.filename, profileCreated: true })
    const directory = profileDirectory(home, 'dsh-station-web')
    for (const item of PLUGIN_DISTRIBUTIONS) {
      const target = join(directory, 'node_modules', ...item.name.split('/'))
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(join(target, 'package.json'), JSON.stringify({ name: item.name, version: '1.2.3' }))
    }
    // 开发栈每次构建都重写 .dev/plugins，版本号不变而内容会变：
    // 内容指纹必须让快路径失效并重新物化。
    const first = PLUGIN_DISTRIBUTIONS[0] as (typeof PLUGIN_DISTRIBUTIONS)[number]
    const pluginDirectory = join(media, first.name.slice(first.name.lastIndexOf('/') + 1).replace(/^dsh-plugin-/u, ''))
    fs.mkdirSync(join(pluginDirectory, 'dist'), { recursive: true })
    fs.writeFileSync(join(pluginDirectory, 'dist', 'index.js'), 'export const rebuilt = true\n')
    runPluginCommand.mockClear()

    const result = await synchronizePluginDistributions({ home, profile: 'dsh-station-web', mediaDirectory: media,
      installAnchor: import.meta.filename, profileCreated: false })

    expect(runPluginCommand).toHaveBeenCalled()
    expect(result.upgraded).toContain(first.name)
    expect(fs.readFileSync(join(profileDirectory(home, 'dsh-station-web'), '.dsh-station-plugin-media',
      pluginDirectory.slice(media.length + 1), 'dist', 'index.js'), 'utf8')).toBe('export const rebuilt = true\n')
  })

  it('reports only completed fixed timing phases and measures the unchanged fast path separately', async () => {
    const { home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-station-web', bundles: BASE_PROFILE_BUNDLES })
    const onTiming = vi.fn()
    const options = { home, profile: 'dsh-station-web', mediaDirectory: media, installAnchor: import.meta.filename, onTiming }
    await synchronizePluginDistributions({ ...options, profileCreated: true })
    expect(onTiming.mock.calls.map(([timing]) => timing.phase)).toEqual(['check', 'plugin-copy', 'install', 'state-write'])
    for (const [timing] of onTiming.mock.calls) {
      expect(Object.keys(timing).toSorted()).toEqual(['durationMs', 'phase'])
      expect(Number.isFinite(timing.durationMs)).toBe(true)
      expect(timing.durationMs).toBeGreaterThanOrEqual(0)
    }
    const directory = profileDirectory(home, 'dsh-station-web')
    for (const item of PLUGIN_DISTRIBUTIONS) {
      const target = join(directory, 'node_modules', ...item.name.split('/'))
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(join(target, 'package.json'), '{}')
    }
    onTiming.mockClear()
    runPluginCommand.mockClear()
    await synchronizePluginDistributions({ ...options, profileCreated: false })
    expect(onTiming.mock.calls.map(([timing]) => timing.phase)).toEqual(['check'])
    expect(runPluginCommand).not.toHaveBeenCalled()
    expect(fs.existsSync(join(directory, '.dsh-station-plugin-media.pending'))).toBe(false)
  })

  it('retries incomplete same-version dependency copies without losing disabled or removed choices', async () => {
    const { root, home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-station-web', bundles: BASE_PROFILE_BUNDLES })
    const plugin = join(media, PLUGIN_DISTRIBUTIONS[0]!.name.split('/').at(-1)!.replace(/^dsh-plugin-/u, ''), 'package.json')
    const sourceManifest = JSON.parse(fs.readFileSync(plugin, 'utf8')) as Record<string, unknown>
    sourceManifest.dependencies = { 'runtime-entry': '1.0.0' }
    fs.writeFileSync(plugin, JSON.stringify(sourceManifest))
    const runtimeModules = join(root, 'runtime', 'node_modules')
    fs.mkdirSync(join(runtimeModules, 'runtime-entry'), { recursive: true })
    fs.writeFileSync(join(runtimeModules, 'runtime-entry', 'package.json'), JSON.stringify({ name: 'runtime-entry', version: '1.0.0' }))
    fs.writeFileSync(join(runtimeModules, 'runtime-entry', 'index.js'), 'complete runtime')
    const options = { home, profile: 'dsh-station-web', mediaDirectory: media, installAnchor: import.meta.filename,
      runtimeModulesDirectory: runtimeModules }
    await synchronizePluginDistributions({ ...options, profileCreated: true })
    const directory = profileDirectory(home, 'dsh-station-web')
    const statePath = join(directory, 'dsh-station-bundles-state.json')
    const stateBefore = fs.readFileSync(statePath, 'utf8')
    const disabled = PLUGIN_DISTRIBUTIONS[1]!.name
    const removed = PLUGIN_DISTRIBUTIONS[7]!.name
    const manifest = readManifest(home)
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== disabled && name !== removed)
    delete manifest.dependencies[removed]
    fs.writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
    const onTiming = vi.fn()
    const original = new Error('dependency copy failed')
    const copyFile = fs.promises.copyFile
    const copy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (...args) => {
      if (args[0] === join(runtimeModules, 'runtime-entry', 'index.js')) throw original
      await copyFile(...args)
    })
    runPluginCommand.mockClear()
    await expect(synchronizePluginDistributions({ ...options, profileCreated: false, onTiming })).rejects.toBe(original)
    expect(runPluginCommand).not.toHaveBeenCalled()
    expect(onTiming.mock.calls.map(([timing]) => timing.phase)).not.toContain('dependency-copy')
    expect(fs.existsSync(join(directory, '.dsh-station-plugin-media.pending'))).toBe(true)
    expect(fs.readFileSync(statePath, 'utf8')).toBe(stateBefore)
    expect(readManifest(home)).toEqual(manifest)
    copy.mockRestore()
    // 模拟重建 package.json 后链接又可达：中断标记仍必须阻止半成品走快路径。
    for (const name of Object.keys(manifest.dependencies)) {
      const target = join(directory, 'node_modules', ...name.split('/'))
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(join(target, 'package.json'), '{}')
    }
    const recovered = await synchronizePluginDistributions({ ...options, profileCreated: false })
    expect(runPluginCommand).toHaveBeenCalledTimes(1)
    expect(recovered.skippedRemoved).toContain(removed)
    expect(readManifest(home).dependencies[removed]).toBeUndefined()
    expect(readManifest(home).dsh.profile.bundles).not.toContain(disabled)
    expect(fs.existsSync(join(directory, '.dsh-station-plugin-media.pending'))).toBe(false)
    expect(fs.readFileSync(join(directory, '.dsh-station-plugin-media', 'node_modules', 'runtime-entry', 'index.js'), 'utf8'))
      .toBe('complete runtime')
  })

  it('keeps interrupted installation marked until a complete retry succeeds', async () => {
    const { home, media } = fixture()
    ensureProfile({ home, profile: 'dsh-station-web', bundles: BASE_PROFILE_BUNDLES })
    const options = { home, profile: 'dsh-station-web', mediaDirectory: media, installAnchor: import.meta.filename }
    runPluginCommand.mockImplementationOnce(async () => ({ exitCode: 1, output: 'install failed', truncated: false, logPath: 'mock.log' }))
    await expect(synchronizePluginDistributions({ ...options, profileCreated: true })).rejects.toThrow('install failed')
    const directory = profileDirectory(home, 'dsh-station-web')
    expect(fs.existsSync(join(directory, '.dsh-station-plugin-media.pending'))).toBe(true)
    expect(fs.existsSync(join(directory, 'dsh-station-bundles-state.json'))).toBe(false)
    await synchronizePluginDistributions({ ...options, profileCreated: false })
    expect(fs.existsSync(join(directory, '.dsh-station-plugin-media.pending'))).toBe(false)
    expect(readManifest(home).dsh.profile.bundles).toEqual([...BASE_PROFILE_BUNDLES, ...PLUGIN_DISTRIBUTIONS.map(item => item.name)])
  })

  it('migrates legacy bundles and preserves component and files removal choices', async () => {
    const { home, media } = fixture()
    const allComponents = PLUGIN_DISTRIBUTIONS.flatMap(item => item.components.map(component => component.name))
    const enabledComponents = allComponents.filter(name => !name.endsWith('notify') && !name.endsWith('files'))
    ensureProfile({ home, profile: 'dsh-station-web', bundles: [...BASE_PROFILE_BUNDLES, ...enabledComponents] })
    const directory = profileDirectory(home, 'dsh-station-web')
    fs.writeFileSync(join(directory, 'dsh-station-bundles-state.json'), JSON.stringify({ ensured: allComponents }))

    const result = await synchronizePluginDistributions({
      home,
      profile: 'dsh-station-web',
      mediaDirectory: media,
      installAnchor: import.meta.filename,
      profileCreated: false,
    })

    expect(result.migrated).toBe(true)
    expect(result.skippedRemoved).toContain('@dsh-station/dsh-plugin-files')
    const manifest = readManifest(home)
    expect(manifest.dsh.profile.bundles).toContain('@dsh-station/dsh-plugin-conversation-enhancements')
    expect(manifest.dsh.profile.bundles).not.toContain('@dsh-station/dsh-plugin-notify')
    expect(manifest.dependencies['@dsh-station/dsh-plugin-files']).toBeUndefined()
    const patch = fs.readFileSync(join(directory, 'cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/id: notify,?\s+disabled: true/u)
  })
})
