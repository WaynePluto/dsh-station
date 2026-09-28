import { closeSync, fstatSync, mkdirSync, openSync, readSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { MAX_THEME_PROJECTION_BYTES, parseThemeProjection, THEME_FILE_NAME } from '@dsh-station/protocol'
import type { Logger } from 'pino'
import type { ThemePreference } from './theme.js'

/** 只读取工作站自己的安全投影；绝不读取或解释 dsh 的 profile。 */
export class NativeTheme {
  readonly #path: string
  readonly #home: string
  readonly #logger: Logger
  readonly #listeners = new Set<() => void>()
  #preference: ThemePreference = 'system'
  #watcher: FSWatcher | undefined
  #pending: ReturnType<typeof setTimeout> | undefined
  #closed = false
  #started = false
  #failed = false

  constructor(home: string, logger: Logger) {
    this.#home = home
    this.#path = join(home, THEME_FILE_NAME)
    this.#logger = logger
  }

  get preference(): ThemePreference { return this.#preference }

  start(): void {
    if (this.#started || this.#closed) return
    this.#started = true
    try {
      mkdirSync(this.#home, { recursive: true })
      // 先订阅再读初值，避免读取与订阅之间错过原子替换。
      this.#watcher = watch(this.#home, { persistent: false }, (_event, filename) => {
        if (filename !== null && filename !== THEME_FILE_NAME) return
        if (this.#pending !== undefined) return
        this.#pending = setTimeout(() => {
          this.#pending = undefined
          this.#read()
        }, 20)
        this.#pending.unref()
      })
      this.#watcher.on('error', () => {
        this.#watcher?.close()
        this.#watcher = undefined
        this.#warn()
      })
    } catch { this.#warn() }
    this.#read()
  }

  subscribe(listener: () => void): () => void {
    if (this.#closed) return () => undefined
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #warn(): void {
    if (!this.#failed) this.#logger.warn('native theme projection unavailable; retaining last preference')
    this.#failed = true
  }

  #read(): void {
    if (this.#closed) return
    let descriptor: number | undefined
    try {
      descriptor = openSync(this.#path, 'r')
      const info = fstatSync(descriptor)
      if (!info.isFile() || info.size > MAX_THEME_PROJECTION_BYTES) throw new Error('Invalid projection')
      const bytes = Buffer.alloc(MAX_THEME_PROJECTION_BYTES + 1)
      const length = readSync(descriptor, bytes, 0, bytes.length, 0)
      if (length > MAX_THEME_PROJECTION_BYTES) throw new Error('Invalid projection')
      const projection = parseThemeProjection(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
      if (projection === undefined) return
      this.#failed = false
      if (projection.preference === this.#preference) return
      this.#preference = projection.preference
      for (const listener of this.#listeners) listener()
    } catch (error) {
      // 缺失、重启间隙或坏文件不覆盖最后有效值，也不向页面输出错误正文。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#warn()
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }

  close(): void {
    this.#closed = true
    this.#watcher?.close()
    clearTimeout(this.#pending)
    this.#listeners.clear()
  }
}
