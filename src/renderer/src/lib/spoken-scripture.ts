import { pinyin } from 'pinyin-pro'
import type { BibleBook } from '@shared/types/bible'
import { searchEngine, lookupVerseById } from './bible-search'
import {
  inhibitedSpeech,
  locateSpokenReference,
  suggestSpokenReference,
  type SpokenReferenceContext
} from './spoken-reference'
import { normalizeScripture, normalizeCitation } from './scripture-normalize'

export interface SpokenCandidate {
  reference: [number, number, number]
  text: string
  score: number
  label?: string
}
export interface SpokenLocation {
  reference: [number, number, number] | null
  candidates: SpokenCandidate[]
}

// Matching contiguous blocks mirrors the measured non-junk SequenceMatcher scoring.
export function speechSimilarity(
  a: string | readonly string[],
  b: string | readonly string[]
): number {
  if (!a.length || !b.length) return 0
  const pending = [[0, a.length, 0, b.length]]
  let matched = 0
  while (pending.length) {
    const [a0, a1, b0, b1] = pending.pop()!
    let previous = new Map<number, number>()
    let best = 0,
      ai = a0,
      bi = b0
    for (let i = a0; i < a1; i++) {
      const next = new Map<number, number>()
      for (let j = b0; j < b1; j++)
        if (a[i] === b[j]) {
          const length = (previous.get(j - 1) ?? 0) + 1
          next.set(j, length)
          if (length > best) {
            best = length
            ai = i - length + 1
            bi = j - length + 1
          }
        }
      previous = next
    }
    if (!best) continue
    matched += best
    if (ai > a0 && bi > b0) pending.push([a0, ai, b0, bi])
    if (ai + best < a1 && bi + best < b1) pending.push([ai + best, a1, bi + best, b1])
  }
  return (2 * matched) / (a.length + b.length)
}
const characters = (s: string): string => normalizeScripture(s).replace(/\s/g, '')
const sound = (s: string): string[] =>
  pinyin(characters(s), { toneType: 'none', type: 'array' })
    .join(' ')
    .match(/[a-z]+|\d+|[\u3400-\u9fff]/g) ?? []
const words = (s: string): string[] =>
  normalizeScripture(s).match(/[a-z]+|\d+|[\u3400-\u9fff]/g) ?? []

export async function locateSpokenScripture(
  text: string,
  books: BibleBook[],
  language: 'zh' | 'en',
  context?: SpokenReferenceContext
): Promise<SpokenLocation> {
  const none: SpokenLocation = { reference: null, candidates: [] }
  if (inhibitedSpeech(normalizeCitation(text))) return none
  const reference = locateSpokenReference(text, books)
  if (reference) return { reference, candidates: [] }
  const suggestion = suggestSpokenReference(text, books, context)
  if (suggestion) {
    const [book, chapter, verse] = suggestion.reference
    const canonical = books
      .find((b) => b.number === book)
      ?.chapters.find((c) => c.number === chapter)
      ?.verses.find((v) => v.number === verse)
    return {
      reference: null,
      candidates: [{ ...suggestion, text: canonical?.text ?? '', score: 1 }]
    }
  }
  if (/\d\s*[:：]|[零〇一二兩三四五六七八九十百\d]+\s*[章節篇張]|\b(?:chapter|verse)\b/i.test(text))
    return none
  const normalized = normalizeScripture(text)
  const query = language === 'zh' ? characters(text) : words(text)
  if (query.length < (language === 'zh' ? 8 : 5)) return none
  const ids = new Set(await searchEngine.search(normalized, 48, true))
  // Bounded partial queries recover candidates when one ASR word misses the index.
  const parts = [...query]
  for (const offset of [0, Math.floor(parts.length / 2)]) {
    const phrase = parts
      .slice(offset, offset + Math.max(4, Math.ceil(parts.length / 2)))
      .join(language === 'zh' ? '' : ' ')
    for (const id of await searchEngine.search(phrase, 24, true)) ids.add(id)
  }
  const candidates: SpokenCandidate[] = []
  const phoneticCandidates: SpokenCandidate[] = []
  const querySound = language === 'zh' ? sound(text) : []
  for (const id of [...ids].slice(0, 96)) {
    const item = lookupVerseById(id)
    if (!item) continue
    const verses = books
      .find((b) => b.number === item.bookNumber)
      ?.chapters.find((c) => c.number === item.chapter)?.verses
    if (!verses) continue
    const index = verses.findIndex((v) => v.id === id)
    if (index < 0) continue
    const windows = [
      verses[index].text,
      verses
        .slice(index, index + 2)
        .map((v) => v.text)
        .join(' ')
    ]
    let score = 0
    let phonetic = 0
    for (const value of windows) {
      const candidate = language === 'zh' ? characters(value) : words(value)
      const characterScore = speechSimilarity(query, candidate)
      const phoneticScore =
        language === 'zh' && query.length >= 12 && characterScore >= 0.55
          ? speechSimilarity(querySound, sound(value))
          : 0
      score = Math.max(score, characterScore)
      phonetic = Math.max(phonetic, phoneticScore)
    }
    phoneticCandidates.push({
      reference: [item.bookNumber, item.chapter, item.verse],
      text: item.text,
      score: phonetic
    })
    candidates.push({
      reference: [item.bookNumber, item.chapter, item.verse],
      text: item.text,
      score
    })
  }
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  const safe = best && best.score >= 0.82 && best.score - (candidates[1]?.score ?? 0) >= 0.1
  phoneticCandidates.sort((a, b) => b.score - a.score)
  const phonetic = phoneticCandidates[0]
  const soundSafe =
    phonetic &&
    phonetic.score >= 0.85 &&
    phonetic.score - (phoneticCandidates[1]?.score ?? 0) >= 0.1
  return {
    reference: safe ? best.reference : soundSafe ? phonetic.reference : null,
    candidates: candidates.filter((c) => c.score >= 0.55).slice(0, 3)
  }
}
