import {
  distance,
  GlyphFont,
  slideRows,
  hasUnexplainedStroke,
  type GlyphShape
} from './glyph-shapes'

type Font = Pick<GlyphFont, 'anchor' | 'nearest' | 'detail'>
type Match = { index: number; error: number; font: Font }
function applyGlyph(line: string, index: number, ch: string, missing: boolean): string {
  const original = [...line]
  const positions = original.flatMap((c, i) => (c === ' ' ? [] : [i]))
  const position = positions[index] ?? original.length
  // Keep original typography. A missing glyph on a whitespace boundary is ambiguous.
  if (missing && (original[position - 1] === ' ' || original[position] === ' ')) return line
  original.splice(position, missing ? 0 : 1, ch)
  return original.join('')
}

// At least three agreeing optical anchors and exactly one differing position.
// When OCR skipped a glyph, test every possible insertion and require a unique alignment.
export function correctGlyphRow(line: string, shapes: GlyphShape[], fonts: Font[]): string {
  if (!/^[\p{Script=Han} ]+$/u.test(line)) return line
  const chars = [...line.replaceAll(' ', '')]
  const missing = shapes.length - chars.length
  if ((missing !== 0 && missing !== 1) || shapes.length < 4) return line
  const candidates: Match[] = []
  for (const font of fonts) {
    const direct = chars.map((c, i) => distance(shapes[i].coarse, font.anchor(c)))
    // A thin horizontal or vertical stroke carries little identifying detail.
    const strong = direct.filter((_, i) => shapes[i].aspect >= 0.25 && shapes[i].aspect <= 4)
    if (!missing && strong.length >= 3 && strong.every((n) => n < 0.045)) {
      if (strong.reduce((a, b) => a + b, 0) / strong.length < 0.028) {
        const changes: { i: number; ch: string }[] = []
        for (let i = 0; i < chars.length; i++) {
          if (shapes[i].aspect < 0.25 || shapes[i].aspect > 4) continue
          if (!hasUnexplainedStroke(shapes[i].fine, font.detail(chars[i]))) continue
          const ch = font.nearest(shapes[i].coarse, shapes[i].fine, chars[i])
          if (ch && ch !== chars[i]) changes.push({ i, ch })
        }
        if (changes.length === 1) {
          return applyGlyph(line, changes[0].i, changes[0].ch, false)
        }
      }
      return line
    }
    const shifted = missing
      ? chars.map((c, i) => distance(shapes[i + 1].coarse, font.anchor(c)))
      : []
    for (let skip = 0; skip < shapes.length; skip++) {
      if (!missing && direct[skip] < 0.045) continue
      const anchors = direct.flatMap((n, i) =>
        missing ? [i < skip ? n : shifted[i]] : i === skip ? [] : [n]
      )
      if (anchors.some((n) => n > 0.095)) continue
      const error = anchors.reduce((a, b) => a + b, 0) / anchors.length
      if (error < 0.032) candidates.push({ index: skip, error, font })
    }
  }
  candidates.sort((a, b) => a.error - b.error)
  const first = candidates[0]
  if (
    !first ||
    candidates.some((other) => other.index !== first.index && other.error - first.error < 0.025)
  )
    return line
  const ch = first.font.nearest(
    shapes[first.index].coarse,
    shapes[first.index].fine,
    missing ? undefined : chars[first.index]
  )
  if (!ch || (!missing && ch === chars[first.index])) return line
  return applyGlyph(line, first.index, ch, missing === 1)
}

export function createGlyphMatcher(): (image: ImageData, lines: string[]) => string[] {
  // Local font names fall back according to the host. Neighboring OCR anchors must
  // independently demonstrate a close optical match before an atlas is ever built.
  const fonts = [
    '700 82px "Heiti SC"',
    '82px "Microsoft JhengHei"',
    '82px sans-serif',
    '700 82px "Songti SC"',
    '82px serif'
  ].map((f) => new GlyphFont(f))
  return (image, lines) => {
    const rows = slideRows(image, lines.length)
    return lines.map((line, i) => (rows[i] ? correctGlyphRow(line, rows[i]!, fonts) : line))
  }
}
