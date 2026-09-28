/** pnpm dev 与受管开发桌面共用的插件源码指纹缓存；不管理 profile 或后台进程。 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export function hashTree(hash, directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    hash.update(`${relative}\0`)
    const path = join(directory, entry.name)
    if (entry.isDirectory()) hashTree(hash, path, relative)
    else if (entry.isFile() || entry.isSymbolicLink()) hash.update(readFileSync(path))
  }
}

/** 不含 dist/node_modules；locale 与分发文档也是介质刷新输入。 */
export function packageBuildStamp(directory) {
  const hash = createHash('sha256')
  for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'src' || entry.name === 'locale') hashTree(hash, path, entry.name)
    } else if (entry.isFile()) {
      hash.update(`${entry.name}\0`).update(readFileSync(path))
    }
  }
  return hash.digest('hex')
}

export function fileStamp(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function computePluginBuildStamp(root) {
  const directories = readdirSync(join(root, 'packages', 'plugins'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(root, 'packages', 'plugins', entry.name))
  directories.push(join(root, 'packages', 'plugin-ui'))
  return {
    schemaVersion: 2,
    packages: Object.fromEntries(directories.toSorted().map(directory => [basename(directory), packageBuildStamp(directory)])),
    inputs: Object.fromEntries([
      'scripts/plugin-distributions.mjs', 'scripts/dev-plugin-build.mjs',
      'plugin-catalog.json', 'package.json', 'pnpm-lock.yaml', 'tsconfig.base.json',
    ].map(path => [path, fileStamp(join(root, path))])),
  }
}

export function readBuildStamp(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { return undefined }
}

export function writeBuildStamp(path, stamp) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(stamp, undefined, 2)}\n`)
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

/** 缓存命中也验证宿主/浏览器产物，避免删掉 dist 后仍沿用旧介质。 */
function packageArtifactsIntact(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const rootExport = manifest.exports?.['.']
  const files = [manifest.main, typeof rootExport === 'string' ? rootExport : rootExport?.import ?? rootExport?.default, manifest.dsh?.bundle?.patch,
    ...manifest.dsh?.client === undefined ? [] : [manifest.exports?.['./client']]]
  return files.every(path => path === undefined || (typeof path === 'string' && existsSync(join(directory, path))))
    && (manifest.dsh?.client === undefined || typeof manifest.exports?.['./client'] === 'string')
}

export function pluginArtifactsIntact(root) {
  try {
    const plugins = join(root, 'packages', 'plugins')
    for (const entry of readdirSync(plugins, { withFileTypes: true })) {
      if (entry.isDirectory() && !packageArtifactsIntact(join(plugins, entry.name))) return false
    }
    if (!packageArtifactsIntact(join(root, 'packages', 'plugin-ui'))) return false
    const media = join(root, '.dev', 'plugins')
    const catalog = JSON.parse(readFileSync(join(media, 'catalog.json'), 'utf8'))
    const source = JSON.parse(readFileSync(join(root, 'plugin-catalog.json'), 'utf8'))
    if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.plugins)
      || catalog.plugins.length !== source.distributions.length) return false
    return catalog.plugins.every((entry, index) => {
      const expected = source.distributions[index]
      if (entry.name !== expected.name || JSON.stringify(entry.components) !== JSON.stringify(expected.components)) return false
      const directory = resolve(media, entry.directory)
      return packageArtifactsIntact(directory) && entry.components.every(component => component.name === entry.name
        || packageArtifactsIntact(join(directory, 'node_modules', ...component.name.split('/'))))
    })
  } catch { return false }
}

export async function ensurePluginBuild({ root, runRootScript, log = console.log }) {
  const path = join(root, 'node_modules', '.cache', 'dsh-station', 'dev-plugin-build.json')
  const stamp = computePluginBuildStamp(root)
  if (JSON.stringify(readBuildStamp(path)) === JSON.stringify(stamp) && pluginArtifactsIntact(root)) {
    log('[dsh-station] 插件源码未变化，跳过构建与介质刷新（.dev/plugins 沿用）。')
    return false
  }
  await runRootScript('plugins:build')
  await runRootScript('plugins:prepare')
  if (!pluginArtifactsIntact(root)) throw new Error('插件构建或介质缺少宿主/浏览器产物。')
  writeBuildStamp(path, stamp)
  return true
}
