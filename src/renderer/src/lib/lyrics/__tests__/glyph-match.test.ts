import { correctGlyphRow } from '../glyph-match'
import type { GlyphShape } from '../glyph-shapes'

const alphabet = [...'甲乙丙丁戊']
const glyph = (ch: string): Uint8Array => Uint8Array.from(alphabet, (c) => (c === ch ? 255 : 0))
const font = {
  anchor: glyph,
  detail: glyph,
  nearest: (shape: Uint8Array) => alphabet[shape.indexOf(255)] ?? null
}
const shape = (ch: string): GlyphShape => ({ coarse: glyph(ch), aspect: 1, fine: glyph(ch) })
const shapes = [...'甲乙丙丁'].map(shape)
it('recovers a single isolated substitution or omission while preserving spaces', () => {
  expect(correctGlyphRow('甲戊 丙丁', shapes, [font])).toBe('甲乙 丙丁')
  expect(correctGlyphRow('乙丙丁', shapes, [font])).toBe('甲乙丙丁')
  expect(correctGlyphRow('甲乙丁', shapes, [font])).toBe('甲乙丙丁')
})
it('abstains on an ambiguous insertion, weak font, or multiple differing glyphs', () => {
  expect(correctGlyphRow('甲 乙丁', [...'甲丙乙丁'].map(shape), [font])).toBe('甲 乙丁')
  expect(correctGlyphRow('乙乙丁', [...'乙乙乙丁'].map(shape), [font])).toBe('乙乙丁')
  expect(correctGlyphRow('甲乙戊戊', shapes, [font])).toBe('甲乙戊戊')
  expect(correctGlyphRow('甲乙丙戊', shapes, [{ ...font, nearest: () => null }])).toBe('甲乙丙戊')
  expect(correctGlyphRow('甲ABC', shapes, [font])).toBe('甲ABC')
})
