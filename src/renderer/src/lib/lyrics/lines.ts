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
      return { ...block, left: Math.min(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
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
      .map((box) => box.text)
      .join('')
  )
}
export function createLyricsGate(): { observe(lines: string[]): string[] | null; reset(): void } {
  let previous = '',
    count = 0
  return {
    observe(lines) {
      const next = JSON.stringify(lines)
      count = next === previous ? count + 1 : 1
      previous = next
      return count >= 2 ? lines : null
    },
    reset() {
      previous = ''
      count = 0
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
