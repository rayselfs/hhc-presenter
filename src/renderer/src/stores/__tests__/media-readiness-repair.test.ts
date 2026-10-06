import { beforeEach, expect, it, vi } from 'vitest'
import { useMediaProjectionStore } from '../media-projection'
import { useFileExplorerStore } from '../file-explorer'
import type { FileItemRecord } from '@shared/types/folder'
import type { PresentationReadinessReport } from '@renderer/lib/presentation-readiness'

const { analyze } = vi.hoisted(() => ({ analyze: vi.fn() }))
vi.mock('@renderer/lib/presentation-readiness', async (original) => ({
  ...(await original<typeof import('@renderer/lib/presentation-readiness')>()),
  analyzePresentationReadiness: analyze
}))
vi.mock('@renderer/lib/cloud-provider', () => ({
  ensureSyncItemAvailableForPresentation: vi.fn(async () => true)
}))
const files: FileItemRecord[] = ['a', 'b', 'c'].map((id) => ({
  id,
  name: id,
  mimeType: 'image/png',
  type: 'file',
  sortIndex: 0,
  parentId: 'file-root',
  size: 1,
  url: `blob:${id}`,
  createdAt: 1,
  expiresAt: null
}))
function report(ids: string[], ready: string[]): PresentationReadinessReport {
  return {
    summary: {
      ready: ready.length,
      preparing: ids.length - ready.length,
      missing: 0,
      failed: 0,
      unsupported: 0
    },
    items: ids.map((itemId) => ({
      itemId,
      blobId: itemId,
      status: ready.includes(itemId) ? 'ready' : 'preparing',
      reason: 'metadata-building',
      support: 'native'
    }))
  }
}
beforeEach(async () => {
  useMediaProjectionStore.getState().exit()
  useFileExplorerStore.setState({ items: Object.fromEntries(files.map((f) => [f.id, f])) })
  analyze.mockReset().mockResolvedValueOnce(report(['a', 'b', 'c'], ['b']))
  await useMediaProjectionStore.getState().startPresentationWithReadiness(files, 1)
})
it('repairs then inserts in original order without replacing current snapshot entry or runtime', async () => {
  const original = useMediaProjectionStore.getState().snapshot!
  useMediaProjectionStore.getState().setZoomLevel(2)
  analyze.mockResolvedValue(report(['a'], ['a']))
  expect(await useMediaProjectionStore.getState().retryReadiness('a')).toBe(true)
  expect(useMediaProjectionStore.getState().lastReadinessReport?.summary.ready).toBe(2)
  expect(await useMediaProjectionStore.getState().addRepairedItem('a')).toBe(true)
  expect(await useMediaProjectionStore.getState().addRepairedItem('a')).toBe(false)
  const state = useMediaProjectionStore.getState()
  expect(state.playlist.map((f) => f.id)).toEqual(['a', 'b'])
  expect(state.currentItem()?.id).toBe('b')
  expect(state.zoomLevel).toBe(2)
  expect(state.snapshot?.id).toBe(original.id)
  expect(state.snapshot?.entries.find((e) => e.itemId === 'b')?.sourceUrl).toBe(
    original.entries[0].sourceUrl
  )
})
it.each(['end', 'delete', 'replace'] as const)('rejects late retry after %s', async (action) => {
  let finish!: (value: PresentationReadinessReport) => void
  analyze.mockReturnValue(
    new Promise<PresentationReadinessReport>((resolve) => {
      finish = resolve
    })
  )
  const pending = useMediaProjectionStore.getState().retryReadiness('a')
  if (action === 'end') useMediaProjectionStore.getState().endLiveSession()
  else
    useFileExplorerStore.setState({
      items: {
        ...useFileExplorerStore.getState().items,
        a: {
          ...files[0],
          ...(action === 'delete' ? { deletedAt: 2 } : { url: 'blob:replacement' })
        }
      }
    })
  finish(report(['a'], ['a']))
  expect(await pending).toBe(false)
  expect(useMediaProjectionStore.getState().playlist.some((f) => f.id === 'a')).toBe(false)
})
it('keeps skip across remounts and resets it at session end', () => {
  useMediaProjectionStore.getState().skipReadinessItem('a')
  expect(useMediaProjectionStore.getState().skippedReadinessIds).toEqual(['a'])
  useMediaProjectionStore.getState().endLiveSession()
  expect(useMediaProjectionStore.getState().skippedReadinessIds).toEqual([])
})

it.each(['start', 'end', 'source-deleted'] as const)(
  'waits for shared source ownership before publishing: %s',
  async (transition) => {
    useMediaProjectionStore.getState().exit()
    const original = Object.getOwnPropertyDescriptor(navigator, 'locks')
    const grants: Array<() => void> = []
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (_name: string, _options: unknown, callback: () => unknown) => {
          grants.push(() => {
            callback()
          })
          return new Promise<void>(() => undefined)
        }
      }
    })
    try {
      analyze.mockResolvedValue(report(['a'], transition === 'source-deleted' ? [] : ['a']))
      const result = useMediaProjectionStore.getState().startPresentation([files[0]], 0)
      expect(result).toBeInstanceOf(Promise)
      expect(useMediaProjectionStore.getState().isPresenting).toBe(false)
      if (transition === 'end') useMediaProjectionStore.getState().endLiveSession()
      grants.forEach((grant) => grant())
      await result
      expect(useMediaProjectionStore.getState().isPresenting).toBe(transition === 'start')
    } finally {
      useMediaProjectionStore.getState().exit()
      if (original) Object.defineProperty(navigator, 'locks', original)
      else Reflect.deleteProperty(navigator, 'locks')
    }
  }
)

it('invalidates repaired insertion when deletion is restored while awaiting the source lease', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'locks')
  let grant: (() => void) | undefined
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, _options: unknown, callback: () => unknown) => {
        grant = () => {
          callback()
        }
        return new Promise<void>(() => undefined)
      }
    }
  })
  try {
    analyze.mockResolvedValue(report(['a'], ['a']))
    const pending = useMediaProjectionStore.getState().addRepairedItem('a')
    await vi.waitFor(() => expect(grant).toBeDefined())
    useFileExplorerStore.setState({
      items: { ...useFileExplorerStore.getState().items, a: { ...files[0], deletedAt: 2 } }
    })
    useFileExplorerStore.setState({
      items: { ...useFileExplorerStore.getState().items, a: files[0] }
    })
    grant!()
    expect(await pending).toBe(false)
    expect(useMediaProjectionStore.getState().playlist.map((file) => file.id)).toEqual(['b'])
  } finally {
    useMediaProjectionStore.getState().exit()
    if (original) Object.defineProperty(navigator, 'locks', original)
    else Reflect.deleteProperty(navigator, 'locks')
  }
})
