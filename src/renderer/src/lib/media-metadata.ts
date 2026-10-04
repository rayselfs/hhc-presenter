import { getFileSource, openFileExplorerDB, type FileSource } from './file-explorer-db'
import { loadPdfjsLib } from './pdfjs-loader'
import { getDerivedAsset, putDerivedAsset, type DerivedAssetMetadata } from './media-work-db'
import type { SyncDownloadCommitGuard } from './sync-provider'

export const MEDIA_METADATA_VARIANT = 'source'
const pendingSourceMediaMetadata = new Map<string, Promise<DerivedAssetMetadata | null>>()

export async function getSourceMediaMetadata(blobId: string): Promise<DerivedAssetMetadata | null> {
  const asset = await getDerivedAsset(blobId, 'media-metadata', MEDIA_METADATA_VARIANT)
  return asset?.status === 'ready' ? (asset.metadata ?? null) : null
}

export async function putSourceMediaMetadata(
  blobId: string,
  metadata: DerivedAssetMetadata
): Promise<DerivedAssetMetadata> {
  await putDerivedAsset({
    sourceBlobId: blobId,
    kind: 'media-metadata',
    variant: MEDIA_METADATA_VARIANT,
    storage: 'indexed-db',
    mimeType: 'application/json',
    status: 'ready',
    metadata
  })
  return metadata
}

function withSource<T>(source: FileSource, read: (url: string) => Promise<T>): Promise<T> {
  return read(source.url).finally(() => source.revoke())
}

async function readImageMetadata(url: string): Promise<DerivedAssetMetadata> {
  const image = new Image()
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Unable to read image metadata'))
  })
  image.src = url
  await loaded
  return { kind: 'image', width: image.naturalWidth, height: image.naturalHeight }
}

async function readVideoMetadata(url: string): Promise<DerivedAssetMetadata | null> {
  const video = document.createElement('video')
  video.preload = 'metadata'
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<DerivedAssetMetadata | null>((resolve) => {
      video.onloadedmetadata = () =>
        resolve({
          kind: 'video',
          browserPlayback: 'playable',
          width: video.videoWidth || undefined,
          height: video.videoHeight || undefined,
          durationMs:
            Number.isFinite(video.duration) && video.duration > 0
              ? Math.round(video.duration * 1000)
              : undefined
        })
      video.onerror = () => {
        const code = video.error?.code
        resolve(code === 3 || code === 4 ? { kind: 'video', browserPlayback: 'unplayable' } : null)
      }
      // A stalled/network probe is inconclusive and must remain retryable.
      timeout = setTimeout(() => resolve(null), 10_000)
      video.src = url
    })
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    video.onloadedmetadata = null
    video.onerror = null
    video.removeAttribute('src')
    video.load()
  }
}

async function readPdfMetadata(url: string): Promise<DerivedAssetMetadata> {
  const pdfjsLib = await loadPdfjsLib()
  const pdf = await pdfjsLib.getDocument({ url }).promise
  try {
    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    return {
      kind: 'pdf',
      pageCount: pdf.numPages,
      firstPageWidth: viewport.width,
      firstPageHeight: viewport.height
    }
  } finally {
    await pdf.loadingTask.destroy()
  }
}

async function loadSourceMediaMetadata(
  blobId: string,
  mimeType: string,
  guard?: SyncDownloadCommitGuard
): Promise<DerivedAssetMetadata | null> {
  const existing = await getSourceMediaMetadata(blobId)
  if (existing) return existing

  const db = await openFileExplorerDB()
  const source = await getFileSource(db, blobId, mimeType)
  if (!source) return null
  const metadata = await withSource<DerivedAssetMetadata | null>(source, async (url) => {
    if (mimeType.startsWith('image/')) return readImageMetadata(url)
    if (mimeType.startsWith('video/')) {
      try {
        return await readVideoMetadata(url)
      } catch {
        return null
      }
    }
    if (mimeType === 'application/pdf') return readPdfMetadata(url)
    return null
  })

  if (!metadata || (await guard?.()) === false) return null
  return putSourceMediaMetadata(blobId, metadata)
}

export function ensureSourceMediaMetadata(
  blobId: string,
  mimeType: string,
  guard?: SyncDownloadCommitGuard
): Promise<DerivedAssetMetadata | null> {
  const pending = pendingSourceMediaMetadata.get(blobId)
  if (pending) return pending

  const task = loadSourceMediaMetadata(blobId, mimeType, guard).finally(() => {
    if (pendingSourceMediaMetadata.get(blobId) === task) {
      pendingSourceMediaMetadata.delete(blobId)
    }
  })
  pendingSourceMediaMetadata.set(blobId, task)
  return task
}
