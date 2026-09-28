import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectorArguments, resolveConnectorEntry } from '../src/connector.js'
import { DEV_RUNTIME_ENV_NAME, dshArguments, dshTokenFromLine, preparePnpmShim, resolveDshBin, resolveDshInstallAnchor, resolvePnpmCli, skippedBundleFromLine, withBundledPnpmPath } from '../src/dsh.js'
import {
  PLUGIN_OVERLAY_FILE,
  SHELL_PLUGIN_PACKAGES,
  SHELL_PLUGIN_RUNTIME_FILES,
  resolveDshPluginOverlays,
} from '../src/dsh-plugins.js'
import { LauncherError } from '../src/errors.js'

const DSH_BIN = join('C:', 'green', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** 接受壳级 overlay 的 `exists` 谓词。 */
const installedAt = (roots: Readonly<Record<string, string>>) => (path: string): boolean =>
  SHELL_PLUGIN_PACKAGES.some(name => [PLUGIN_OVERLAY_FILE, ...SHELL_PLUGIN_RUNTIME_FILES].some(file => path === join(roots[name] as string, file)))

describe('dsh arguments', () => {
  it('runs mode A: loopback bind plus every authority a browser may send', () => {
    expect(dshArguments({
      dshBin: DSH_BIN,
      profile: 'dsh-station-web',
      port: 3080,
      trustedHosts: ['127.0.0.1', 'localhost', '10.1.2.87:30810'],
    })).toEqual([
      DSH_BIN,
      '--profile', 'dsh-station-web',
      '--no-open',
      '--host', '127.0.0.1',
      '--port', '3080',
      '--trusted-host', '127.0.0.1', 'localhost', '10.1.2.87:30810',
    ])
  })

  it('appends extraArgs after the launcher own flags', () => {
    const args = dshArguments({
      dshBin: DSH_BIN,
      profile: 'dsh-station-web',
      port: 3080,
      trustedHosts: ['127.0.0.1'],
      extraArgs: ['--log-level', 'debug'],
    })
    expect(args.slice(-2)).toEqual(['--log-level', 'debug'])
  })

  it('passes every plugin overlay as a launcher --patch, before the web app flags', () => {
    const overlay = join('C:', 'green', 'node_modules', '@dsh-station', 'p', PLUGIN_OVERLAY_FILE)
    const args = dshArguments({
      dshBin: DSH_BIN,
      profile: 'dsh-station-web',
      port: 3080,
      trustedHosts: ['127.0.0.1'],
      patchFiles: [overlay],
    })
    // --patch 是 dsh launcher flag：位于 --profile 之后、--no-open 之前，
    // 其余内容由 web app 自己解析。
    expect(args.slice(0, 6)).toEqual([
      DSH_BIN, '--profile', 'dsh-station-web', '--patch', overlay, '--no-open',
    ])
  })

  it('never preloads anything: the proxy is the plugin\'s business, not the launcher\'s', () => {
    // launcher 安装的环境 proxy 是该事实的第二个来源，
    // 在 UI 中不可见，并导致真实失败：在 Settings 中关闭 proxy
    // 后仍然通过环境 proxy，而
    // 页面却报告直连（docs/dsh/models.md）。
    const args = dshArguments({
      dshBin: DSH_BIN,
      profile: 'dsh-station-web',
      port: 3080,
      trustedHosts: ['127.0.0.1'],
    })
    expect(args[0]).toBe(DSH_BIN)
    expect(args).not.toContain('--import')
  })
})

describe('dsh plugin package manager environment', () => {
  it('keeps the bundled pnpm binary ahead of the inherited PATH', () => {
    const pnpmCli = join('D:', 'runtime', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    const environment = withBundledPnpmPath({ PATH: 'C:\\Windows\\System32' }, pnpmCli)
    expect(environment.PATH).toBe(`${join('D:', 'runtime', 'node_modules', '.bin')}${delimiter}C:\\Windows\\System32`)
  })

  it('puts the local-directory pnpm shim before the bundled pnpm binary', () => {
    const pnpmCli = join('D:', 'runtime', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    const directory = mkdtempSync(join(tmpdir(), 'dsh-station-pnpm-shim-'))
    try {
      const shim = preparePnpmShim(directory, pnpmCli)
      const environment = withBundledPnpmPath({ Path: 'C:\\Windows' }, pnpmCli, shim)
      expect(environment.Path).toBe(`${shim}${delimiter}${join('D:', 'runtime', 'node_modules', '.bin')}${delimiter}C:\\Windows`)
      expect(existsSync(join(shim, 'pnpm-wrapper.mjs'))).toBe(true)
      expect(existsSync(join(shim, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'))).toBe(true)
      expect(readFileSync(join(shim, 'pnpm-wrapper.mjs'), 'utf8')).toContain("join(process.cwd(), '.dsh-station-plugin-media')")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('dsh browser login token', () => {
  it('reads the token out of the URL line dsh prints on start-up', () => {
    expect(dshTokenFromLine('dsh web: http://127.0.0.1:3080/?token=abc123_-token'))
      .toBe('abc123_-token')
  })

  it('ignores the LAN URL that may follow on the same line', () => {
    expect(dshTokenFromLine('dsh web: http://127.0.0.1:3080/?token=first (LAN: http://10.0.0.9:3080/?token=second)'))
      .toBe('first')
  })

  it('returns undefined for every line that carries no token', () => {
    for (const line of [
      'dsh web: opening the default browser; pass --no-open to disable',
      'dsh web: http://127.0.0.1:3080/',
      'some other log line with ?token=nope in it',
      '',
    ]) {
      expect(dshTokenFromLine(line)).toBeUndefined()
    }
  })
})

describe('dsh skipped bundle diagnostics', () => {
  it('reads the bundle name and reason out of a skip line', () => {
    expect(skippedBundleFromLine('dsh: skipping profile bundle "@dsh-station/dsh-plugin-proxy": cannot read manifest'))
      .toBe('"@dsh-station/dsh-plugin-proxy" cannot read manifest')
  })

  it('returns undefined for unrelated lines', () => {
    for (const line of [
      'dsh web: http://127.0.0.1:3080/?token=abc',
      'some plugin emitted: skipping profile bundle lookalike without the prefix',
      '',
    ]) {
      expect(skippedBundleFromLine(line)).toBeUndefined()
    }
  })
})

describe('connector entry', () => {
  const packed = join('C:', 'green', 'dist')
  const source = join(repositoryRoot, 'packages', 'launcher', 'src')

  it('prefers the connector deployed into the package own node_modules', () => {
    const deployed = join(packed, '..', 'node_modules', '@dsh-station', 'connector', 'dist', 'cli.js')
    expect(resolveConnectorEntry(packed, path => path === deployed))
      .toEqual({ path: deployed, needsTsx: false })
  })

  it('never runs the connector from a flat dist/, where nested dependencies are invisible', () => {
    expect(() => resolveConnectorEntry(packed, path => path === join(packed, 'connector.js')))
      .toThrow(LauncherError)
  })

  it('finds the workspace connector from the launcher own location', () => {
    const built = join(source, '..', '..', 'connector', 'dist', 'cli.js')
    expect(resolveConnectorEntry(source, path => path === built)).toEqual({ path: built, needsTsx: false })

    const sources = join(source, '..', '..', 'connector', 'src', 'cli.ts')
    expect(resolveConnectorEntry(source, path => path === sources)).toEqual({ path: sources, needsTsx: true })
  })

  it('says the package is incomplete instead of failing inside spawn', () => {
    expect(() => resolveConnectorEntry(packed, () => false)).toThrow(LauncherError)
  })
})

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function barePluginName(name: string): string {
  return (name.split('/')[1] ?? name).replace(/^dsh-plugin-/u, '')
}

describe('dsh shell plugin overlay', () => {
  const packed = join('C:', 'green', 'dist')
  const source = join(repositoryRoot, 'packages', 'launcher', 'src')
  const deployedRoots = Object.fromEntries(SHELL_PLUGIN_PACKAGES.map(name =>
    [name, join(packed, '..', 'node_modules', ...name.split('/'))]))
  const workspaceRoots = Object.fromEntries(SHELL_PLUGIN_PACKAGES.map(name =>
    [name, join(repositoryRoot, 'packages', 'plugins', barePluginName(name))]))

  it('keeps exactly one non-removable shell overlay', () => {
    expect([...SHELL_PLUGIN_PACKAGES]).toEqual(['@dsh-station/dsh-plugin-remote-privileged'])
  })

  it('keeps connection and model HMR prerequisites in the shell overlay', () => {
    const root = workspaceRoots['@dsh-station/dsh-plugin-remote-privileged'] as string
    const overlay = readFileSync(join(root, PLUGIN_OVERLAY_FILE), 'utf8')
    expect(overlay).toContain('id: connection')
    expect(overlay).toContain('id: llm-pi-ai')
    expect(overlay).toContain('modelsCatalogBootstrap')
    expect(overlay).toContain('modelCapabilitiesBootstrap')
    expect(overlay).toContain("name: './model-bootstrap.mjs'")
    expect(existsSync(join(root, 'model-bootstrap.mjs'))).toBe(true)
    expect(overlay).toContain("name: './theme-projection.mjs'")
    expect(existsSync(join(root, 'theme-projection.mjs'))).toBe(true)
  })

  it('finds the overlay in packaged and workspace layouts', () => {
    expect(resolveDshPluginOverlays(packed, installedAt(deployedRoots)))
      .toEqual(SHELL_PLUGIN_PACKAGES.map(name => join(deployedRoots[name] as string, PLUGIN_OVERLAY_FILE)))
    expect(resolveDshPluginOverlays(source, installedAt(workspaceRoots)))
      .toEqual(SHELL_PLUGIN_PACKAGES.map(name => join(workspaceRoots[name] as string, PLUGIN_OVERLAY_FILE)))
  })

  it.each(SHELL_PLUGIN_RUNTIME_FILES)('refuses incomplete shell runtime: %s', (missing) => {
    expect(() => resolveDshPluginOverlays(packed, path => installedAt(deployedRoots)(path) && !path.endsWith(missing)))
      .toThrow(missing)
  })

  it('refuses to start without the shell overlay', () => {
    expect(() => resolveDshPluginOverlays(packed, () => false)).toThrow(LauncherError)
  })
})

describe('connector arguments', () => {
  it('leaves the hub to membership.json, so joining needs no restart of the connector', () => {
    const args = connectorArguments({ path: 'C:/green/dist/connector.js', needsTsx: false }, {
      home: 'C:/Users/me/.dsh-station',
      dshPort: 3080,
    })
    expect(args).toEqual(['C:/green/dist/connector.js', '--home', 'C:/Users/me/.dsh-station', '--dsh-port', '3080'])
    expect(args).not.toContain('--relay')
    expect(args).not.toContain('--slug')
  })

  it('preloads tsx only for a TypeScript entry point', () => {
    expect(connectorArguments({ path: 'src/cli.ts', needsTsx: true }, { home: '/home', dshPort: 3080 }).slice(0, 2))
      .toEqual(['--import', 'tsx'])
  })
})

function writeRuntimeFile(root: string, path: string, content: string): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

describe('controlled development runtime resolution', () => {
  const temporary: string[] = []
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
  })
  function runtime(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'station-resolver-')))
    temporary.push(root)
    writeRuntimeFile(root, 'package.json', JSON.stringify({ name: 'dsh-station-development-runtime' }))
    writeRuntimeFile(root, 'node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh' }))
    writeRuntimeFile(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js', '')
    writeRuntimeFile(root, 'node_modules/pnpm/package.json', JSON.stringify({ name: 'pnpm', exports: { '.': './package.json' } }))
    writeRuntimeFile(root, 'node_modules/pnpm/bin/pnpm.cjs', '')
    return root
  }

  it('leaves release/CLI resolution unchanged without the explicit environment variable', () => {
    vi.stubEnv(DEV_RUNTIME_ENV_NAME, undefined)
    const require = createRequire(import.meta.url)
    expect(resolveDshBin()).toBe(require.resolve('@deepseek-ai/dsh/lib/bin.js'))
    expect(resolveDshInstallAnchor()).toBe(require.resolve('@deepseek-ai/dsh/package.json'))
    expect(resolvePnpmCli()).toBe(join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.cjs'))
  })

  it('uses the same isolated anchor for all three paths', () => {
    const root = runtime()
    vi.stubEnv(DEV_RUNTIME_ENV_NAME, root)
    expect(resolveDshBin()).toBe(join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
    expect(resolveDshInstallAnchor()).toBe(join(root, 'node_modules/@deepseek-ai/dsh/package.json'))
    expect(resolvePnpmCli()).toBe(join(root, 'node_modules/pnpm/bin/pnpm.cjs'))
  })

  it.each(['', './relative', repositoryRoot])('rejects an invalid or workspace anchor: %s', (root) => {
    vi.stubEnv(DEV_RUNTIME_ENV_NAME, root)
    for (const resolver of [resolveDshBin, resolveDshInstallAnchor, resolvePnpmCli]) {
      expect(resolver).toThrow(DEV_RUNTIME_ENV_NAME)
    }
  })

  it('rejects an unmarked directory', () => {
    const root = runtime()
    writeRuntimeFile(root, 'package.json', JSON.stringify({ name: 'unrelated' }))
    vi.stubEnv(DEV_RUNTIME_ENV_NAME, root)
    expect(resolveDshBin).toThrow(LauncherError)
  })

  it('refuses a runtime with a missing pnpm executable', () => {
    const root = runtime()
    rmSync(join(root, 'node_modules/pnpm/bin/pnpm.cjs'))
    vi.stubEnv(DEV_RUNTIME_ENV_NAME, root)
    expect(resolvePnpmCli).toThrow(DEV_RUNTIME_ENV_NAME)
  })
  it('does not fall back to a package reachable in an ancestor node_modules', () => {
    const root = runtime()
    const nested = join(root, 'nested')
    writeRuntimeFile(nested, 'package.json', JSON.stringify({ name: 'dsh-station-development-runtime' }))
    vi.stubEnv(DEV_RUNTIME_ENV_NAME, nested)
    for (const resolver of [resolveDshBin, resolveDshInstallAnchor, resolvePnpmCli]) {
      expect(resolver).toThrow(DEV_RUNTIME_ENV_NAME)
    }
  })
})