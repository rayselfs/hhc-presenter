export interface CatalogDeletion {
  folderIds: string[]
  itemIds: string[]
}
const channelName = 'hhc-file-catalog-deleted'

export function publishCatalogDeletion(result: CatalogDeletion): void {
  window.dispatchEvent(new CustomEvent(channelName, { detail: result }))
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(channelName)
    channel.postMessage(result)
    channel.close()
  }
}

export function listenForCatalogDeletions(onDelete: (result: CatalogDeletion) => void): () => void {
  const receive = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    const result = value as Partial<CatalogDeletion>
    if (!Array.isArray(result.folderIds) || !Array.isArray(result.itemIds)) return
    if (![...result.folderIds, ...result.itemIds].every((id) => typeof id === 'string')) return
    onDelete({ folderIds: result.folderIds, itemIds: result.itemIds })
  }
  const local = (event: Event): void => receive((event as CustomEvent<unknown>).detail)
  window.addEventListener(channelName, local)
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(channelName)
  if (channel) channel.onmessage = (event) => receive(event.data)
  return () => {
    window.removeEventListener(channelName, local)
    channel?.close()
  }
}
