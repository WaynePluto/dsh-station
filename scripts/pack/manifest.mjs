import { join } from 'node:path'

/** 打包脚本的清单、路径和平台常量；仓库根目录由入口显式传入。 */
export const STAGING_RELATIVE = 'release/.staging'
export const PREBUILD_DIRECTORIES = ['node_modules/node-pty/prebuilds']

export const COMMON_PACKAGING_FILES = [
  { name: 'README.txt', mode: 0o644 },
  { name: 'dsh-station.config.example.json', mode: 0o644 },
]

export const WINDOWS_PACKAGING_FILES = [
  { name: 'start.ps1', mode: 0o644 },
]

export const POSIX_PACKAGING_FILES = [
  { name: 'start.sh', mode: 0o755 },
]

export const ALL_PACKAGING_FILES = [
  ...COMMON_PACKAGING_FILES,
  ...WINDOWS_PACKAGING_FILES,
  ...POSIX_PACKAGING_FILES,
]

/** sentinel 是按目标安装的 sharp 包，用于提前确认依赖树确实含有目标二进制。 */
/** zipTag 是产物文件名里的平台段；win32 对外叫 win，三元组 key 保持不变。 */
export const TARGETS = {
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    label: 'Windows x64',
    zipTag: 'win-x64',
    files: [...COMMON_PACKAGING_FILES, ...WINDOWS_PACKAGING_FILES],
    sentinel: '@img/sharp-win32-x64',
  },
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    label: 'Linux x64',
    zipTag: 'linux-x64',
    files: [...COMMON_PACKAGING_FILES, ...POSIX_PACKAGING_FILES],
    sentinel: '@img/sharp-linux-x64',
  },
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    label: 'macOS Apple Silicon',
    zipTag: 'darwin-arm64',
    files: [...COMMON_PACKAGING_FILES, ...POSIX_PACKAGING_FILES],
    sentinel: '@img/sharp-darwin-arm64',
  },
}

/** 服务版 zip（原绿色包）的发行目标：D22 收敛后只剩 Linux x64，
 *  win/mac 只发布桌面版介质（scripts/pack-desktop.mjs）。TARGETS 仍是全平台
 *  清单，桌面版打包复用它做平台裁剪与二进制预检。 */
export const SERVER_TARGETS = ['linux-x64']

/** 引擎类重组件：optionalDependencies 平台包、惰性加载、缺失时只在对应功能里报错，
 * 是 lite 变体唯一值得剔除的东西。只匹配引擎包本身，不带 `-` 后缀的 JS 壳
 * （@deepseek-ai/libreoffice-kit）必须保留——dsh-office-to-pdf 顶层 import 它。 */
export const HEAVY_ENGINE_PACKAGES = [/^@deepseek-ai\/libreoffice-kit-/]

/** 发行变体：同一平台打两次包，zip 名带变体后缀，没有无后缀的默认包。
 * 声明顺序即打包顺序：full 先打（树完整），lite 在其后裁剪再打。 */
export const VARIANTS = {
  full: {
    label: '完整版',
    zipTag: 'full',
    excludes: [],
  },
  lite: {
    label: '轻量版',
    zipTag: 'lite',
    excludes: HEAVY_ENGINE_PACKAGES,
  },
}

export const KEEP_AT_PACKAGE_ROOT = new Set(['dist', 'node_modules'])
export const PNPM_BOOKKEEPING = [/(^|\/)\.modules\.yaml$/, /(^|\/)\.pnpm\/lock\.yaml$/]
export const BIN_SCRIPT = /(^|\/)\.bin\//

export const BUILD_ARTIFACTS = [
  'packages/launcher/dist/index.js',
  'packages/relay/dist/cli.js',
  'packages/connector/dist/cli.js',
  'packages/plugins/remote-settings/dist/index.js',
  'packages/plugins/browser-compat/dist/index.js',
  'packages/plugins/directory-picker-browse/dist/index.js',
  'packages/plugins/copilot-auth/dist/index.js',
  'packages/plugins/models-catalog/dist/index.js',
  'packages/plugins/model-capabilities/dist/index.js',
  'packages/plugins/favorite-models/dist/index.js',
  'packages/plugins/proxy/dist/index.js',
  'packages/plugins/turn-retry/dist/index.js',
  'packages/plugins/chat-scroll/dist/index.js',
  'packages/plugins/user-message-fork/dist/index.js',
  'packages/plugins/files/dist/index.js',
  'packages/plugins/agents-md/dist/index.js',
  'packages/plugins/notify/dist/index.js',
  'packages/plugins/services/dist/index.js',
  'packages/plugins/terminal/dist/index.js',
  'packages/plugins/tools-inspector/dist/index.js',
  'packages/plugins/skills-inspector/dist/index.js',
  'packages/plugins/yolo-mode/dist/index.js',
  // 浏览器侧构建产物缺失会让 dsh 的网页模块扫描整体失败。
  'packages/plugins/browser-compat/dist/client.js',
  'packages/plugins/copilot-auth/dist/client.js',
  'packages/plugins/models-catalog/dist/client.js',
  'packages/plugins/model-capabilities/dist/client.js',
  'packages/plugins/favorite-models/dist/client.js',
  'packages/plugins/proxy/dist/client.js',
  'packages/plugins/turn-retry/dist/client.js',
  'packages/plugins/chat-scroll/dist/client.js',
  'packages/plugins/user-message-fork/dist/client.js',
  'packages/plugins/files/dist/client.js',
  'packages/plugins/agents-md/dist/client.js',
  'packages/plugins/notify/dist/client.js',
  'packages/plugins/services/dist/client.js',
  'packages/plugins/terminal/dist/client.js',
  'packages/plugins/tools-inspector/dist/client.js',
  'packages/plugins/skills-inspector/dist/client.js',
]

/** 壳级常驻 overlay 及其运行时代码，随 launcher 以 --patch 传入。 */
export const SHELL_OVERLAY_FILES = [
  'node_modules/@dsh-station/dsh-plugin-remote-privileged/dsh-overlay.yml',
  'node_modules/@dsh-station/dsh-plugin-remote-privileged/model-bootstrap.mjs',
  'node_modules/@dsh-station/dsh-plugin-remote-privileged/theme-projection.mjs',
]

/** 第三方插件发行介质由 plugin-catalog.json 唯一驱动。 */
export const PLUGIN_CATALOG_FILE = 'plugin-catalog.json'
export const PLUGIN_MEDIA_DIRECTORY = 'plugins'

export const STUB_ENTRIES = [
  { name: 'relay.js', target: '../node_modules/@dsh-station/relay/dist/cli.js' },
  { name: 'connector.js', target: '../node_modules/@dsh-station/connector/dist/cli.js' },
]

export const RUNTIME_ENTRIES = [
  { label: 'launcher', path: 'dist/index.js', check: ['--version'] },
  { label: 'relay', path: 'node_modules/@dsh-station/relay/dist/cli.js', check: ['--help'] },
  { label: 'connector', path: 'node_modules/@dsh-station/connector/dist/cli.js', check: ['--help'] },
  { label: 'relay 跳转入口', path: 'dist/relay.js', check: ['--help'] },
  { label: 'connector 跳转入口', path: 'dist/connector.js', check: ['--help'] },
]

export const UNLOCK_CROSS_BUILD_HINT =
  '这个目标的平台没有被根 package.json 的 pnpm 配置装进来（`supportedArchitectures` 现在声明的是\n' +
  '       os: win32/linux/darwin，cpu: x64/arm64，libc: glibc，再由 `ignoredOptionalDependencies`\n' +
  '       减掉 win32-arm64 / linux-arm64 / darwin-x64 / musl）。把它的 os/cpu 加进前者、\n' +
  '       并从后者的模式列表里去掉，再 pnpm install 把该平台的预编译二进制拉下来；\n' +
  '       代价是开发机 node_modules 变大。已经配过了还报这个错，先 pnpm install 一次。'

/** 根据显式仓库根目录生成所有运行时路径，避免子模块自行推导根目录。 */
export function createManifest(root, { platform = process.platform, arch = process.arch } = {}) {
  const packaging = join(root, 'packaging')
  const stagingRootSegment = STAGING_RELATIVE.split('/')[0]
  const staging = join(root, ...STAGING_RELATIVE.split('/'))
  return {
    root,
    packaging,
    release: join(root, 'release'),
    stagingRelative: STAGING_RELATIVE,
    stagingRootSegment,
    staging,
    packageDir: join(staging, 'package'),
    allPackagingFiles: ALL_PACKAGING_FILES,
    targets: TARGETS,
    serverTargets: SERVER_TARGETS,
    variants: VARIANTS,
    heavyEnginePackages: HEAVY_ENGINE_PACKAGES,
    hostTarget: `${platform}-${arch}`,
    platform,
    arch,
    prebuildDirectories: PREBUILD_DIRECTORIES,
    keepAtPackageRoot: KEEP_AT_PACKAGE_ROOT,
    pnpmBookkeeping: PNPM_BOOKKEEPING,
    binScript: BIN_SCRIPT,
    buildArtifacts: BUILD_ARTIFACTS,
    shellOverlayFiles: SHELL_OVERLAY_FILES,
    pluginCatalogFile: PLUGIN_CATALOG_FILE,
    pluginMediaDirectory: PLUGIN_MEDIA_DIRECTORY,
    stubEntries: STUB_ENTRIES,
    runtimeEntries: RUNTIME_ENTRIES,
  }
}

/** 将包根下的正斜杠路径转换为当前系统的路径。 */
export function inPackage(context, relative) {
  return join(context.packageDir, ...relative.split('/'))
}
