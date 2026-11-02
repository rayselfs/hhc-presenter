export interface ChineseSpeechResult {
  text: string
  reference: [number, number, number] | null
  asrMs: number
  locateMs: number
}

export function isChineseSpeechResult(value: unknown): value is ChineseSpeechResult {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.text === 'string' &&
    row.text.length <= 16000 &&
    [row.asrMs, row.locateMs].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) &&
    (row.reference === null ||
      (Array.isArray(row.reference) &&
        row.reference.length === 3 &&
        row.reference.every((n) => Number.isInteger(n) && n > 0 && n <= 1000) &&
        row.reference[0] <= 66))
  )
}

export function isChineseSpeechPcm(value: unknown): value is Float32Array {
  return (
    value instanceof Float32Array &&
    value.length > 0 &&
    value.length <= 480000 &&
    value.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1)
  )
}
