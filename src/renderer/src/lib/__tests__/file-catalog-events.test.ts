import { afterEach, expect, it, vi } from 'vitest'
import { listenForCatalogDeletions, publishCatalogDeletion } from '../file-catalog-events'

afterEach(() => vi.unstubAllGlobals())

it('reconciles local and remote deletion once and unsubscribes on disposal', () => {
  const instances: Array<{
    onmessage: ((event: MessageEvent) => void) | null
    close: ReturnType<typeof vi.fn>
  }> = []
  const postMessage = vi.fn()
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      onmessage: ((event: MessageEvent) => void) | null = null
      close = vi.fn()
      postMessage = postMessage
      constructor() {
        instances.push(this)
      }
    }
  )
  const receive = vi.fn()
  const dispose = listenForCatalogDeletions(receive)
  const deleted = { folderIds: ['folder'], itemIds: ['item'] }
  publishCatalogDeletion(deleted)
  expect(receive).toHaveBeenCalledExactlyOnceWith(deleted)
  expect(postMessage).toHaveBeenCalledWith(deleted)
  expect(instances[1].close).toHaveBeenCalledOnce()
  instances[0].onmessage?.(
    new MessageEvent('message', { data: { folderIds: [], itemIds: ['remote'] } })
  )
  expect(receive).toHaveBeenLastCalledWith({ folderIds: [], itemIds: ['remote'] })
  instances[0].onmessage?.(new MessageEvent('message', { data: { folderIds: [], itemIds: [42] } }))
  expect(receive).toHaveBeenCalledTimes(2)
  dispose()
  publishCatalogDeletion(deleted)
  expect(receive).toHaveBeenCalledTimes(2)
  expect(instances[0].close).toHaveBeenCalledOnce()
})
