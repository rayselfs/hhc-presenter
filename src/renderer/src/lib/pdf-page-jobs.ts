import { loadMediaJobFile } from './media-job-source'
import { MediaJobBlockedError, mediaJobQueue } from './media-job-queue'
import { getPdfPageThumbs, savePdfPageThumbBlobs } from './thumbnail-db'
import {
  BackgroundRenderingUnavailableError,
  renderPdfPageThumbnails
} from './thumbnail-worker-client'

const pendingFiles = new Map<string, File>()

mediaJobQueue.registerExecutor('pdf-pages', async (job, { signal }) => {
  if (!job.sourceBlobId || !job.itemId) throw new Error('PDF page job is missing source identity')
  try {
    const file =
      pendingFiles.get(job.sourceBlobId) ??
      (await loadMediaJobFile(job.sourceBlobId, job.itemId, 'PDF'))
    if (!file) throw new Error('PDF source is unavailable')
    const cachedThumbs = await getPdfPageThumbs(job.sourceBlobId)
    cachedThumbs.forEach((url) => URL.revokeObjectURL(url))
    if (cachedThumbs.length > 0) return
    let blobs: Blob[]
    try {
      blobs = await renderPdfPageThumbnails(file, signal)
    } catch (error) {
      if (error instanceof BackgroundRenderingUnavailableError) {
        throw new MediaJobBlockedError('configuration', error.message)
      }
      throw error
    }
    if (blobs.length > 0) await savePdfPageThumbBlobs(job.sourceBlobId, blobs)
  } finally {
    pendingFiles.delete(job.sourceBlobId)
  }
})

export async function ensurePdfPageJob(input: {
  sourceBlobId: string
  itemId: string
  file?: File
  priority?: number
}): Promise<void> {
  const cachedThumbs = await getPdfPageThumbs(input.sourceBlobId)
  cachedThumbs.forEach((url) => URL.revokeObjectURL(url))
  if (cachedThumbs.length > 0) return

  if (input.file) pendingFiles.set(input.sourceBlobId, input.file)
  try {
    await mediaJobQueue.enqueue({
      type: 'pdf-pages',
      sourceBlobId: input.sourceBlobId,
      itemId: input.itemId,
      dedupeKey: `pdf-pages:${input.sourceBlobId}`,
      ...(input.priority !== undefined ? { priority: input.priority } : {})
    })
  } catch (error) {
    pendingFiles.delete(input.sourceBlobId)
    throw error
  }
}
