import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useThumbnails } from '../useThumbnails'
import { getThumbnail } from '@renderer/lib/thumbnail-db'
import { notifyThumbnailReady } from '@renderer/lib/thumbnail-events'

vi.mock('@renderer/lib/thumbnail-db', () => ({ getThumbnail: vi.fn() }))
const read = vi.mocked(getThumbnail)
const item = { id: 'item', url: 'blob:source', mimeType: 'image/jpeg' }
const revoke = vi.fn<(url: string) => void>()
beforeEach(() => {
  read.mockReset().mockResolvedValue(null)
  revoke.mockReset()
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke)
})
afterEach(() => vi.restoreAllMocks())

function deferred(): { promise: Promise<string>; resolve: (url: string) => void } {
  let resolve!: (url: string) => void
  const promise = new Promise<string>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('gives two consumers independent URLs and only revokes their own on unmount', async () => {
  const first = renderHook(() => useThumbnails([item]))
  const second = renderHook(() => useThumbnails([item]))
  await waitFor(() => expect(second.result.current.item).toBeNull())
  read.mockResolvedValueOnce('blob:first').mockResolvedValueOnce('blob:second')
  act(() => notifyThumbnailReady(item.id, 'source'))
  await waitFor(() => expect(first.result.current.item).toBe('blob:first'))
  await waitFor(() => expect(second.result.current.item).toBe('blob:second'))
  first.unmount()
  expect(revoke).toHaveBeenCalledWith('blob:first')
  expect(revoke).not.toHaveBeenCalledWith('blob:second')
  expect(second.result.current.item).toBe('blob:second')
  second.unmount()
  expect(revoke).toHaveBeenCalledWith('blob:second')
})

it('ignores unrelated items and obsolete source notifications without reading', async () => {
  const hook = renderHook(() => useThumbnails([item]))
  await waitFor(() => expect(hook.result.current.item).toBeNull())
  read.mockClear()
  act(() => {
    notifyThumbnailReady('other', 'source')
    notifyThumbnailReady('item', 'old-source')
  })
  expect(read).not.toHaveBeenCalled()
  expect(Object.keys(hook.result.current)).toEqual(['item'])
  hook.unmount()
})

it('does not let an old initial read replace a newer notification result', async () => {
  const old = deferred()
  read.mockReturnValueOnce(old.promise)
  const hook = renderHook(() => useThumbnails([item]))
  await waitFor(() => expect(read).toHaveBeenCalledOnce())
  read.mockResolvedValueOnce('blob:new')
  act(() => notifyThumbnailReady('item', 'source'))
  await waitFor(() => expect(hook.result.current.item).toBe('blob:new'))
  await act(async () => old.resolve('blob:old'))
  expect(revoke).toHaveBeenCalledWith('blob:old')
  expect(hook.result.current.item).toBe('blob:new')
  hook.unmount()
})

it('rejects a late read after an item changes its source blob', async () => {
  const old = deferred()
  read.mockReturnValueOnce(old.promise)
  const hook = renderHook(({ url }) => useThumbnails([{ ...item, url }]), {
    initialProps: { url: item.url }
  })
  await waitFor(() => expect(read).toHaveBeenCalledOnce())
  read.mockResolvedValueOnce('blob:new')
  hook.rerender({ url: 'blob:replacement' })
  await waitFor(() => expect(hook.result.current.item).toBe('blob:new'))
  await act(async () => old.resolve('blob:old'))
  expect(revoke).toHaveBeenCalledWith('blob:old')
  expect(hook.result.current.item).toBe('blob:new')
  hook.unmount()
})

it('recovers from a rejected read on a later notification', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  read.mockRejectedValueOnce(new Error('Read failed'))
  const hook = renderHook(() => useThumbnails([item]))
  await waitFor(() => expect(warn).toHaveBeenCalledOnce())
  read.mockResolvedValueOnce('blob:recovered')
  act(() => notifyThumbnailReady('item', 'source'))
  await waitFor(() => expect(hook.result.current.item).toBe('blob:recovered'))
  hook.unmount()
})

it('keeps initial reads and notification reads under the same concurrency limit', async () => {
  let active = 0
  let peak = 0
  read.mockImplementation(async () => {
    peak = Math.max(peak, ++active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    return `data:image/jpeg;base64,thumbnail`
  })
  const items = Array.from({ length: 20 }, (_, i) => ({ ...item, id: String(i) }))
  const hook = renderHook(() => useThumbnails(items))
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(0))
  act(() => {
    for (const entry of items) notifyThumbnailReady(entry.id, 'source')
  })
  await waitFor(() => expect(Object.keys(hook.result.current)).toHaveLength(20))
  expect(peak).toBeLessThanOrEqual(5)
  await waitFor(() => expect(active).toBe(0))
  hook.unmount()
})

it('keeps the current consumer URL alive through StrictMode effect replay', async () => {
  read.mockImplementation(async () => `blob:consumer-${read.mock.calls.length}`)
  const hook = renderHook(() => useThumbnails([item]), { wrapper: StrictMode })
  await waitFor(() => expect(hook.result.current.item).toMatch(/^blob:consumer-/))
  const current = hook.result.current.item
  expect(revoke).not.toHaveBeenCalledWith(current)
  hook.unmount()
  expect(revoke).toHaveBeenCalledWith(current)
})
