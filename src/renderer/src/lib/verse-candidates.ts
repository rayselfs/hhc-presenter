import type { BibleBook } from '@shared/types/bible'
import { getAllBookNames } from './bible-book-matcher'
import { normalizeCitation, traditionalTranscript } from './scripture-normalize'
import { inhibitedSpeech, locateSpokenReference, suggestSpokenReference } from './spoken-reference'

export interface VerseCandidate {
  bookNumber: number
  chapter: number
  verse: number
  endVerse: number
  bookName: string
  text: string
}

const fullBookNames = new Set(
  getAllBookNames().flatMap((book) => [book.zhTW, book.en.toLowerCase()])
)

export class VerseCandidates {
  private pending: { text: string; time: number } | null = null

  accept(raw: string, books: BibleBook[], now = performance.now()): VerseCandidate | null {
    const previous = this.pending
    this.pending = null
    let text = raw
      .trim()
      .replace(/[，,]/g, ' ')
      .replace(/[。.:：!！\s]+$/, '')
      .trim()
    text = traditionalTranscript(text).replace(
      /^(?:弟兄姊妹[，, ]*)?(?:我們(?:一起)?(?:來看|來讀|翻到)|請大家(?:翻到|翻開)|請翻到|請翻開|請看)\s*/,
      ''
    )
    if (inhibitedSpeech(text)) return null
    const recent =
      previous && now >= previous.time && now - previous.time <= 5000 ? previous.text : ''
    // Resolve a shortened correction only when the preceding full book establishes the pair.
    const correction = text.match(
      /^(.*?)[。.…\s]*(?:對不起|抱歉|更正)[\s，,]*是?\s*(前書|後書)(.*)$/
    )
    if (correction) {
      const book = (correction[1].trim() || recent).match(/^(.+?)(?:前書|後書)$/)
      if (!book || !fullBookNames.has(book[1] + correction[2])) return null
      text = book[1] + correction[2] + correction[3]
    }
    if (fullBookNames.has(text.toLowerCase())) {
      this.pending = { text, time: now }
      return null
    }
    if (recent && /^(第?[零〇一二兩三四五六七八九十百\d]+|(?:chapter|verses?)\s+)/i.test(text))
      text = recent + ' ' + text
    const normalized = normalizeCitation(text.replace(/(\d)\s*[-–]\s*(\d)/g, '$1到$2')).trim()
    if (/(?:[章篇]|chapter\s*\d+)$/i.test(normalized)) {
      if (suggestSpokenReference(normalized, books)) this.pending = { text: normalized, time: now }
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
