export const LYRICS_FONTS = ['Noto Sans TC Variable', 'sans-serif'] as const
export type LyricsStyle = {
  font: (typeof LYRICS_FONTS)[number]
  fontSize: number
  lineHeight: number
  bottom: number
}
export type LyricsOutput = {
  lines: string[]
  style: LyricsStyle
  visible: boolean
  expiresAt: number
}
export type LyricsCrop = { x: number; y: number; width: number; height: number }
export const DEFAULT_LYRICS_STYLE: LyricsStyle = {
  font: 'Noto Sans TC Variable',
  fontSize: 64,
  lineHeight: 1.25,
  bottom: 5
}
export function isLyricsStyle(value: unknown): value is LyricsStyle {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    LYRICS_FONTS.some((font) => font === v.font) &&
    typeof v.fontSize === 'number' &&
    Number.isFinite(v.fontSize) &&
    v.fontSize >= 24 &&
    v.fontSize <= 160 &&
    typeof v.lineHeight === 'number' &&
    Number.isFinite(v.lineHeight) &&
    v.lineHeight >= 1 &&
    v.lineHeight <= 2 &&
    typeof v.bottom === 'number' &&
    Number.isFinite(v.bottom) &&
    v.bottom >= 5 &&
    v.bottom <= 50
  )
}
export function isLyricsLines(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 12 &&
    value.every(
      (line) =>
        typeof line === 'string' &&
        line.length <= 256 &&
        !/[\r\n]/.test(line) &&
        !line.includes('\0')
    )
  )
}
export function isLyricsOutput(value: unknown): value is LyricsOutput {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    isLyricsLines(v.lines) &&
    isLyricsStyle(v.style) &&
    typeof v.visible === 'boolean' &&
    typeof v.expiresAt === 'number' &&
    Number.isFinite(v.expiresAt) &&
    v.expiresAt >= 0
  )
}
export function isLyricsCrop(value: unknown): value is LyricsCrop {
  if (!value || typeof value !== 'object') return false
  const v = value as LyricsCrop
  return (
    [v.x, v.y, v.width, v.height].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    v.x >= 0 &&
    v.y >= 0 &&
    v.width >= 0.05 &&
    v.height >= 0.05 &&
    v.x + v.width <= 1.000001 &&
    v.y + v.height <= 1.000001
  )
}
