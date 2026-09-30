import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mediaDirectoryStamp, mediaStampFileContent } from '../packages/launcher/src/media-stamp.ts'

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_FILE = 'plugin-catalog.json'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function packageDirectoryName(packageName) {
  return packageName.slice(packageName.lastIndexOf('/') + 1).replace(/^dsh-plugin-/u, '')
}

function componentSource(root, packageName) {
  return join(root, 'packages', 'plugins', packageDirectoryName(packageName))
}

function normalizedManifest(manifest) {
  const dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).map(([name, version]) => [
    name,
    typeof version === 'string' && version.startsWith('workspace:') ? version.slice('workspace:'.length) : version,
  ]))
  return {
    ...manifest,
    ...Object.keys(dependencies).length === 0 ? {} : { dependencies },
  }
}

function copyPackage(source, target) {
  const manifestPath = join(source, 'package.json')
  const manifest = readJson(manifestPath)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(normalizedManifest(manifest), undefined, 2)}\n`)
  for (const entry of [...manifest.files ?? [], 'README.md']) {
    const from = join(source, entry)
    if (!existsSync(from)) throw new Error(`插件 ${manifest.name} 缺少分发文件：${entry}`)
    cpSync(from, join(target, entry), { recursive: true })
  }
  if (manifest.dsh?.bundle?.patch !== undefined && !existsSync(join(target, manifest.dsh.bundle.patch))) {
    throw new Error(`插件 ${manifest.name} 的 Bundle patch 未进入分发目录`)
  }
  if (manifest.main !== undefined && !existsSync(join(target, manifest.main))) {
    throw new Error(`插件 ${manifest.name} 缺少宿主产物：${manifest.main}`)
  }
  if (manifest.dsh?.client !== undefined) {
    const client = manifest.exports?.['./client']
    if (typeof client !== 'string' || !existsSync(join(target, client))) {
      throw new Error(`插件 ${manifest.name} 缺少浏览器产物：${String(client)}`)
    }
  }
  return manifest
}

/** 读取并验证插件分发清单。 */
export function readPluginCatalog(root = SCRIPT_ROOT) {
  const catalog = readJson(join(root, CATALOG_FILE))
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.distributions) || !Array.isArray(catalog.shell)) {
    throw new TypeError('plugin-catalog.json 格式无效')
  }
  return catalog
}

/**
 * 生成可由 dsh 原生管理器按绝对目录安装的插件介质。
 * 组合包把组件包复制到自己的 node_modules；运行时共享依赖继续由 dsh-station 安装提供。
 */
export function materializePluginDistributions(options = {}) {
  const root = resolve(options.root ?? SCRIPT_ROOT)
  const output = resolve(options.output ?? join(root, '.dev', 'plugins'))
  const catalog = readPluginCatalog(root)
  const temporary = join(dirname(output), `.${basename(output)}.${process.pid}.${randomUUID()}.tmp`)
  rmSync(temporary, { recursive: true, force: true })
  mkdirSync(temporary, { recursive: true })

  try {
    const generated = []
    for (const distribution of catalog.distributions) {
      const target = join(temporary, packageDirectoryName(distribution.name))
      const manifest = copyPackage(join(root, distribution.source), target)
      for (const component of distribution.components) {
        if (component.name === distribution.name) continue
        copyPackage(
          componentSource(root, component.name),
          join(target, 'node_modules', ...component.name.split('/')),
        )
      }
      generated.push({
        name: distribution.name,
        version: manifest.version,
        directory: packageDirectoryName(distribution.name),
        components: distribution.components,
      })
    }
    // 指纹清单随介质一并生成：launcher 启动时读取它即可完成一致性校验，
    // 不必每次启动逐字节哈希整棵介质树。算法与 launcher 的回退哈希共用同一实现。
    writeFileSync(join(temporary, 'stamp.json'), mediaStampFileContent(Object.fromEntries(
      generated.map(entry => [entry.name, mediaDirectoryStamp(join(temporary, entry.directory))]),
    )))
    writeFileSync(join(temporary, 'catalog.json'), `${JSON.stringify({ schemaVersion: 1, plugins: generated }, undefined, 2)}\n`)
    writeFileSync(join(temporary, 'README.txt'), [
      'dsh-station 随附插件',
      '',
      '在 dsh 的“添加插件”中输入目标插件目录的绝对路径即可重新安装。',
      '每个目录都是安装介质；删除 profile 中的插件不会删除这里的文件。',
      '',
    ].join('\n'))
    rmSync(output, { recursive: true, force: true })
    renameSync(temporary, output)
    return { output, plugins: generated }
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = materializePluginDistributions({ output: process.argv[2] })
  console.log(`[dsh-station] 已生成 ${String(result.plugins.length)} 个插件安装目录：${result.output}`)
}
