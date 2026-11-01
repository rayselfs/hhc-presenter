import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserBibleApiAdapter } from '../bible-api'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function delayedResponse(delay: number, content: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response(content)), delay)
          options.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new DOMException('Request aborted', 'AbortError'))
          })
        })
    )
  )
}

describe('Bible cold-start budget', () => {
  it('waits for a version response beyond the previous browser and desktop budgets', async () => {
    vi.useFakeTimers()
    delayedResponse(15_000, '[]')
    const result = new BrowserBibleApiAdapter().fetchVersions()
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(result).resolves.toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows cold startup plus a complete content stream', async () => {
    vi.useFakeTimers()
    delayedResponse(70_000, 'data: {"type":"start"}\n\ndata: {"type":"complete"}\n\n')
    const result = new BrowserBibleApiAdapter().fetchContent(1)
    await vi.advanceTimersByTimeAsync(70_000)
    await expect(result).resolves.toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still aborts stalled version reads after two bounded attempts', async () => {
    vi.useFakeTimers()
    delayedResponse(180_000, '[]')
    const result = expect(new BrowserBibleApiAdapter().fetchVersions()).rejects.toMatchObject({
      type: 'timeout'
    })
    await vi.advanceTimersByTimeAsync(120_000)
    await result
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
