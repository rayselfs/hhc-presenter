import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMeetingWindowsApi } from '../meeting-windows-api'

const ORIGIN = 'https://www.alive.org.tw'

describe('meeting windows API', () => {
  afterEach(() => vi.useRealTimers())
  it('uses HHC auth, validates the redacted response, and caches for 60 seconds', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ startsAt: '2026-09-02T01:00:00Z', endsAt: '2026-09-02T03:00:00Z' }],
            meta: {},
            error: null
          })
        )
    )
    const api = createMeetingWindowsApi(
      {
        getAccessToken: vi.fn(async () => 'token'),
        refreshAfterUnauthorized: vi.fn(async () => 'refreshed')
      },
      { origin: ORIGIN, fetcher }
    )

    await expect(api.list(1_788_315_600_000)).resolves.toEqual([
      { startsAt: '2026-09-02T01:00:00Z', endsAt: '2026-09-02T03:00:00Z' }
    ])
    await api.list(1_788_315_659_999)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer token'
    )
    expect(String(fetcher.mock.calls[0]?.[0])).toMatch(
      /^https:\/\/www\.alive\.org\.tw\/api\/meeting-sync-windows\?from=.*&to=.*/
    )

    await api.list(1_788_315_660_000)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('coalesces in-flight reads and returns no active windows on failure', async () => {
    let resolve!: (response: Response) => void
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((done) => (resolve = done)))
    const api = createMeetingWindowsApi(
      {
        getAccessToken: vi.fn(async () => 'token'),
        refreshAfterUnauthorized: vi.fn(async () => null)
      },
      { origin: ORIGIN, fetcher }
    )

    const first = api.list(1_000_000)
    const second = api.list(1_000_000)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    resolve(new Response('{}', { status: 503 }))

    await expect(first).resolves.toEqual([])
    await expect(second).resolves.toEqual([])
  })

  it.each(['auth', 'fetch', 'body'])(
    'bounds a hanging %s and allows recovery without late cache writes',
    async (stage) => {
      vi.useFakeTimers()
      let release!: () => void
      const stalled = new Promise<void>((resolve) => {
        release = resolve
      })
      const data = [{ startsAt: '2026-09-02T01:00:00Z', endsAt: '2026-09-02T03:00:00Z' }]
      let attempt = 0
      const fetcher = vi.fn<typeof fetch>(async () => {
        if (stage === 'fetch' && attempt === 1) await stalled
        const response = new Response(JSON.stringify({ data, meta: {}, error: null }))
        if (stage === 'body' && attempt === 1) {
          response.json = async () => {
            await stalled
            return { data, meta: {}, error: null }
          }
        }
        return response
      })
      const api = createMeetingWindowsApi(
        {
          getAccessToken: async () => {
            attempt++
            if (stage === 'auth' && attempt === 1) await stalled
            return 'token'
          },
          refreshAfterUnauthorized: async () => null
        },
        { fetcher }
      )
      const settled = vi.fn()
      void api.list().then(settled)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(settled).toHaveBeenCalledWith([])
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(api.list()).resolves.toEqual(data)
      release()
      await vi.advanceTimersByTimeAsync(0)
      await expect(api.list()).resolves.toEqual(data)
      if (stage !== 'auth') expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    }
  )

  it('refreshes a rejected token once within the same deadline', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], meta: {}, error: null })))
    const refreshAfterUnauthorized = vi.fn(async () => 'new-token')
    const api = createMeetingWindowsApi(
      { getAccessToken: async () => 'old-token', refreshAfterUnauthorized },
      { fetcher }
    )
    await expect(api.list()).resolves.toEqual([])
    expect(refreshAfterUnauthorized).toHaveBeenCalledOnce()
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('authorization')).toBe(
      'Bearer new-token'
    )
    expect(fetcher.mock.calls[1][1]?.signal).toBe(fetcher.mock.calls[0][1]?.signal)
  })

  it('rejects malformed or privacy-expanding response fields', async () => {
    const api = createMeetingWindowsApi(
      {
        getAccessToken: vi.fn(async () => 'token'),
        refreshAfterUnauthorized: vi.fn(async () => null)
      },
      {
        origin: ORIGIN,
        fetcher: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: [
                  {
                    startsAt: '2026-09-02T01:00:00Z',
                    endsAt: '2026-09-02T03:00:00Z',
                    meetingId: 'must-not-cross'
                  }
                ]
              })
            )
        )
      }
    )

    await expect(api.list()).resolves.toEqual([])
  })
})
