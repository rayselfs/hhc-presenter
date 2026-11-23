import type { BibleBook } from '@shared/types/bible'
import { normalizeCitation } from './scripture-normalize'
import { locateSpokenReference, suggestSpokenReference } from './spoken-reference'

export interface VerseCandidate {
  bookNumber: number
  chapter: number
  verse: number
  endVerse: number
  bookName: string
  text: string
}

export class VerseCandidates {
  private chapter: { text: string; time: number } | null = null

  accept(raw: string, books: BibleBook[], now = performance.now()): VerseCandidate | null {
    const previous = this.chapter
    this.chapter = null
    let text = raw
      .trim()
      .replace(/[，,]/g, ' ')
      .replace(/[。.!！\s]+$/, '')
      .trim()
    if (
      previous &&
      now - previous.time <= 5000 &&
      /^(第?[零〇一二兩三四五六七八九十百\d]+|verses?\s+)/i.test(text)
    )
      text = previous.text + ' ' + text
    const normalized = normalizeCitation(text.replace(/(\d)\s*[-–]\s*(\d)/g, '$1到$2')).trim()
    if (/(?:[章篇]|chapter\s*\d+)$/i.test(normalized)) {
      if (suggestSpokenReference(normalized, books)) this.chapter = { text: normalized, time: now }
      return null
    }
    const range = normalized.match(/^(.*?)(?:節?\s*(?:到|至|to|through)\s*第?)(\d+)\s*(?:節)?$/i)
    const startText = (range?.[1] ?? normalized).replace(/\bverses\b/i, 'verse')
    const ref = locateSpokenReference(startText, books)
    if (!ref) return null
    const [bookNumber, chapter, verse] = ref
    const endVerse = range ? Number(range[2]) : verse
    const book = books.find((b) => b.number === bookNumber)
    const verses = book?.chapters
      .find((c) => c.number === chapter)
      ?.verses.filter((v) => v.number >= verse && v.number <= endVerse)
    if (!book || !verses?.length || verses.length !== endVerse - verse + 1) return null
    return {
      bookNumber,
      chapter,
      verse,
      endVerse,
      bookName: book.name,
      text: verses.map((v) => v.text).join(' ')
    }
  }
}
