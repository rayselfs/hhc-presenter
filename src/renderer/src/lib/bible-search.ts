import type {
  WorkerIncomingMessage,
  WorkerOutgoingMessage
} from '@renderer/workers/bible-search.worker'
import { useBibleSearchStore } from '@renderer/stores/bible-search'
import type { BibleSearchResult } from '@renderer/stores/bible-search'
import type { BibleBook, BibleVersion } from '@shared/types/bible'
import { saveFlexSearchCache, loadFlexSearchCache } from '@renderer/lib/bible-db'

export interface BibleVerse {
  id: number
  text: string
}

type IndexChunks = { key: string; data: string }[]

export class BibleSearchEngine {
  private worker: Worker | null = null
  private ready = false
  private indexed = 0
  private total = 0
  private initPromise: Promise<void> | null = null
  private requestCounter = 0
  private pending = new Map<
    number,
    { resolve: (message: WorkerOutgoingMessage) => void; reject: (error: Error) => void }
  >()

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise
    const worker = new Worker(new URL('../workers/bible-search.worker.ts', import.meta.url), {
      type: 'module'
    })
    this.worker = worker
    worker.addEventListener('message', (event: MessageEvent<WorkerOutgoingMessage>) => {
      if (this.worker === worker) this.handleMessage(event.data)
    })
    worker.addEventListener('error', (event) => {
      if (this.worker === worker) this.reset(new Error(event.message))
    })
    worker.addEventListener('messageerror', () => {
      if (this.worker === worker) this.reset(new Error('Invalid Bible Worker response'))
    })
    this.initPromise = this.request({ type: 'INIT', id: ++this.requestCounter }, 'READY')
      .then(() => {
        if (this.worker !== worker) throw new Error('disposed')
        this.ready = true
      })
      .catch((error: Error) => {
        if (this.worker === worker) this.reset(error)
        throw error
      })
    return this.initPromise
  }

  private request<T extends WorkerOutgoingMessage['type']>(
    message: WorkerIncomingMessage,
    responseType: T
  ): Promise<Extract<WorkerOutgoingMessage, { type: T }>> {
    const worker = this.worker
    if (!worker) return Promise.reject(new Error('BibleSearchEngine not initialized'))
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, {
        resolve: (response) => {
          if (response.type !== responseType) {
            reject(new Error(`Unexpected Bible Worker response: ${response.type}`))
            return
          }
          resolve(response as Extract<WorkerOutgoingMessage, { type: T }>)
        },
        reject
      })
      try {
        worker.postMessage(message)
      } catch (error) {
        this.pending.delete(message.id)
        reject(error)
      }
    })
  }

  private handleMessage(data: WorkerOutgoingMessage): void {
    const pending = this.pending.get(data.id)
    if (!pending) return
    if (data.type === 'PROGRESS') {
      this.indexed = data.indexed
      this.total = data.total
      return
    }
    if (data.type === 'INDEX_COMPLETE') {
      this.indexed = data.total
      this.total = data.total
    }
    this.pending.delete(data.id)
    if (data.type === 'ERROR') pending.reject(new Error(data.message))
    else pending.resolve(data)
  }

  async buildIndex(verses: BibleVerse[]): Promise<void> {
    this.total = verses.length
    this.indexed = 0
    await this.request({ type: 'BUILD_INDEX', verses, id: ++this.requestCounter }, 'INDEX_COMPLETE')
  }

  async buildCacheOnly(verses: BibleVerse[]): Promise<IndexChunks> {
    const result = await this.request(
      { type: 'BUILD_CACHE_ONLY', verses, id: ++this.requestCounter },
      'CACHE_BUILT'
    )
    return result.chunks
  }

  async exportIndex(): Promise<IndexChunks> {
    const result = await this.request(
      { type: 'EXPORT_INDEX', id: ++this.requestCounter },
      'INDEX_EXPORTED'
    )
    return result.chunks
  }

  async loadIndex(chunks: IndexChunks): Promise<void> {
    await this.request({ type: 'LOAD_INDEX', chunks, id: ++this.requestCounter }, 'INDEX_LOADED')
  }

  async search(query: string, limit = 20): Promise<number[]> {
    const result = await this.request(
      { type: 'SEARCH', query, limit, id: ++this.requestCounter },
      'SEARCH_RESULT'
    )
    return result.results
  }

  getProgress(): { indexed: number; total: number } {
    return { indexed: this.indexed, total: this.total }
  }

  isReady(): boolean {
    return this.ready
  }

  private reset(error: Error): void {
    this.worker?.terminate()
    this.worker = null
    this.ready = false
    this.indexed = 0
    this.total = 0
    this.initPromise = null
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  dispose(): void {
    this.reset(new Error('disposed'))
  }
}

export const searchEngine = new BibleSearchEngine()

const verseLookups = new Map<number, Map<number, BibleSearchResult>>()

function buildVerseLookup(versionId: number, books: BibleBook[]): void {
  const map = new Map<number, BibleSearchResult>()
  for (const book of books) {
    for (const chapter of book.chapters) {
      for (const verse of chapter.verses) {
        map.set(verse.id, {
          verseId: verse.id,
          bookNumber: book.number,
          chapter: chapter.number,
          verse: verse.number,
          text: verse.text
        })
      }
    }
  }
  verseLookups.set(versionId, map)
}

function extractVerses(books: BibleBook[]): { id: number; text: string }[] {
  const verses: { id: number; text: string }[] = []
  for (const book of books) {
    for (const chapter of book.chapters) {
      for (const verse of chapter.verses) {
        verses.push({ id: verse.id, text: verse.text })
      }
    }
  }
  return verses
}

let activeVersionId: number | null = null
let initPromise: Promise<void> | null = null

export async function initializeSearchIndexes(
  allVersionsBooks: Map<number, BibleBook[]>,
  versions: BibleVersion[],
  selectedVersionId: number
): Promise<void> {
  if (initPromise) return initPromise
  initPromise = doInitialize(allVersionsBooks, versions, selectedVersionId)
  return initPromise
}

async function doInitialize(
  allVersionsBooks: Map<number, BibleBook[]>,
  versions: BibleVersion[],
  selectedVersionId: number
): Promise<void> {
  const { setIndexReady } = useBibleSearchStore.getState()

  try {
    await searchEngine.init()

    const selectedVersion = versions.find((v) => v.id === selectedVersionId)
    const selectedBooks = allVersionsBooks.get(selectedVersionId)

    if (!selectedVersion || !selectedBooks || selectedBooks.length === 0) {
      return
    }

    buildVerseLookup(selectedVersionId, selectedBooks)

    const cached = await loadFlexSearchCache(selectedVersionId, selectedVersion.updatedAt)
    if (cached) {
      await searchEngine.loadIndex(cached)
    } else {
      const verses = extractVerses(selectedBooks)
      await searchEngine.buildIndex(verses)
      const chunks = await searchEngine.exportIndex()
      saveFlexSearchCache(selectedVersionId, selectedVersion.updatedAt, chunks).catch(() => {})
    }

    activeVersionId = selectedVersionId
    setIndexReady(true)

    for (const version of versions) {
      if (version.id === selectedVersionId) continue
      const books = allVersionsBooks.get(version.id)
      if (!books || books.length === 0) continue
      buildBackgroundCache(version, books).catch(() => {})
    }
  } catch (err) {
    console.error('[bible-search] Failed to initialize search index:', err)
  }
}

async function buildBackgroundCache(version: BibleVersion, books: BibleBook[]): Promise<void> {
  const existing = await loadFlexSearchCache(version.id, version.updatedAt)
  if (existing) {
    buildVerseLookup(version.id, books)
    return
  }

  buildVerseLookup(version.id, books)
  const verses = extractVerses(books)
  const chunks = await searchEngine.buildCacheOnly(verses)
  saveFlexSearchCache(version.id, version.updatedAt, chunks).catch(() => {})
}

let switchGeneration = 0

export async function switchVersionIndex(
  versionId: number,
  version: BibleVersion,
  books: BibleBook[]
): Promise<void> {
  if (activeVersionId === versionId) return

  const gen = ++switchGeneration
  const { setIndexReady } = useBibleSearchStore.getState()
  setIndexReady(false)

  try {
    buildVerseLookup(versionId, books)

    const cached = await loadFlexSearchCache(versionId, version.updatedAt)
    if (gen !== switchGeneration) return

    if (cached) {
      await searchEngine.loadIndex(cached)
    } else {
      const verses = extractVerses(books)
      await searchEngine.buildIndex(verses)
      if (gen !== switchGeneration) return
      const chunks = await searchEngine.exportIndex()
      saveFlexSearchCache(versionId, version.updatedAt, chunks).catch(() => {})
    }

    if (gen !== switchGeneration) return

    activeVersionId = versionId
    setIndexReady(true)
  } catch {
    if (gen === switchGeneration) {
      setIndexReady(false)
    }
  }
}

export function lookupVerseById(id: number): BibleSearchResult | undefined {
  if (!activeVersionId) return undefined
  return verseLookups.get(activeVersionId)?.get(id)
}
