import { z } from 'zod'

/** 工作站自有的只读主题交接文件，不是原生 profile 配置。 */
export const THEME_FILE_NAME = 'dsh-theme.json'
export const THEME_FILE_ENV_NAME = 'DSH_STATION_THEME_FILE'
export const MAX_THEME_PROJECTION_BYTES = 1024

export const themeProjectionSchema = z.strictObject({
  version: z.literal(1),
  preference: z.enum(['light', 'dark', 'system']),
})

export type ThemeProjection = z.infer<typeof themeProjectionSchema>

/** 解析有界 UTF-8 文件文本；缺失时返回 undefined，损坏内容必须由读取方保留旧值。 */
export function parseThemeProjection(raw: string | undefined): ThemeProjection | undefined {
  if (raw === undefined) return undefined
  if (new TextEncoder().encode(raw).byteLength > MAX_THEME_PROJECTION_BYTES) {
    throw new Error('Theme projection exceeds byte limit')
  }
  return themeProjectionSchema.parse(JSON.parse(raw))
}
