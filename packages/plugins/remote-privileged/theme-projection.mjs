import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'

// 纯 mjs 不引入工作区依赖；测试与 protocol 的公开契约交叉核对。
export const THEME_FILE_NAME = 'dsh-theme.json'
export const THEME_FILE_ENV_NAME = 'DSH_STATION_THEME_FILE'
export const MAX_THEME_PROJECTION_BYTES = 1024
export const name = 'dsh-station-theme-projection'
export const inject = ['loader']

/** 仅取原生顶层 ui-theme 行的活跃配置，不读写任何原生文件。 */
function nativePreference(loader) {
  const entries = [...loader.entries()].filter(entry =>
    entry.options.id === 'ui-theme'
    && entry.parent.tree.ctx.fiber.entry?.id === 'include')
  if (entries.length !== 1) throw new Error('Theme entry unavailable')
  const fiber = entries[0].fiber
  if (fiber?.state !== 2 || fiber.runtime == null) throw new Error('Theme entry inactive')
  const preference = fiber.config.preference.get()
  if (!['light', 'dark', 'system'].includes(preference)) throw new Error('Invalid theme preference')
  return preference
}

/** 小文件同步原子替换，使 fiber 释放后不存在仍会提交的异步写任务。 */
function writeProjection(path, preference) {
  const content = `${JSON.stringify({ version: 1, preference })}\n`
  if (Buffer.byteLength(content, 'utf8') > MAX_THEME_PROJECTION_BYTES) throw new Error('Theme projection too large')
  const directory = dirname(path)
  const temporary = join(directory, `.${THEME_FILE_NAME}.${randomBytes(8).toString('hex')}.tmp`)
  let created = false
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const descriptor = openSync(temporary, 'wx', 0o600)
    created = true
    try {
      writeFileSync(descriptor, content, { encoding: 'utf8' })
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, path)
  } finally {
    if (created) {
      try { unlinkSync(temporary) } catch { /* 原子替换成功后临时路径已不存在。 */ }
    }
  }
}

/** 只订阅重载提交点；不订阅浏览器事件，也不向原生设置发送写操作。 */
export function apply(ctx) {
  const path = process.env[THEME_FILE_ENV_NAME]
  if (path === undefined) return
  const diagnose = (reason) => {
    // 不输出原生错误、配置、路径或 URL，防止日志泄露宿主数据。
    try { ctx.logger.warn(`[dsh-station] theme projection: ${reason}`) } catch { /* 诊断不能阻止 dsh。 */ }
  }
  if (!isAbsolute(path) || basename(path) !== THEME_FILE_NAME) {
    diagnose('invalid destination')
    return
  }
  let closed = false
  let ready = false
  let scheduled = false
  let previous
  let lastFailure
  let unsubscribe
  const reportFailure = (reason) => {
    if (lastFailure !== reason) diagnose(reason)
    lastFailure = reason
  }
  const refresh = () => {
    if (closed || !ready || scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (closed) return
      let preference
      try {
        preference = nativePreference(ctx.loader)
      } catch {
        reportFailure('native theme unavailable')
        return
      }
      if (preference === previous) return
      try {
        writeProjection(path, preference)
        previous = preference
        lastFailure = undefined
      } catch {
        reportFailure('write failed')
      }
    })
  }
  try {
    ctx.effect(() => () => {
      closed = true
      unsubscribe?.()
    })
    // ConfigEditor 先持久化，reconcileProfilePatches 校验成功后才广播此事件。
    unsubscribe = ctx.on('app-boot/config-reload', refresh)
    // 不返回此 Promise：等待 loader 的插件自身必须先结束 apply，避免启动死锁。
    Promise.resolve(ctx.loader.await()).then(() => {
      if (!closed) {
        ready = true
        refresh()
      }
      return undefined
    }).catch(() => {
      if (!closed) reportFailure('loader unavailable')
    })
  } catch {
    closed = true
    unsubscribe?.()
    reportFailure('subscription unavailable')
  }
}
