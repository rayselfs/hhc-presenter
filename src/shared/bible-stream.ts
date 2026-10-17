import type { BibleBook, BibleChapter, BibleVerse } from './types/bible'

export type BibleApiErrorType = 'timeout' | 'network' | 'parse'

export class BibleApiError extends Error {
  constructor(
    public type: BibleApiErrorType,
    message: string
  ) {
    super(message)
    this.name = 'BibleApiError'
  }
}

export function sortBibleBooks(books: BibleBook[]): BibleBook[] {
  books.sort((a, b) => a.number - b.number)
  for (const book of books) {
    book.chapters.sort((a, b) => a.number - b.number)
    for (const chapter of book.chapters) {
      chapter.verses.sort((a, b) => a.number - b.number)
    }
  }
  return books
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isUnsignedInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0
}

function isVerse(value: unknown): value is BibleVerse {
  return (
    isRecord(value) &&
    isUnsignedInteger(value.id) &&
    isInteger(value.number) &&
    typeof value.text === 'string'
  )
}

function isChapter(value: unknown): value is BibleChapter {
  return (
    isRecord(value) &&
    isUnsignedInteger(value.number) &&
    Array.isArray(value.verses) &&
    value.verses.every(isVerse)
  )
}

export async function parseBibleStream(stream: ReadableStream<Uint8Array>): Promise<BibleBook[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const books: BibleBook[] = []
  let buffer = ''
  let data: string[] = []
  let started = false
  let complete = false

  const dispatch = (): void => {
    if (!data.length) return
    let event: unknown
    try {
      event = JSON.parse(data.join('\n'))
    } catch {
      throw new BibleApiError('parse', 'Invalid Bible SSE JSON')
    }
    data = []
    if (!isRecord(event)) throw new BibleApiError('parse', 'Invalid Bible SSE event')
    if (event.type === 'error') {
      throw new BibleApiError(
        'network',
        typeof event.message === 'string' ? event.message : 'Bible SSE server error'
      )
    }
    if (event.type === 'timeout') {
      throw new BibleApiError('timeout', 'Server timeout during SSE stream')
    }
    if (event.type === 'start') {
      if (started) throw new BibleApiError('parse', 'Duplicate Bible SSE start')
      started = true
      return
    }
    if (!started) return
    if (event.type === 'complete') {
      if (event.total_books !== undefined && event.total_books !== books.length) {
        throw new BibleApiError('parse', 'Incomplete Bible SSE book count')
      }
      complete = true
      return
    }
    if ('version_id' in event) return
    if (
      !isUnsignedInteger(event.id) ||
      !isUnsignedInteger(event.number) ||
      typeof event.name !== 'string' ||
      typeof event.abbreviation !== 'string' ||
      !Array.isArray(event.chapters) ||
      !event.chapters.every(isChapter) ||
      books.some((book) => book.number === event.number)
    ) {
      throw new BibleApiError('parse', 'Invalid Bible SSE book')
    }
    books.push({
      number: event.number,
      code: String(event.id),
      name: event.name,
      abbreviation: event.abbreviation,
      chapters: event.chapters
    })
  }

  const readLines = (ended: boolean): void => {
    while (!complete) {
      const index = buffer.search(/[\r\n]/)
      if (index < 0) return
      if (!ended && buffer[index] === '\r' && index === buffer.length - 1) return
      const line = buffer.slice(0, index)
      const separatorLength = buffer.slice(index, index + 2) === '\r\n' ? 2 : 1
      buffer = buffer.slice(index + separatorLength)
      if (line === '') dispatch()
      else if (line === 'data' || line.startsWith('data:')) {
        const value = line === 'data' ? '' : line.slice(5)
        data.push(value.startsWith(' ') ? value.slice(1) : value)
      }
    }
  }

  try {
    while (!complete) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      readLines(done)
      if (done) break
    }
    if (!started || !complete) throw new BibleApiError('parse', 'Incomplete Bible SSE stream')
    return sortBibleBooks(books)
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
