import { pinyin } from 'pinyin-pro'
import type { BibleBook } from '@shared/types/bible'
import { getAllBookNames } from './bible-book-matcher'
import { normalizeCitation, chineseNumber } from './scripture-normalize'

const phonetic = (s: string): string => pinyin(s, { toneType: 'none', type: 'array' }).join(' ')
const key = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[一二三]/g, (c) => String('一二三'.indexOf(c) + 1))
    .replace(/[\s《》「」"'.,，。]/g, '')
const syllables = (s: string): string =>
  phonetic(s.replace(/[123]/g, (c) => '一二三'[Number(c) - 1])).replace(/\s/g, '')
const distance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < b.length; j++)
      next.push(Math.min(next[j] + 1, previous[j + 1] + 1, previous[j] + Number(a[i] !== b[j])))
    previous = next
  }
  return previous[b.length]
}
const names = getAllBookNames().map((b, i) => ({
  id: i + 1,
  keys: [key(b.zhTW), key(b.zhCN), key(b.en), ...(b.en === 'Psalms' ? ['psalm'] : [])],
  sound: syllables(key(b.zhTW))
}))
export const inhibitedSpeech = (s: string): boolean =>
  /(?:不要|別|勿|不必|不需要).{0,5}(?:翻|跳|切換|定位)|(?:只是|僅是|這是).{0,4}(?:範例|例子)|\b(?:do not|don't|never)\s+(?:turn|navigate|jump|switch)|\b(?:just an? example|example only)\b/i.test(
    s
  )
export function locateSpokenReference(
  raw: string,
  scripture: BibleBook[]
): [number, number, number] | null {
  const text = normalizeCitation(raw)
  if (inhibitedSpeech(text)) return null
  const commanded = /^\s*(?:please turn to|turn to|please read)\s+/i.test(text)
  let clean = text
    .replace(/\b([123])(?:st|nd|rd)\b/gi, '$1')
    .replace(/[《》「」"']/g, '')
    .replace(/^\s*(?:請翻到|請翻開|請看|翻到|please turn to|turn to|please read)\s*/i, '')
    .trim()
  const repeated = clean
    .replace(/[.。!！]+$/, '')
    .split(/。\s*|\.\s+/)
    .map((s) => s.trim())
  if (repeated.length > 1 && repeated.every((s) => s === repeated[0])) clean = repeated[0]
  // Repair noisy structural markers only beside an exact full book name.
  const structural = clean.match(
    /^(.+?)[第記紀集及地的]?(\d+)[章張篇扎紮抓][第記紀集及地的]?(\d+)[節结結][.。!！\s]*$/u
  )
  if (structural && names.some((n) => n.keys.includes(key(structural[1]))))
    clean = `${structural[1]} chapter ${structural[2]} verse ${structural[3]}`
  const abbreviated = clean.match(/^(.+?)\s+(\d+)\s+verses?\s+(\d+)[.。!！\s]*$/i)
  const commandedNumeric =
    commanded && clean.match(/^(.+?)\s+(\d+)(?:\s*\.\s*|\s+)(\d+)[.。!！\s]*$/i)
  const citation = abbreviated || commandedNumeric
  if (citation && names.some((n) => n.keys.includes(key(citation[1]))))
    clean = `${citation[1]} chapter ${citation[2]} verse ${citation[3]}`
  const m = clean.match(
    /^(.+?)\s*(?:(?:chapter\s*|第?\s*)(\d+)\s*(?:章|張|篇)\s*(?:verse\s*|第?\s*)(\d+)\s*(?:節|节)?|chapter\s*(\d+)\s*verse\s*(\d+)|(\d+)\s*[:：]\s*(\d+))[.。!！\s]*$/i
  )
  if (!m) return null
  const chapter = Number(m[2] ?? m[4] ?? m[6])
  const verse = Number(m[3] ?? m[5] ?? m[7])
  const book = key(m[1])
  if (/第[零〇一二兩三四五六七八九十百\d]+[章節]/.test(book)) return null
  const exact = names.filter((n) => n.keys.includes(book))
  let id = exact.length === 1 ? exact[0].id : null
  if (!id && /^[\p{Script=Han}123]+$/u.test(book)) {
    const sound = syllables(book)
    const candidates = names
      .map((n) => ({
        id: n.id,
        score: 1 - distance(sound, n.sound) / Math.max(sound.length, n.sound.length)
      }))
      .sort((a, b) => b.score - a.score)
    if (candidates[0].score >= 0.75 && candidates[0].score - candidates[1].score >= 0.12)
      id = candidates[0].id
  }
  return id &&
    scripture
      .find((b) => b.number === id)
      ?.chapters.find((c) => c.number === chapter)
      ?.verses.some((v) => v.number === verse)
    ? [id, chapter, verse]
    : null
}

export interface SpokenReferenceContext {
  reference: [number, number, number]
  acceptedAt: number
}

// Unqualified grammar stays operator-confirmed; it never expands the frozen auto-follow policy.
export function suggestSpokenReference(
  raw: string,
  books: BibleBook[],
  context?: SpokenReferenceContext,
  now = performance.now()
): { reference: [number, number, number]; label: string } | null {
  const text = normalizeCitation(raw.replace(/(\d)\s*[-–]\s*(\d)/g, '$1 to $2')).trim()
  if (inhibitedSpeech(text)) return null
  const range = text.match(
    /^(.+?)(\d+)\s*(?:節)?\s*(?:到|至|to|through)\s*第?(\d+)\s*(?:節)?[.。!！\s]*$/i
  )
  if (range) {
    const prefix = range[1].replace(/\bverses\b/i, 'verse')
    const suffix = /[章篇]/.test(prefix) ? '節' : ''
    const first = locateSpokenReference(`${prefix}${range[2]}${suffix}`, books)
    const last = locateSpokenReference(`${prefix}${range[3]}${suffix}`, books)
    if (first && last && first[0] === last[0] && first[1] === last[1] && first[2] <= last[2])
      return {
        reference: first,
        label: `${books.find((b) => b.number === first[0])?.name} ${first[1]}:${first[2]}–${last[2]}`
      }
    return null
  }
  const chapter = text
    .replace(/^\s*(?:請翻到|請翻開|請看|翻到|please turn to|turn to|please read)\s*/i, '')
    .match(/^(.+?)\s*(?:chapter\s*(\d+)|第?(\d+)[章篇])[.。!！\s]*$/i)
  if (chapter) {
    const book = names.find((n) => n.keys.includes(key(chapter[1])))
    const content = books.find((b) => b.number === book?.id)
    const number = Number(chapter[2] ?? chapter[3])
    const first = content?.chapters.find((c) => c.number === number)?.verses[0]
    if (content && first)
      return {
        reference: [content.number, number, first.number],
        label: `${content.name} ${number}`
      }
  }
  if (!context || now < context.acceptedAt || now - context.acceptedAt > 30000) return null
  const relative = text.match(
    /^(?:接下來|接著)第?([零〇一二兩三四五六七八九十百\d]+)節[.。!！\s]*$|^next\s+verse\s+(\d+)[.!\s]*$/i
  )
  if (!relative) return null
  const number = /^\d+$/.test(relative[1] ?? relative[2])
    ? Number(relative[1] ?? relative[2])
    : chineseNumber(relative[1])
  const [book, chapterNumber] = context.reference
  const content = books.find((b) => b.number === book)
  if (
    !content?.chapters
      .find((c) => c.number === chapterNumber)
      ?.verses.some((v) => v.number === number)
  )
    return null
  return {
    reference: [book, chapterNumber, number],
    label: `${content.name} ${chapterNumber}:${number}`
  }
}
