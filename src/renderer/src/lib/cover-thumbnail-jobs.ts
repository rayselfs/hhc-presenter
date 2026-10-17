import { loadMediaJobFile } from './media-job-source'
import { notifyThumbnailReady } from './thumbnail-events'
import { MediaJobBlockedError, mediaJobQueue } from './media-job-queue'
import { generateThumbnail } from './thumbnail-generator'
import { saveThumbnail, saveThumbnailBlob } from './thumbnail-db'
import {
  BackgroundRenderingUnavailableError,
  renderCoverThumbnail
} from './thumbnail-worker-client'

const pendingFiles = new Map<string, { file: File; mimeType: string }>()

mediaJobQueue.registerExecutor('cover-thumbnail', async (job, { signal }) => {
  if (!job.sourceBlobId || !job.itemId) throw new Error('Cover thumbnail job is missing source')
  try {
    const pending = pendingFiles.get(job.sourceBlobId)
    const file =
      pending?.file ?? (await loadMediaJobFile(job.sourceBlobId, job.itemId, 'thumbnail'))
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
