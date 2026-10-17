import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerBibleApiHandlers } from '../ipc/bible-api'
import type { WindowManager } from '../windowManager'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../ipc/validate', () => ({ isMainWindow: () => true }))
vi.mock('../lib/http', () => ({ http: { get: vi.fn() } }))

const book = { id: 1, number: 1, name: '創世記', abbreviation: 'Gen', chapters: [] }
const encode = (events: unknown[]): string =>
  events.map((event) => `data:${JSON.stringify(event)}\r\n\r\n`).join('')

function response(text: string, split = 1): Response {
  const bytes = new TextEncoder().encode(text)
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += split) {
          controller.enqueue(bytes.slice(index, index + split))
        }
        controller.close()
      }
    })
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Desktop Bible SSE contract', () => {
  async function fetchContent(text: string): Promise<unknown> {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(text))
    )
    registerBibleApiHandlers({} as WindowManager)
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'bible:get-content')?.[1]
    if (!handler) throw new Error('Bible handler not registered')
    return handler({} as Electron.IpcMainInvokeEvent, 1)
  }

  it('maps books from CRLF frames split at every UTF-8 byte', async () => {
    await expect(
      fetchContent(
        encode([
          { ...book, id: 99, number: 99 },
          { type: 'start' },
          book,
          { type: 'complete', total_books: 1 }
        ])
      )
    ).resolves.toEqual([{ ...book, id: undefined, code: '1' }])
  })

  it.each([
    [{ type: 'error', message: 'server failed' }, 'server failed'],
    [{ type: 'timeout' }, 'Server timeout'],
    [{ type: 'complete', total_books: 2 }, 'Incomplete Bible SSE book count']
  ])('rejects a partial result followed by %j', async (last, message) => {
    await expect(fetchContent(encode([{ type: 'start' }, book, last]))).rejects.toThrow(message)
  })

  it('rejects EOF without a completion frame', async () => {
    await expect(fetchContent(encode([{ type: 'start' }, book]))).rejects.toThrow(
      'Incomplete Bible SSE stream'
    )
  })

  it('rejects malformed chapter data instead of caching partial books', async () => {
    await expect(
      fetchContent(
        encode([
          { type: 'start' },
          { ...book, chapters: [{ number: 1, verses: [{ id: 1, number: 1 }] }] },
          { type: 'complete' }
        ])
      )
    ).rejects.toThrow('Invalid Bible SSE book')
  })

  it('rejects invalid JSON after valid books', async () => {
    await expect(
      fetchContent(encode([{ type: 'start' }, book]) + 'data:{broken}\n\n')
    ).rejects.toThrow('Invalid Bible SSE JSON')
  })
})
