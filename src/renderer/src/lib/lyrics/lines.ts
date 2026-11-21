import { ConverterFactory } from 'opencc-js/core'
import { from, to } from 'opencc-js/preset/cn2t'
import { to as toSimplified } from 'opencc-js/preset/t2cn'
import { readMixedRowSpacing } from './mixed-spacing'
import { hasVisibleWordGap, readHanRowSpacing, restoreLyricsSpaces } from './spacing'

const traditional = ConverterFactory(...from.cn)
const taiwan = ConverterFactory(...to.tw)
// A shared character may convert in isolation but remain correct in a Traditional
// phrase (e.g. 前仆後繼). Check only the proposed edit against the existing preset.
export function traditionalGlyphForEdit(
  text: string,
  offset: number,
  glyph: string
): string | null {
  if (!/^\p{Script=Han}$/u.test(glyph)) return null
  const standard = traditional(glyph)
  const local = taiwan(standard)
  if (glyph === '祢' || standard === glyph || local === glyph) return glyph

  let shared = false
  const matchesContext = (phrase: string): boolean => {
    for (let i = phrase.indexOf(glyph); i >= 0; i = phrase.indexOf(glyph, i + glyph.length)) {
      shared = true
      if (i <= offset && text.startsWith(phrase, offset - i)) return true
    }
    return false
  }
  const outputs = new RegExp(' ([^ |]*' + glyph + '[^ |]*)(?=\\||$)', 'gu')
  for (const dictionary of from.cn.flat()) {
    if (typeof dictionary === 'string') {
      for (const match of dictionary.matchAll(outputs)) if (matchesContext(match[1])) return glyph
    } else if (dictionary.some(([, phrase]) => matchesContext(phrase))) return glyph
  }
  if (shared) return null

  // A simplified-only glyph may have several Traditional readings (e.g. 发).
  // Accept the conversion only if its reverse single-character mapping is unique.
  const candidates = new Set<string>()
  const reverse = new RegExp('(?:^|\\|)(\\p{Script=Han}) ' + glyph + '(?=\\||$)', 'gu')
  for (const dictionary of toSimplified.cn.flat()) {
    if (typeof dictionary === 'string') {
      for (const match of dictionary.matchAll(reverse)) candidates.add(taiwan(match[1]))
    } else {
      for (const [source, target] of dictionary) {
        if (target === glyph && /^\p{Script=Han}$/u.test(source)) candidates.add(taiwan(source))
      }
    }
  }
  return candidates.size === 1 && candidates.has(local) ? local : null
}
function convertRecognizedText(text: string): string {
  const converted = traditional(text)
  if (converted === text) return text
  const local = taiwan(converted)
  if (local === converted) return local
  const source = [...text],
    normalized = [...converted],
    localized = [...local]
  if (source.length !== normalized.length || source.length !== localized.length) return local
  return normalized.map((ch, i) => (ch === source[i] ? ch : localized[i])).join('')
}
function normalizeLyrics(text: string): string {
  // Preserve the worship pronoun and source punctuation while converting simplified characters.
  const contractions = text.replace(
    /\b(I|you|we|they|he|she|it|that|there|who|what)(['’])[Il]{2}\b/gu,
    '$1$2ll'
  )
  return contractions.split('祢').map(convertRecognizedText).join('祢').replace(/\s+/gu, ' ').trim()
}
export type LyricsBlock = { text: string; score: number; poly: number[][] }
export function readLyricsLines(blocks: LyricsBlock[], image?: ImageData): string[] {
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
      const box = {
        text: normalizeLyrics(block.text),
        left: Math.min(...xs),
        right: Math.max(...xs),
        top: Math.min(...ys),
        bottom: Math.max(...ys)
      }
      return {
        ...box,
        text: image ? restoreLyricsSpaces(box, image) : box.text,
        leadingSpace: /^\s/u.test(block.text),
        trailingSpace: /\s$/u.test(block.text)
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
  return rows.map((row) => {
    const text = row
      .sort((a, b) => a.left - b.left)
      .map((box, index, boxes) => {
        const previous = boxes[index - 1]
        const latinWords =
          previous &&
          /[\p{Script=Latin}\p{N}][,.;:!?…%)”"]*$/u.test(previous.text) &&
          /^[("“]*[\p{Script=Latin}\p{N}]/u.test(box.text)
        if (!previous) return box.text
        const minGap =
          Math.min(box.bottom - box.top, previous.bottom - previous.top) * (latinWords ? 0.18 : 0.5)
        const gap =
          box.left - previous.right > minGap ||
          (latinWords && image && hasVisibleWordGap(previous, box, image, minGap))
        return (gap || previous.trailingSpace || box.leadingSpace ? ' ' : '') + box.text
      })
      .join('')
    if (!image) return text
    return /^([\p{Script=Han} ]+)$/u.test(text)
      ? readHanRowSpacing(text, row, image)
      : readMixedRowSpacing(text, row, image)
  })
}
export function createLyricsGate(): { observe(lines: string[]): string[] | null; reset(): void } {
  let previous = '',
    count = 0,
    emptySince = 0
  let candidate: string[] = []
  return {
    observe(lines) {
      const normalized = lines.map((line) => line.replace(/\s+/gu, ' ').trim()).filter(Boolean)
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
