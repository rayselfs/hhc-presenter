import { ConverterFactory } from 'opencc-js/core'
import { from } from 'opencc-js/preset/cn2t'

const traditional = ConverterFactory(...from.cn)
function normalizeLyrics(text: string): string {
  // Preserve the worship pronoun and source punctuation while converting simplified characters.
  return text.split('祢').map(traditional).join('祢').replace(/\s+/gu, ' ').trim()
}
export type LyricsBlock = { text: string; score: number; poly: number[][] }
export function readLyricsLines(blocks: LyricsBlock[]): string[] {
  const boxes = blocks
    .map((block) => {
      if (
        typeof block.text !== 'string' ||
        !block.text ||
        !Number.isFinite(block.score) ||
        block.score < 0.85 ||
        block.poly.length !== 4 ||
        block.poly.some((p) => p.length !== 2 || !p.every(Number.isFinite))
      ) {
        throw new Error('Uncertain text block')
      }
      const xs = block.poly.map((p) => p[0]),
        ys = block.poly.map((p) => p[1])
      return {
        ...block,
        text: normalizeLyrics(block.text),
        leadingSpace: /^\s/u.test(block.text),
        trailingSpace: /\s$/u.test(block.text),
        left: Math.min(...xs),
        right: Math.max(...xs),
        top: Math.min(...ys),
        bottom: Math.max(...ys)
      }
    })
    .sort((a, b) => a.top - b.top)
  const rows: Array<typeof boxes> = []
  for (const box of boxes) {
    const row = rows.find((items) => {
      const first = items[0]
      const overlap = Math.min(first.bottom, box.bottom) - Math.max(first.top, box.top)
      return overlap > Math.min(first.bottom - first.top, box.bottom - box.top) * 0.5
    })
    if (row) row.push(box)
    else rows.push([box])
  }
  return rows.map((row) =>
    row
      .sort((a, b) => a.left - b.left)
      .map((box, index, boxes) => {
        const previous = boxes[index - 1]
        // Preserve phrase gaps, not ordinary spacing between adjacent glyph boxes.
        const gap =
          previous &&
          box.left - previous.right >
            Math.min(box.bottom - box.top, previous.bottom - previous.top) * 0.5
        return (
          (previous && (gap || previous.trailingSpace || box.leadingSpace) ? ' ' : '') + box.text
        )
      })
      .join('')
  )
}
export function createLyricsGate(): { observe(lines: string[]): string[] | null; reset(): void } {
  let previous = '',
    count = 0,
    emptySince = 0
  let candidate: string[] = []
  return {
    observe(lines) {
      const normalized = lines.map((line) => normalizeLyrics(line)).filter(Boolean)
      // Chinese phrase spacing may vary between OCR passes; Latin word boundaries remain meaningful.
      const next = JSON.stringify(
        normalized.map((line) => line.replace(/(?<=\p{Script=Han}) +(?=\p{Script=Han})/gu, ''))
      )
      if (next !== previous) {
        count = 0
        emptySince = Date.now()
        candidate = normalized
      } else if (normalized.join('').length > candidate.join('').length) {
        candidate = normalized
      }
      previous = next
      count++
      if (!normalized.length && Date.now() - emptySince < 5000) return null
      return count >= 2 ? candidate : null
    },
    reset() {
      previous = ''
      count = 0
      candidate = []
    }
  }
}

export function samePixels(
  current: Uint8ClampedArray,
  previous: Uint8ClampedArray | null
): boolean {
  if (!previous || previous.length !== current.length) return false
  for (let index = 0; index < current.length; index++)
    if (current[index] !== previous[index]) return false
  return true
}
