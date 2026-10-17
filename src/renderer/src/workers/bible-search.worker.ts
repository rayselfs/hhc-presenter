import { Index } from 'flexsearch'

export type WorkerIncomingMessage = { id: number } & (
  | { type: 'INIT' }
  | { type: 'BUILD_INDEX'; verses: { id: number; text: string }[] }
  | {
      type: 'BUILD_CACHE_ONLY'
      verses: { id: number; text: string }[]
    }
  | { type: 'LOAD_INDEX'; chunks: { key: string; data: string }[] }
  | { type: 'EXPORT_INDEX' }
  | { type: 'SEARCH'; query: string; limit?: number; id: number }
  | { type: 'GET_PROGRESS'; id: number }
)

export type WorkerOutgoingMessage = { id: number } & (
  | { type: 'READY' }
  | { type: 'INDEX_COMPLETE'; total: number }
  | { type: 'INDEX_LOADED' }
  | { type: 'INDEX_EXPORTED'; chunks: { key: string; data: string }[] }
  | { type: 'CACHE_BUILT'; chunks: { key: string; data: string }[] }
  | { type: 'PROGRESS'; indexed: number; total: number }
  | { type: 'SEARCH_RESULT'; id: number; results: number[] }
  | { type: 'PROGRESS_RESULT'; id: number; indexed: number; total: number }
  | { type: 'ERROR'; message: string }
)

const BATCH_SIZE = 1000

let flexIndex: Index | null = null
let indexed = 0
let total = 0

// CJK Unicode ranges: CJK Unified Ideographs + Extension A + CJK Compat Ideographs
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/

/**
 * Character-level CJK encoder for FlexSearch.
 * - CJK characters: split into individual characters
 * - Non-CJK (Latin, digits, etc.): keep as space-separated words
 * This ensures any substring of CJK text is searchable via `tokenize: 'forward'`.
 */
function cjkCharEncode(text: string): string[] {
  const tokens: string[] = []
  let latinBuf = ''

  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      if (latinBuf) {
        tokens.push(latinBuf)
        latinBuf = ''
      }
      tokens.push(ch)
    } else if (/\s/.test(ch)) {
      if (latinBuf) {
        tokens.push(latinBuf)
        latinBuf = ''
      }
    } else {
      latinBuf += ch.toLowerCase()
    }
  }
  if (latinBuf) tokens.push(latinBuf)

  return tokens
}

function createIndex(): Index {
  return new Index({ encode: cjkCharEncode, tokenize: 'forward' })
}

function handleInit(id: number): void {
  try {
    flexIndex = createIndex()
    self.postMessage({ type: 'READY', id } satisfies WorkerOutgoingMessage)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    self.postMessage({ type: 'ERROR', message, id } satisfies WorkerOutgoingMessage)
  }
}

async function buildIntoIndex(
  target: Index,
  id: number,
  verses: { id: number; text: string }[]
): Promise<void> {
  total = verses.length
  indexed = 0
  target.clear()

  for (let i = 0; i < verses.length; i += BATCH_SIZE) {
    const batch = verses.slice(i, i + BATCH_SIZE)
    for (const verse of batch) {
      target.add(verse.id, verse.text)
    }
    indexed = Math.min(i + BATCH_SIZE, verses.length)
    self.postMessage({ type: 'PROGRESS', indexed, total, id } satisfies WorkerOutgoingMessage)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  indexed = total
}

async function handleBuildIndex(id: number, verses: { id: number; text: string }[]): Promise<void> {
  if (!flexIndex) {
    self.postMessage({
      type: 'ERROR',
      id,
      message: 'Index not initialized'
    } satisfies WorkerOutgoingMessage)
    return
  }

  await buildIntoIndex(flexIndex, id, verses)
  self.postMessage({ type: 'INDEX_COMPLETE', total, id } satisfies WorkerOutgoingMessage)
}

async function handleBuildCacheOnly(
  id: number,
  verses: { id: number; text: string }[]
): Promise<void> {
  const tempIndex = createIndex()
  await buildIntoIndex(tempIndex, id, verses)

  const chunks: { key: string; data: string }[] = []
  await tempIndex.export((key: string, data: string) => {
    if (data) chunks.push({ key, data })
  })
  self.postMessage({ type: 'CACHE_BUILT', chunks, id } satisfies WorkerOutgoingMessage)
}

function handleLoadIndex(id: number, chunks: { key: string; data: string }[]): void {
  if (!flexIndex) {
    self.postMessage({
      type: 'ERROR',
      id,
      message: 'Index not initialized'
    } satisfies WorkerOutgoingMessage)
    return
  }

  flexIndex.clear()
  for (const chunk of chunks) {
    flexIndex.import(chunk.key, chunk.data)
  }
  self.postMessage({ type: 'INDEX_LOADED', id } satisfies WorkerOutgoingMessage)
}

async function handleExportIndex(id: number): Promise<void> {
  if (!flexIndex) {
    self.postMessage({
      type: 'ERROR',
      id,
      message: 'Index not initialized'
    } satisfies WorkerOutgoingMessage)
    return
  }

  const chunks: { key: string; data: string }[] = []
  await flexIndex.export((key: string, data: string) => {
    if (data) chunks.push({ key, data })
  })
  self.postMessage({ type: 'INDEX_EXPORTED', chunks, id } satisfies WorkerOutgoingMessage)
}

function handleSearch(query: string, limit: number, id: number): void {
  if (!flexIndex) {
    self.postMessage({
      type: 'ERROR',
      id,
      message: 'Index not initialized'
    } satisfies WorkerOutgoingMessage)
    return
  }

  const tokens = cjkCharEncode(query)
  const joined = tokens.join(' ')
  const raw = flexIndex.search(joined, { limit })
  const results = raw.map((r) => (typeof r === 'number' ? r : Number(r)))
  self.postMessage({ type: 'SEARCH_RESULT', id, results } satisfies WorkerOutgoingMessage)
}

function handleGetProgress(id: number): void {
  self.postMessage({
    type: 'PROGRESS_RESULT',
    id,
    indexed,
    total
  } satisfies WorkerOutgoingMessage)
}

type QueuedTask = { id: number; run: () => void | Promise<void> }
const taskQueue: QueuedTask[] = []
let processing = false

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  while (taskQueue.length > 0) {
    const task = taskQueue.shift()!
    try {
      await task.run()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      self.postMessage({ type: 'ERROR', message, id: task.id } satisfies WorkerOutgoingMessage)
    }
  }
  processing = false
}

function enqueue(id: number, run: QueuedTask['run']): void {
  taskQueue.push({ id, run })
  void processQueue()
}

self.onmessage = (event: MessageEvent<WorkerIncomingMessage>) => {
  const { data } = event
  switch (data.type) {
    case 'INIT':
      enqueue(data.id, () => handleInit(data.id))
      break
    case 'BUILD_INDEX':
      enqueue(data.id, () => handleBuildIndex(data.id, data.verses))
      break
    case 'BUILD_CACHE_ONLY':
      enqueue(data.id, () => handleBuildCacheOnly(data.id, data.verses))
      break
    case 'LOAD_INDEX':
      enqueue(data.id, () => handleLoadIndex(data.id, data.chunks))
      break
    case 'EXPORT_INDEX':
      enqueue(data.id, () => handleExportIndex(data.id))
      break
    case 'SEARCH':
      try {
        handleSearch(data.query, data.limit ?? 20, data.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        self.postMessage({ type: 'ERROR', message, id: data.id } satisfies WorkerOutgoingMessage)
      }
      break
    case 'GET_PROGRESS':
      handleGetProgress(data.id)
      break
  }
}
