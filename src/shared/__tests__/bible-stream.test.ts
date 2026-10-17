import { describe, expect, it, vi } from 'vitest'
import { parseBibleStream } from '../bible-stream'

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    }
  })
}

describe('Bible stream framing', () => {
  it('supports multiline data and ignores SSE metadata and comments', async () => {
    const source = stream(
      ': heartbeat\ndata:{"type":"start"}\n\n' +
        'id:1\nevent:book\ndata:{"id":1,"number":1,\n' +
        'data:"name":"Genesis","abbreviation":"Gen","chapters":[]}\n\n' +
        'data:{"type":"complete","total_books":1}\n\n'
    )
    await expect(parseBibleStream(source)).resolves.toMatchObject([{ code: '1', name: 'Genesis' }])
    expect(source.locked).toBe(false)
  })

  it('cancels the reader immediately on complete without waiting for EOF', async () => {
    const cancel = vi.fn()
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data:{"type":"start"}\n\ndata:{"type":"complete","total_books":0}\n\n'
          )
        )
      },
      cancel
    })
    await expect(parseBibleStream(source)).resolves.toEqual([])
    expect(cancel).toHaveBeenCalledOnce()
    expect(source.locked).toBe(false)
  })

  it('preserves signed verse numbers from the upstream Go wire model', async () => {
    const verses = [
      { id: 1, number: 0, text: 'Heading' },
      { id: 2, number: -1, text: 'Preface' }
    ]
    const book = {
      id: 0,
      number: 0,
      name: 'Book',
      abbreviation: '',
      chapters: [{ number: 0, verses }]
    }
    const source = stream(
      [{ type: 'start' }, book, { type: 'complete', total_books: 1 }]
        .map((event) => `data:${JSON.stringify(event)}\n\n`)
        .join('')
    )
    await expect(parseBibleStream(source)).resolves.toMatchObject([
      { code: '0', chapters: [{ verses: [verses[1], verses[0]] }] }
    ])
  })

  it('does not accept an unterminated completion frame', async () => {
    await expect(
      parseBibleStream(stream('data:{"type":"start"}\n\ndata:{"type":"complete"}'))
    ).rejects.toMatchObject({ type: 'parse' })
  })

  it('propagates transport failures and releases the reader', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('stream disconnected'))
      }
    })
    await expect(parseBibleStream(source)).rejects.toThrow('stream disconnected')
    expect(source.locked).toBe(false)
  })
})
