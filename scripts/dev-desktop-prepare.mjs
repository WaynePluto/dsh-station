/** 一次性开发准备：不启动 dsh/relay/connector，不创建或改写用户 profile。 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensurePluginBuild, fileStamp, packageBuildStamp, readBuildStamp, writeBuildStamp,
} from './dev-plugin-build.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BACKEND_PACKAGES = ['launcher', 'relay', 'connector', 'protocol', 'plugin-ui']
const BACKEND_ARTIFACTS = ['launcher/dist/index.js', 'relay/dist/cli.js', 'relay/dist/index.js',
  'connector/dist/cli.js', 'connector/dist/index.js']

function runNode(args, root) {
  const child = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  if (child.error !== undefined) throw child.error
  if (child.status !== 0) throw new Error(`开发准备命令失败（退出码 ${String(child.status)}）：${args[0]}`)
}

/** relay/connector 必须使用新 dist；launcher 自身仍是发行版同一构建入口。 */
export async function ensureBackendBuild({ root, pnpmCli, run = runNode, log = console.log }) {
  const stamp = {
    schemaVersion: 1,
    node: process.versions.node,
    packages: Object.fromEntries(BACKEND_PACKAGES.map(name => [name, packageBuildStamp(join(root, 'packages', name))])),
    inputs: Object.fromEntries(['package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'plugin-catalog.json',
      'scripts/dev-desktop-prepare.mjs', 'scripts/dev-plugin-build.mjs',
    ].map(path => [path, fileStamp(join(root, path))])),
  }
  const path = join(root, 'node_modules', '.cache', 'dsh-station', 'dev-desktop-build.json')
  const intact = () => BACKEND_ARTIFACTS.every(artifact => existsSync(join(root, 'packages', artifact)))
  if (JSON.stringify(readBuildStamp(path)) === JSON.stringify(stamp) && intact()) {
    log('[dsh-station] launcher/relay/connector 源码未变化，沿用构建产物。')
    return false
  }
  await run([pnpmCli, '--filter', '@dsh-station/launcher', '--filter', '@dsh-station/relay',
    '--filter', '@dsh-station/connector', 'build'], root)
  if (!intact()) throw new Error('开发后端缺少 launcher/relay/connector 构建产物。')
  writeBuildStamp(path, stamp)
  return true
}

export function developmentLauncherConfig(local) {
  return {
    home: local.DSH_STATION_HOME,
    dsh: { profile: local.DSH_PROFILE, port: local.DSH_PORT },
    relay: { host: '0.0.0.0', port: local.RELAY_PORT, data: local.RELAY_DATABASE },
  }
}

export async function prepareDesktopBackend({
  root = ROOT,
  run = runNode,
  loadLocalConfig = () => import('./local-config.mjs'),
  buildPlugins = ensurePluginBuild,
  buildBackend = ensureBackendBuild,
} = {}) {
  // 不静态导入 local-config：它在求值时读取 runtime.json，必须晚于本次准备。
  await run([join(root, 'scripts', 'dev-runtime.mjs')], root)
  const local = await loadLocalConfig()
  const descriptor = JSON.parse(readFileSync(join(root, '.dev', 'runtime.json'), 'utf8'))
  if (descriptor.dshBin !== local.DSH_BIN || descriptor.installAnchor !== local.DSH_INSTALL_ANCHOR
    || descriptor.pnpmCli !== local.PNPM_CLI || !existsSync(local.DSH_BIN) || !existsSync(local.PNPM_CLI)
    || resolve(descriptor.runtime) !== dirname(dirname(dirname(dirname(local.PNPM_CLI))))) {
    throw new Error('开发运行时描述与 local-config 不一致，拒绝回退到源码工作区。')
  }
  if (local.DSH_PORT !== 3180 || local.RELAY_PORT !== 31809 || local.DSH_PROFILE !== 'dsh-station-web') {
    throw new Error('开发配置与桌面引导握手不一致；请同步开发端口/profile 契约。')
  }
  await buildPlugins({ root, runRootScript: name => run([local.PNPM_CLI, 'run', name], root) })
  await buildBackend({ root, pnpmCli: local.PNPM_CLI, run })
  // 与 dev-profile.ts 一样仅选择 dsh-station-web；最小 Bundle 与第三方状态全交给 launcher。
  const configPath = join(root, 'node_modules', '.cache', 'dsh-station', 'dev-desktop.config.json')
  writeBuildStamp(configPath, developmentLauncherConfig(local))
  return { configPath, runtime: descriptor.runtime, dshHome: local.DSH_HOME_DEV }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const prepared = await prepareDesktopBackend()
    // 只向托管 wrapper 传递路径，不通过 stdout 混入状态或凭据。
    if (process.send !== undefined) process.send(prepared, () => process.disconnect())
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    if (process.connected) process.disconnect()
  }
}
