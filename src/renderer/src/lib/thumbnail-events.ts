export interface ThumbnailReadyDetail {
  itemId: string
  sourceBlobId: string
}

export function notifyThumbnailReady(itemId: string, sourceBlobId: string): void {
  window.dispatchEvent(
    new CustomEvent<ThumbnailReadyDetail>('hhc:thumbnail-ready', {
      detail: { itemId, sourceBlobId }
    })
  )
}
