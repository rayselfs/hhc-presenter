import { notifyThumbnailReady } from './thumbnail-events'
import { getFileBlob, getFileSource, openFileExplorerDB } from './file-explorer-db'
import { MediaJobBlockedError, mediaJobQueue } from './media-job-queue'
import { generateThumbnail } from './thumbnail-generator'
import { saveThumbnail, saveThumbnailBlob } from './thumbnail-db'
import {
  BackgroundRenderingUnavailableError,
  renderCoverThumbnail
} from './thumbnail-worker-client'
import { getBlobId } from './blob-identity'

const pendingFiles = new Map<string, { file: File; mimeType: string }>()

async function loadJobFile(sourceBlobId: string, itemId: string): Promise<File | null> {
  const db = await openFileExplorerDB()
  const requestedItem = await db.get('folder-items', itemId)
  const item =
    requestedItem?.type === 'file'
      ? requestedItem
      : (await db.getAll('folder-items')).find(
          (candidate) => candidate.type === 'file' && getBlobId(candidate) === sourceBlobId
        )
  if (!item || item.type !== 'file') return null

  const blob = await getFileBlob(db, sourceBlobId)
  if (blob) return new File([blob], item.name, { type: item.mimeType })

  const source = await getFileSource(db, sourceBlobId, item.mimeType)
  if (!source) return null
  try {
    const response = await fetch(source.url)
    if (!response.ok) throw new Error(`Failed to read thumbnail source: ${response.status}`)
    return new File([await response.blob()], item.name, { type: item.mimeType })
  } finally {
    source.revoke()
  }
}

mediaJobQueue.registerExecutor('cover-thumbnail', async (job, { signal }) => {
  if (!job.sourceBlobId || !job.itemId) throw new Error('Cover thumbnail job is missing source')
  try {
    const pending = pendingFiles.get(job.sourceBlobId)
    const file = pending?.file ?? (await loadJobFile(job.sourceBlobId, job.itemId))
    if (!file) throw new Error('Cover thumbnail source is unavailable')
    const mimeType = pending?.mimeType ?? file.type
    if (mimeType.startsWith('image/') || mimeType === 'application/pdf') {
      let blob: Blob | null
      try {
        blob = await renderCoverThumbnail(file, mimeType, signal)
      } catch (error) {
        if (error instanceof BackgroundRenderingUnavailableError) {
          throw new MediaJobBlockedError('configuration', error.message)
        }
        throw error
      }
      if (blob) {
        await saveThumbnailBlob(job.sourceBlobId, blob)
      }
    } else {
      const thumbnail = await generateThumbnail(file, mimeType)
      if (typeof thumbnail === 'string') {
        await saveThumbnail(job.sourceBlobId, thumbnail)
      }
    }
    notifyThumbnailReady(job.itemId, job.sourceBlobId)
  } finally {
    pendingFiles.delete(job.sourceBlobId)
  }
})

export async function enqueueCoverThumbnailJob(input: {
  sourceBlobId: string
  itemId: string
  file?: File
  mimeType: string
}): Promise<void> {
  if (input.file) {
    pendingFiles.set(input.sourceBlobId, { file: input.file, mimeType: input.mimeType })
  }
  try {
    await mediaJobQueue.enqueue({
      type: 'cover-thumbnail',
      sourceBlobId: input.sourceBlobId,
      itemId: input.itemId,
      dedupeKey: `cover-thumbnail:${input.sourceBlobId}`
    })
  } catch (error) {
    pendingFiles.delete(input.sourceBlobId)
    throw error
  }
}
