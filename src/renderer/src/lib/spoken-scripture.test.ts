import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BibleBook } from '@shared/types/bible'
import type { WorkerIncomingMessage, WorkerOutgoingMessage } from '../workers/bible-search.worker'
import { locateSpokenScripture, speechSimilarity } from './spoken-scripture'
import { searchEngine, lookupVerseById } from './bible-search'
vi.mock('./bible-search', () => ({ searchEngine: { search: vi.fn() }, lookupVerseById: vi.fn() }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
it('requires a unique long quotation and preserves canonical text', async () => {
  const text = '神愛世人，甚至將他的獨生子賜給他們。'
  const books: BibleBook[] = [
    {
      number: 43,
      name: 'John',
      code: 'John',
      abbreviation: 'Jn',
      chapters: [{ number: 3, verses: [{ id: 1, number: 16, text }] }]
    }
  ]
  vi.mocked(searchEngine.search).mockResolvedValue([1])
  vi.mocked(lookupVerseById).mockReturnValue({
    verseId: 1,
    bookNumber: 43,
    chapter: 3,
    verse: 16,
    text
  })
  const result = await locateSpokenScripture('神爱世人甚至将他的独生子赐给他们', books, 'zh')
  expect(result.reference).toEqual([43, 3, 16])
  expect(result.candidates[0].text).toBe(text)
  expect((await locateSpokenScripture('神愛世人', books, 'zh')).reference).toBeNull()
  expect(
    (await locateSpokenScripture('不要翻到約翰福音三章十六節', books, 'zh')).reference
  ).toBeNull()
  expect(speechSimilarity(['God', 'is', 'love'], ['God', 'is', 'light'])).toBeCloseTo(2 / 3)
})
it('does not automatically choose between duplicate passages', async () => {
  const text = 'In the beginning God created the heaven and the earth'
  const books: BibleBook[] = [
    {
      number: 1,
      name: '',
      code: '',
      abbreviation: '',
      chapters: [{ number: 1, verses: [1, 2].map((id) => ({ id, number: id, text })) }]
    }
  ]
  vi.mocked(searchEngine.search).mockResolvedValue([1, 2])
  vi.mocked(lookupVerseById).mockImplementation((id) => ({
    verseId: id,
    bookNumber: 1,
    chapter: 1,
    verse: id,
    text
  }))
  expect((await locateSpokenScripture(text, books, 'en')).reference).toBeNull()
})

// Local evidence replay is opt-in; private recordings are never loaded by this runner.
const root = process.env.HHC_SPEECH_PARITY_DATA
it.skipIf(!root)(
  'retains frozen synthetic decisions through the production index and locator',
  async () => {
    let receive!: (event: MessageEvent<WorkerIncomingMessage>) => void
    const pending = new Map<number, (message: WorkerOutgoingMessage) => void>()
    let sequence = 0
    const surface = {
      set onmessage(value: typeof receive) {
        receive = value
      },
      postMessage(message: WorkerOutgoingMessage) {
        if (message.type !== 'PROGRESS') pending.get(message.id)?.(message)
      }
    }
    vi.stubGlobal('self', surface)
    await import('../workers/bible-search.worker')
    const request = (data: Omit<WorkerIncomingMessage, 'id'>): Promise<WorkerOutgoingMessage> =>
      new Promise((resolve) => {
        const id = ++sequence
        pending.set(id, (message) => {
          pending.delete(id)
          resolve(message)
        })
        receive({ data: { ...data, id } } as MessageEvent<WorkerIncomingMessage>)
      })
    await request({ type: 'INIT' })
    const outcomes: unknown[] = []
    const failures: unknown[] = []
    for (const language of ['zh', 'en'] as const) {
      const source: { chapters: string[][] }[] = JSON.parse(
        readFileSync(
          join(root!, 'sources', language === 'zh' ? 'zh_cuv.json' : 'en_kjv.json'),
          'utf8'
        ).replace(/^\uFEFF/, '')
      )
      let id = 0
      const books: BibleBook[] = source.map((book, b) => ({
        number: b + 1,
        name: '',
        code: '',
        abbreviation: '',
        chapters: book.chapters.map((verses, c) => ({
          number: c + 1,
          verses: verses.map((text, v) => ({ id: ++id, number: v + 1, text }))
        }))
      }))
      const lookup = new Map(
        books.flatMap((b) =>
          b.chapters.flatMap((c) =>
            c.verses.map(
              (v) =>
                [
                  v.id,
                  {
                    verseId: v.id,
                    bookNumber: b.number,
                    chapter: c.number,
                    verse: v.number,
                    text: v.text
                  }
                ] as const
            )
          )
        )
      )
      vi.mocked(lookupVerseById).mockImplementation((id) => lookup.get(id))
      const build: WorkerIncomingMessage = {
        type: 'BUILD_INDEX',
        id: 0,
        verses: [...lookup.values()].map((v) => ({ id: v.verseId, text: v.text }))
      }
      await request(build)
      vi.mocked(searchEngine.search).mockImplementation(async (query, limit, suggest) => {
        const search: WorkerIncomingMessage = { type: 'SEARCH', id: 0, query, limit, suggest }
        const reply = await request(search)
        if (reply.type !== 'SEARCH_RESULT') throw new Error('search failed')
        return reply.results
      })
      const paths =
        language === 'zh'
          ? ['segmentation/regression-digital-v3.decisions.jsonl']
          : [
              'reference-v3/en-regression.decisions.jsonl',
              'reference-v3/en-fresh-v3.decisions.jsonl'
            ]
      for (const file of paths) {
        const rows = readFileSync(join(root!, file), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        for (const row of rows) {
          if (row.language !== language) continue
          const start = performance.now()
          const actual = (await locateSpokenScripture(row.transcript, books, language)).reference
          const baseline = row['phonetic-0.85']
          const correct = actual !== null && JSON.stringify(actual) === JSON.stringify(row.target)
          const wrong = actual !== null && !correct
          const lost = baseline.correct && !correct
          const outcome = {
            id: row.id,
            language,
            kind: row.kind,
            transcript: row.transcript,
            target: row.target,
            actual,
            previous: baseline.actual,
            correct,
            wrong,
            lost,
            ms: performance.now() - start
          }
          outcomes.push(outcome)
          if (wrong || lost) failures.push(outcome)
        }
      }
    }
    writeFileSync(
      join(root!, 'product-parity.json'),
      JSON.stringify({ outcomes, failures }, null, 2)
    )
    expect(failures).toEqual([])
  },
  120000
)
