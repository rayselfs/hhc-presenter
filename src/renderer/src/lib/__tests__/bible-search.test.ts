import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WorkerOutgoingMessage } from '@renderer/workers/bible-search.worker'

vi.mock('@renderer/lib/bible-db', () => ({
  saveFlexSearchCache: vi.fn(),
  loadFlexSearchCache: vi.fn()
}))

vi.mock('@renderer/stores/bible-search', () => ({
  useBibleSearchStore: Object.assign(() => ({}), {
    getState: () => ({ setIndexReady: vi.fn() }),
    subscribe: () => () => {}
  })
}))

import { BibleSearchEngine } from '../bible-search'

type MessageHandler = (event: MessageEvent<WorkerOutgoingMessage>) => void
type ErrorHandler = (event: ErrorEvent) => void

interface MockWorker {
  postMessage: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  onmessage: null
  _triggerMessage: (data: WorkerOutgoingMessage) => void
  _triggerError: (message: string) => void
}

function makeMockWorker(): MockWorker {
  const messageListeners: MessageHandler[] = []
  const errorListeners: ErrorHandler[] = []

  const worker: MockWorker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener: vi.fn((type: string, handler: MessageHandler | ErrorHandler) => {
      if (type === 'message') messageListeners.push(handler as MessageHandler)
      if (type === 'error') errorListeners.push(handler as ErrorHandler)
    }),
    removeEventListener: vi.fn((type: string, handler: MessageHandler | ErrorHandler) => {
      if (type === 'message') {
        const idx = messageListeners.indexOf(handler as MessageHandler)
        if (idx !== -1) messageListeners.splice(idx, 1)
      }
    }),
    onmessage: null,
    _triggerMessage(data: WorkerOutgoingMessage) {
      const event = new MessageEvent('message', { data })
      for (const l of [...messageListeners]) l(event)
    },
    _triggerError(message: string) {
      const event = new ErrorEvent('error', { message })
      for (const l of [...errorListeners]) l(event)
    }
  }
  return worker
}

let mockWorker: MockWorker
let MockWorkerConstructor: ReturnType<typeof vi.fn>

beforeEach(() => {
  mockWorker = makeMockWorker()
  MockWorkerConstructor = vi.fn(function () {
    return mockWorker
  })
  vi.stubGlobal('Worker', MockWorkerConstructor)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('BibleSearchEngine', () => {
  describe('init', () => {
    it('creates a Worker and posts INIT message', async () => {
      const engine = new BibleSearchEngine()
      const initPromise = engine.init()
      mockWorker._triggerMessage({ type: 'READY', id: 1 })
      await initPromise

      expect(MockWorkerConstructor).toHaveBeenCalledOnce()
      expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'INIT', id: 1 })
    })

    it('resolves when READY message is received', async () => {
      const engine = new BibleSearchEngine()
      const initPromise = engine.init()
      mockWorker._triggerMessage({ type: 'READY', id: 1 })
      await expect(initPromise).resolves.toBeUndefined()
    })

    it('isReady() returns true after init resolves', async () => {
      const engine = new BibleSearchEngine()
      expect(engine.isReady()).toBe(false)
      const initPromise = engine.init()
      mockWorker._triggerMessage({ type: 'READY', id: 1 })
      await initPromise
      expect(engine.isReady()).toBe(true)
    })

    it('rejects when ERROR message is received during init', async () => {
      const engine = new BibleSearchEngine()
      const initPromise = engine.init()
      mockWorker._triggerMessage({ type: 'ERROR', id: 1, message: 'init failed' })
      await expect(initPromise).rejects.toThrow('init failed')
    })

    it('rejects when Worker emits error event during init', async () => {
      const engine = new BibleSearchEngine()
      const initPromise = engine.init()
      mockWorker._triggerError('worker crashed')
      await expect(initPromise).rejects.toThrow('worker crashed')
    })

    it('does nothing and returns immediately if already initialized', async () => {
      const engine = new BibleSearchEngine()
      const p1 = engine.init()
      mockWorker._triggerMessage({ type: 'READY', id: 1 })
      await p1

      const callCount = MockWorkerConstructor.mock.calls.length
      await engine.init()
      expect(MockWorkerConstructor.mock.calls.length).toBe(callCount)
    })
  })

  describe('buildIndex', () => {
    async function makeReadyEngine(): Promise<BibleSearchEngine> {
      const engine = new BibleSearchEngine()
      const p = engine.init()
      mockWorker._triggerMessage({ type: 'READY', id: 1 })
      await p
      return engine
    }

    it('posts BUILD_INDEX message with verses', async () => {
      const engine = await makeReadyEngine()
      const verses = [
        { id: 1, text: 'In the beginning God created' },
        { id: 2, text: 'And the earth was without form' }
      ]

      const buildPromise = engine.buildIndex(verses)
      mockWorker._triggerMessage({ type: 'INDEX_COMPLETE', id: 2, total: 2 })
      await buildPromise

      expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'BUILD_INDEX', verses, id: 2 })
    })

    it('resolves when INDEX_COMPLETE is received', async () => {
      const engine = await makeReadyEngine()
      const verses = [{ id: 1, text: 'test verse' }]

      const buildPromise = engine.buildIndex(verses)
      mockWorker._triggerMessage({ type: 'INDEX_COMPLETE', id: 2, total: 1 })
      await expect(buildPromise).resolves.toBeUndefined()
    })

    it('rejects if worker not initialized', async () => {
      const engine = new BibleSearchEngine()
      await expect(engine.buildIndex([{ id: 1, text: 'x' }])).rejects.toThrow(
        'BibleSearchEngine not initialized'
      )
    })

    it('rejects on ERROR message during build', async () => {
      const engine = await makeReadyEngine()
      const buildPromise = engine.buildIndex([{ id: 1, text: 'x' }])
      mockWorker._triggerMessage({ type: 'ERROR', id: 2, message: 'build failed' })
      await expect(buildPromise).rejects.toThrow('build failed')
    })

    it('updates progress via PROGRESS messages', async () => {
      const engine = await makeReadyEngine()
      const verses = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, text: `verse ${i + 1}` }))

      const buildPromise = engine.buildIndex(verses)
      mockWorker._triggerMessage({ type: 'PROGRESS', id: 2, indexed: 1000, total: 2000 })
      expect(engine.getProgress()).toEqual({ indexed: 1000, total: 2000 })

      mockWorker._triggerMessage({ type: 'INDEX_COMPLETE', id: 2, total: 2000 })
      await buildPromise
    })
  })

  describe('search', () => {
    async function makeIndexedEngine(): Promise<BibleSearchEngine> {
      const engine = new BibleSearchEngine()
      const p = engine.init()
      mockWorker._triggerMessage({ type: 'READY', id: 1 })
      await p

      const buildPromise = engine.buildIndex([
        { id: 1, text: 'In the beginning God created the heavens and the earth' },
        { id: 2, text: 'And God said let there be light' },
        { id: 3, text: 'God saw that the light was good' }
      ])
      mockWorker._triggerMessage({ type: 'INDEX_COMPLETE', id: 2, total: 3 })
      await buildPromise

      return engine
    }

    it('posts SEARCH message with correct query, limit, and id', async () => {
      const engine = await makeIndexedEngine()

      const searchPromise = engine.search('God', 10)
      const lastCall = mockWorker.postMessage.mock.calls.at(-1)?.[0]
      expect(lastCall).toMatchObject({ type: 'SEARCH', query: 'God', limit: 10 })
      expect(typeof lastCall?.id).toBe('number')

      mockWorker._triggerMessage({ type: 'SEARCH_RESULT', id: lastCall.id, results: [1, 2, 3] })
      const results = await searchPromise
      expect(results).toEqual([1, 2, 3])
    })

    it('resolves with result IDs matching the search id', async () => {
      const engine = await makeIndexedEngine()

      const s1 = engine.search('light')
      const call = mockWorker.postMessage.mock.calls.at(-1)?.[0]
      mockWorker._triggerMessage({ type: 'SEARCH_RESULT', id: call.id, results: [2, 3] })
      expect(await s1).toEqual([2, 3])
    })

    it('resolves with empty array when no results', async () => {
      const engine = await makeIndexedEngine()

      const s = engine.search('nonexistent')
      const call = mockWorker.postMessage.mock.calls.at(-1)?.[0]
      mockWorker._triggerMessage({ type: 'SEARCH_RESULT', id: call.id, results: [] })
      expect(await s).toEqual([])
    })

    it('supports concurrent searches resolved independently', async () => {
      const engine = await makeIndexedEngine()

      const s1 = engine.search('God')
      const call1 = mockWorker.postMessage.mock.calls.at(-1)?.[0]

      const s2 = engine.search('light')
      const call2 = mockWorker.postMessage.mock.calls.at(-1)?.[0]

      mockWorker._triggerMessage({ type: 'SEARCH_RESULT', id: call2.id, results: [2, 3] })
      mockWorker._triggerMessage({ type: 'SEARCH_RESULT', id: call1.id, results: [1, 2] })

      expect(await s1).toEqual([1, 2])
      expect(await s2).toEqual([2, 3])
    })

    it('uses default limit of 20 when not specified', async () => {
      const engine = await makeIndexedEngine()

      engine.search('God')
      const call = mockWorker.postMessage.mock.calls.at(-1)?.[0]
      expect(call.limit).toBe(20)
    })

    it('rejects if worker not initialized', async () => {
      const engine = new BibleSearchEngine()
      await expect(engine.search('test')).rejects.toThrow('BibleSearchEngine not initialized')
    })

    it('rejects all pending searches on Worker crash', async () => {
      const engine = await makeIndexedEngine()

      const s1 = engine.search('God')
      const s2 = engine.search('earth')

      mockWorker._triggerError('worker crashed')

      await expect(s1).rejects.toThrow('worker crashed')
      await expect(s2).rejects.toThrow('worker crashed')
    })
  })

  describe('getProgress', () => {
    it('returns { indexed: 0, total: 0 } initially', () => {
      const engine = new BibleSearchEngine()
      expect(engine.getProgress()).toEqual({ indexed: 0, total: 0 })
    })

    it('returns updated values after INDEX_COMPLETE', async () => {
      const engine = new BibleSearchEngine()
      const p = engine.init()
      mockWorker._triggerMessage({ type: 'READY', id: 1 })
      await p

      const buildPromise = engine.buildIndex([{ id: 1, text: 'x' }])
      mockWorker._triggerMessage({ type: 'INDEX_COMPLETE', id: 2, total: 1 })
      await buildPromise

      expect(engine.getProgress()).toEqual({ indexed: 1, total: 1 })
    })
  })

  describe('dispose', () => {
    it('terminates the worker', async () => {
      const engine = new BibleSearchEngine()
      const p = engine.init()
      mockWorker._triggerMessage({ type: 'READY', id: 1 })
      await p

      engine.dispose()
      expect(mockWorker.terminate).toHaveBeenCalledOnce()
    })

    it('sets isReady() to false after dispose', async () => {
      const engine = new BibleSearchEngine()
      const p = engine.init()
      mockWorker._triggerMessage({ type: 'READY', id: 1 })
      await p

      engine.dispose()
      expect(engine.isReady()).toBe(false)
    })

    it('rejects pending searches with "disposed" error', async () => {
      const engine = new BibleSearchEngine()
      const p = engine.init()
      mockWorker._triggerMessage({ type: 'READY', id: 1 })
      await p

      const buildPromise = engine.buildIndex([{ id: 1, text: 'x' }])
      mockWorker._triggerMessage({ type: 'INDEX_COMPLETE', id: 2, total: 1 })
      await buildPromise

      const searchPromise = engine.search('test')
      engine.dispose()
      await expect(searchPromise).rejects.toThrow('disposed')
    })

    it('resets progress to 0 after dispose', async () => {
      const engine = new BibleSearchEngine()
      const p = engine.init()
      mockWorker._triggerMessage({ type: 'READY', id: 1 })
      await p

      const buildPromise = engine.buildIndex([{ id: 1, text: 'x' }])
      mockWorker._triggerMessage({ type: 'INDEX_COMPLETE', id: 2, total: 1 })
      await buildPromise

      engine.dispose()
      expect(engine.getProgress()).toEqual({ indexed: 0, total: 0 })
    })
  })
})

describe('index request isolation', () => {
  async function ready(): Promise<BibleSearchEngine> {
    const engine = new BibleSearchEngine()
    const pending = engine.init()
    mockWorker._triggerMessage({ type: 'READY', id: 1 })
    await pending
    return engine
  }

  it('does not settle a second version cache with the first version response', async () => {
    const engine = await ready()
    const first = engine.buildCacheOnly([{ id: 11, text: 'first version' }])
    const firstId = mockWorker.postMessage.mock.calls.at(-1)![0].id
    const second = engine.buildCacheOnly([{ id: 22, text: 'second version' }])
    const secondId = mockWorker.postMessage.mock.calls.at(-1)![0].id
    const resolved = vi.fn()
    void second.then(resolved)
    const a = [{ key: 'a', data: 'first' }]
    const b = [{ key: 'b', data: 'second' }]
    mockWorker._triggerMessage({ type: 'CACHE_BUILT', id: firstId, chunks: a })
    expect(await first).toEqual(a)
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    mockWorker._triggerMessage({ type: 'CACHE_BUILT', id: secondId, chunks: b })
    expect(await second).toEqual(b)
  })
})

describe('index request lifetime', () => {
  async function ready(): Promise<BibleSearchEngine> {
    const engine = new BibleSearchEngine()
    const pending = engine.init()
    mockWorker._triggerMessage({ type: 'READY', id: 1 })
    await pending
    return engine
  }

  it('rejects only the request identified by an operation error', async () => {
    const engine = await ready()
    const failed = engine.buildCacheOnly([{ id: 1, text: 'one' }])
    const succeeded = engine.buildCacheOnly([{ id: 2, text: 'two' }])
    mockWorker._triggerMessage({ type: 'ERROR', id: 2, message: 'bad index' })
    mockWorker._triggerMessage({ type: 'CACHE_BUILT', id: 3, chunks: [] })
    await expect(failed).rejects.toThrow('bad index')
    await expect(succeeded).resolves.toEqual([])
    expect(engine.isReady()).toBe(true)
  })

  it.each(['dispose', 'crash'] as const)('settles all index operations on %s', async (reason) => {
    const engine = await ready()
    const requests = [
      engine.buildIndex([]),
      engine.buildCacheOnly([]),
      engine.exportIndex(),
      engine.loadIndex([]),
      engine.search('word')
    ]
    const outcomes = Promise.allSettled(requests)
    if (reason === 'dispose') engine.dispose()
    else mockWorker._triggerError('worker crashed')
    expect((await outcomes).map((result) => result.status)).toEqual(Array(5).fill('rejected'))
    expect(engine.isReady()).toBe(false)
  })

  it('settles initialization on dispose and ignores events from the previous worker', async () => {
    const engine = new BibleSearchEngine()
    const oldWorker = mockWorker
    const first = engine.init()
    engine.dispose()
    await expect(first).rejects.toThrow('disposed')
    mockWorker = makeMockWorker()
    const second = engine.init()
    oldWorker._triggerMessage({ type: 'READY', id: 1 })
    oldWorker._triggerError('late error')
    expect(engine.isReady()).toBe(false)
    mockWorker._triggerMessage({ type: 'READY', id: 2 })
    await second
    expect(engine.isReady()).toBe(true)
  })

  it('correlates concurrent load and export operations', async () => {
    const engine = await ready()
    const a = engine.exportIndex()
    const b = engine.exportIndex()
    const load = engine.loadIndex([])
    const first = [{ key: 'a', data: 'one' }]
    const second = [{ key: 'b', data: 'two' }]
    mockWorker._triggerMessage({ type: 'INDEX_EXPORTED', id: 3, chunks: second })
    mockWorker._triggerMessage({ type: 'INDEX_LOADED', id: 4 })
    mockWorker._triggerMessage({ type: 'INDEX_EXPORTED', id: 2, chunks: first })
    expect(await a).toEqual(first)
    expect(await b).toEqual(second)
    await expect(load).resolves.toBeUndefined()
  })

  it('does not mark a disposed Worker ready after its READY response', async () => {
    const engine = new BibleSearchEngine()
    const pending = engine.init()
    mockWorker._triggerMessage({ type: 'READY', id: 1 })
    engine.dispose()
    await expect(pending).rejects.toThrow('disposed')
    expect(engine.isReady()).toBe(false)
  })

  it('rejects postMessage errors without keeping an unresolved request', async () => {
    const engine = await ready()
    mockWorker.postMessage.mockImplementationOnce(() => {
      throw new Error('clone failed')
    })
    await expect(engine.buildCacheOnly([])).rejects.toThrow('clone failed')
    engine.dispose()
  })
})
