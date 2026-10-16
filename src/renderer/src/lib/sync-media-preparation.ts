import type { FileItemRecord } from '@shared/types/folder'
import { isWeb } from './env'
import { getFileSource, openFileExplorerDB } from './file-explorer-db'
import { resolveMediaCapability } from './media-capabilities'
import { ensureSourceMediaMetadata } from './media-metadata'
import { enqueueVideoPosterJob } from './video-poster-jobs'
import { getBlobId } from './blob-identity'
import { getDerivedAsset } from './media-work-db'
import { generateThumbnail } from './thumbnail-generator'
import { saveThumbnail, saveThumbnailBlob } from './thumbnail-db'
import type { SyncDownloadCommitGuard } from './sync-provider'

let activeImportedMediaPreparations = 0
const pendingImportedMediaPreparations: Array<() => void> = []

async function acquireImportedMediaPreparationSlot(): Promise<void> {
  if (activeImportedMediaPreparations < 3) {
    activeImportedMediaPreparations += 1
    return
  }
  await new Promise<void>((resolve) => pendingImportedMediaPreparations.push(resolve))
}

function releaseImportedMediaPreparationSlot(): void {
  const next = pendingImportedMediaPreparations.shift()
  if (next) next()
  else activeImportedMediaPreparations -= 1
}

export async function refreshImportedMediaAssets(
  items: FileItemRecord[],
  guard?: SyncDownloadCommitGuard
): Promise<void> {
  await Promise.all(
    items.map(async (item) => {
      await acquireImportedMediaPreparationSlot()
      try {
        if (!item.url.startsWith('blob:')) return
        const blobId = getBlobId(item)
        const capability = resolveMediaCapability({ mimeType: item.mimeType, fileName: item.name })
        if (!capability) return
        await ensureSourceMediaMetadata(blobId, item.mimeType, guard).catch((error) => {
          console.warn('[sync] Failed to store synced media metadata', {
            itemId: item.id,
            error
          })
        })
        const existingCover = await getDerivedAsset(blobId, 'cover-thumbnail')
        if (existingCover?.status === 'ready') return
        if (capability.kind === 'video' && !isWeb()) {
          await enqueueVideoPosterJob({ sourceBlobId: blobId, itemId: item.id, canCommit: guard })
          return
        }
        if (capability.thumbnail === 'none') return

        const db = await openFileExplorerDB()
        const source = await getFileSource(db, blobId, item.mimeType)
        if (!source) return
        try {
          const response = await fetch(source.url)
          if (!response.ok) return
          const file = new File([await response.blob()], item.name, { type: item.mimeType })
          const thumbnail = await generateThumbnail(file, item.mimeType)
          if (!thumbnail) return
          if ((await guard?.()) === false) return
          if (typeof thumbnail === 'string') await saveThumbnail(blobId, thumbnail)
          else await saveThumbnailBlob(blobId, thumbnail)
          if ((await guard?.()) === false) return
          const dataUrl = typeof thumbnail === 'string' ? thumbnail : URL.createObjectURL(thumbnail)
          window.dispatchEvent(
            new CustomEvent('hhc:thumbnail-ready', {
              detail: { itemId: item.id, dataUrl }
            })
          )
        } finally {
          source.revoke()
        }
      } catch (error) {
        console.warn('[sync] Failed to refresh synced media asset', {
          itemId: item.id,
          error
        })
      } finally {
        releaseImportedMediaPreparationSlot()
      }
    })
  )
}
