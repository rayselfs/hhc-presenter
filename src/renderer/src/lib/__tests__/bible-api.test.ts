import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@renderer/lib/env', () => ({
  isElectron: vi.fn()
}))

vi.mock('@renderer/lib/http', () => ({
  http: {
    get: vi.fn()
  }
}))

import { isElectron } from '@renderer/lib/env'
import { http } from '@renderer/lib/http'
import {
  BrowserBibleApiAdapter,
  ElectronBibleApiAdapter,
  BibleApiError,
  createBibleApiAdapter
} from '../bible-api'
import type { BibleBook, BibleVersion } from '@shared/types/bible'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function encodeSSEChunk(data: object): Uint8Array {
  const json = JSON.stringify(data)
  return new TextEncoder().encode(`data: ${json}\n\n`)
}

function makeSseStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++])
      } else {
        controller.close()
      }
    }
  })
}

function makeMockResponse(stream: ReadableStream<Uint8Array>): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: stream,
    json: vi.fn()
  } as unknown as Response
}

// ─── BrowserBibleApiAdapter ───────────────────────────────────────────────────

describe('BrowserBibleApiAdapter', () => {
  let adapter: BrowserBibleApiAdapter

  beforeEach(() => {
    vi.mocked(isElectron).mockReturnValue(false)
    adapter = new BrowserBibleApiAdapter()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('fetchVersions', () => {
    it('fetches from /api/bible/v2/versions, maps raw fields, and returns BibleVersion[]', async () => {
      const raw: BibleVersion[] = [
        { id: 1, code: 'CUV', name: '和合本', updatedAt: 1765861998, locale: 'zh' }
      ]
      vi.mocked(http.get).mockResolvedValue({
        data: raw
      } as never)

      const result = await adapter.fetchVersions()
      expect(result).toEqual(raw)
      expect(http.get).toHaveBeenCalledWith('/api/bible/v2/versions', { timeout: 60_000 })
    })

    it('throws BibleApiError with type=network on non-ok response', async () => {
      vi.mocked(http.get).mockRejectedValue(new Error('404 Not Found'))

      await expect(adapter.fetchVersions()).rejects.toThrow(BibleApiError)
      try {
        await adapter.fetchVersions()
      } catch (e) {
        expect(e).toBeInstanceOf(BibleApiError)
        expect((e as BibleApiError).type).toBe('network')
      }
    })

    it('throws BibleApiError with type=timeout when fetch aborts', async () => {
      vi.mocked(http.get).mockRejectedValue(
        new DOMException('The operation was aborted', 'AbortError')
      )

      await expect(adapter.fetchVersions()).rejects.toMatchObject({
        type: 'timeout'
      })
    })
  })

  describe('fetchContent — SSE parsing', () => {
    it('parses a well-formed SSE stream and returns sorted books', async () => {
      const stream = makeSseStream([
        encodeSSEChunk({ type: 'start' }),
        encodeSSEChunk({ id: 2, number: 2, name: 'Exodus', abbreviation: 'Exo', chapters: [] }),
        encodeSSEChunk({ id: 1, number: 1, name: 'Genesis', abbreviation: 'Gen', chapters: [] }),
        encodeSSEChunk({ type: 'complete', total_books: 2 })
      ])

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(stream)))

      const books = await adapter.fetchContent(1)
      expect(books).toHaveLength(2)
      expect(books[0].number).toBe(1)
      expect(books[0].name).toBe('Genesis')
      expect(books[1].number).toBe(2)
      expect(books[1].name).toBe('Exodus')
    })

    it('ignores book events before "start" event', async () => {
      const stream = makeSseStream([
        encodeSSEChunk({ id: 99, number: 99, name: 'Phantom', abbreviation: 'Ph', chapters: [] }),
        encodeSSEChunk({ type: 'start' }),
        encodeSSEChunk({ id: 1, number: 1, name: 'Genesis', abbreviation: 'Gen', chapters: [] }),
        encodeSSEChunk({ type: 'complete' })
      ])

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(stream)))

      const books = await adapter.fetchContent(1)
      expect(books).toHaveLength(1)
      expect(books[0].name).toBe('Genesis')
    })

    it('throws BibleApiError with type=network on SSE error event', async () => {
      const makeStream = (): ReadableStream<Uint8Array> =>
        makeSseStream([
          encodeSSEChunk({ type: 'start' }),
          encodeSSEChunk({ type: 'error', message: 'Server blew up' })
        ])

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(() => Promise.resolve(makeMockResponse(makeStream())))
      )

      await expect(adapter.fetchContent(1)).rejects.toMatchObject({
        type: 'network',
        message: 'Server blew up'
      })
    })

    it('throws BibleApiError with type=timeout on SSE timeout event', async () => {
      const makeStream = (): ReadableStream<Uint8Array> =>
        makeSseStream([encodeSSEChunk({ type: 'start' }), encodeSSEChunk({ type: 'timeout' })])

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(() => Promise.resolve(makeMockResponse(makeStream())))
      )

      await expect(adapter.fetchContent(1)).rejects.toMatchObject({
        type: 'timeout'
      })
    })

    it('handles partial chunks (line split across reads)', async () => {
      const full = `data: ${JSON.stringify({ type: 'start' })}\n\ndata: ${JSON.stringify({ id: 1, number: 1, name: 'Genesis', abbreviation: 'Gen', chapters: [] })}\n\ndata: ${JSON.stringify({ type: 'complete' })}\n\n`
      const encoder = new TextEncoder()
      const bytes = encoder.encode(full)
      const mid = Math.floor(bytes.length / 2)
      const chunk1 = bytes.slice(0, mid)
      const chunk2 = bytes.slice(mid)

      const stream = makeSseStream([chunk1, chunk2])
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(stream)))

      const books = await adapter.fetchContent(1)
      expect(books).toHaveLength(1)
      expect(books[0].name).toBe('Genesis')
    })

    it('throws BibleApiError with type=network when response body is null', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: 'OK',
          body: null,
          json: vi.fn()
        })
      )

      await expect(adapter.fetchContent(1)).rejects.toMatchObject({
        type: 'network'
      })
    })

    it('sorts chapters and verses within each book', async () => {
      const chapters = [
        {
          number: 3,
          verses: [
            { id: 301, number: 2, text: 'v2' },
            { id: 300, number: 1, text: 'v1' }
          ]
        },
        { number: 1, verses: [] },
        { number: 2, verses: [] }
      ]
      const stream = makeSseStream([
        encodeSSEChunk({ type: 'start' }),
        encodeSSEChunk({ id: 1, number: 1, name: 'Genesis', abbreviation: 'Gen', chapters }),
        encodeSSEChunk({ type: 'complete' })
      ])

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeMockResponse(stream)))

      const books = await adapter.fetchContent(1)
      expect(books[0].chapters[0].number).toBe(1)
      expect(books[0].chapters[1].number).toBe(2)
      expect(books[0].chapters[2].number).toBe(3)
      expect(books[0].chapters[2].verses[0].number).toBe(1)
      expect(books[0].chapters[2].verses[1].number).toBe(2)
    })
  })
})

// ─── ElectronBibleApiAdapter ──────────────────────────────────────────────────

describe('ElectronBibleApiAdapter', () => {
  let adapter: ElectronBibleApiAdapter
  let mockGetVersions: ReturnType<typeof vi.fn>
  let mockGetContent: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.mocked(isElectron).mockReturnValue(true)
    mockGetVersions = vi.fn()
    mockGetContent = vi.fn()

    vi.stubGlobal('window', {
      api: {
        bible: {
          getVersions: mockGetVersions,
          getContent: mockGetContent
        }
      }
    })

    adapter = new ElectronBibleApiAdapter()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('fetchVersions delegates to window.api.bible.getVersions', async () => {
    const versions: BibleVersion[] = [
      { id: 1, code: 'CUV', name: '和合本', updatedAt: 1765861998, locale: 'zh' }
    ]
    mockGetVersions.mockResolvedValue(versions)

    const result = await adapter.fetchVersions()
    expect(mockGetVersions).toHaveBeenCalledOnce()
    expect(result).toEqual(versions)
  })

  it('fetchContent delegates to window.api.bible.getContent with versionId', async () => {
    const books: BibleBook[] = [
      { number: 1, code: 'Gen', name: 'Genesis', abbreviation: 'Gen', chapters: [] }
    ]
    mockGetContent.mockResolvedValue(books)

    const result = await adapter.fetchContent(1)
    expect(mockGetContent).toHaveBeenCalledWith(1)
    expect(result).toEqual(books)
  })

  it('fetchContent sorts books by number after IPC call', async () => {
    const books: BibleBook[] = [
      { number: 3, code: 'Lev', name: 'Leviticus', abbreviation: 'Lev', chapters: [] },
      { number: 1, code: 'Gen', name: 'Genesis', abbreviation: 'Gen', chapters: [] },
      { number: 2, code: 'Exo', name: 'Exodus', abbreviation: 'Exo', chapters: [] }
    ]
    mockGetContent.mockResolvedValue(books)

    const result = await adapter.fetchContent(1)
    expect(result[0].number).toBe(1)
    expect(result[1].number).toBe(2)
    expect(result[2].number).toBe(3)
  })
})

// ─── createBibleApiAdapter factory ───────────────────────────────────────────

describe('createBibleApiAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('returns ElectronBibleApiAdapter when isElectron() is true', () => {
    vi.mocked(isElectron).mockReturnValue(true)
    vi.stubGlobal('window', {
      api: { bible: { getVersions: vi.fn(), getContent: vi.fn() } }
    })

    const adapter = createBibleApiAdapter()
    expect(adapter).toBeInstanceOf(ElectronBibleApiAdapter)
  })

  it('returns BrowserBibleApiAdapter when isElectron() is false', () => {
    vi.mocked(isElectron).mockReturnValue(false)

    const adapter = createBibleApiAdapter()
    expect(adapter).toBeInstanceOf(BrowserBibleApiAdapter)
  })
})

// ─── BibleApiError ────────────────────────────────────────────────────────────

describe('BibleApiError', () => {
  it('has correct name and type fields', () => {
    const err = new BibleApiError('timeout', 'timed out')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(BibleApiError)
    expect(err.name).toBe('BibleApiError')
    expect(err.type).toBe('timeout')
    expect(err.message).toBe('timed out')
  })

  it('supports all error types', () => {
    expect(new BibleApiError('network', 'x').type).toBe('network')
    expect(new BibleApiError('parse', 'x').type).toBe('parse')
    expect(new BibleApiError('timeout', 'x').type).toBe('timeout')
  })
})
