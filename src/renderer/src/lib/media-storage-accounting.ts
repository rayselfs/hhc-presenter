import { isElectron } from './env'
import { listFileBlobRecords, type FileBlobRecord } from './file-explorer-db'
import {
  listCustomCoverOverrides,
  listDerivedAssets,
  type DerivedAssetKind,
  type DerivedAssetRecord
} from './media-work-db'
import { listSyncEntries, listSyncTombstones } from './sync-db'

export interface MediaStorageUsage {
  electronNativeSourceMedia: number
  webIndexedDbSourceBlobs: number
  legacyElectronIndexedDbBlobs: number
  generatedCoverThumbnails: number
  customCoverOverrides: number
  pdfPageThumbnails: number
  videoPosters: number
  videoRemuxCache: number
  presentationDocuments: number
  syncCache: number
  temporaryAndFailedJobFiles: number
}

export interface BrowserStorageEstimate {
  quota?: number
  usage?: number
  persisted?: boolean
}

export interface MediaStorageAccountingReport {
  usage: MediaStorageUsage
  total: number
  browser?: BrowserStorageEstimate
}

const EMPTY_USAGE: MediaStorageUsage = {
  electronNativeSourceMedia: 0,
  webIndexedDbSourceBlobs: 0,
  legacyElectronIndexedDbBlobs: 0,
  generatedCoverThumbnails: 0,
  customCoverOverrides: 0,
  pdfPageThumbnails: 0,
  videoPosters: 0,
  videoRemuxCache: 0,
  presentationDocuments: 0,
  syncCache: 0,
  temporaryAndFailedJobFiles: 0
}

export async function getMediaStorageAccounting(): Promise<MediaStorageAccountingReport> {
  const [fileBlobs, derivedAssets, customCovers, syncEntries, syncTombstones, browser] =
    await Promise.all([
      listFileBlobRecords(),
      listDerivedAssets(),
      listCustomCoverOverrides(),
      listSyncEntries(),
      listSyncTombstones(),
      getBrowserStorageEstimate()
    ])

  const usage: MediaStorageUsage = { ...EMPTY_USAGE }
  if (isElectron()) {
    const videoCache = await window.api.nativeFs.getVideoCacheUsage()
    usage.videoRemuxCache = videoCache.cacheBytes
    usage.temporaryAndFailedJobFiles = videoCache.temporaryBytes
  }

  const tombstoneBlobIds = new Set(
    syncTombstones.map((tombstone) => tombstone.blobId).filter((id): id is string => !!id)
  )
  const cachedBlobSizes = new Map<string, number>()
  for (const entry of syncEntries) {
    if (!entry.blobId || tombstoneBlobIds.has(entry.blobId)) continue
    if (['available-offline', 'outdated', 'deleted-pending-release'].includes(entry.status))
      cachedBlobSizes.set(entry.blobId, entry.size ?? 0)
  }
  for (const record of fileBlobs) {
    const size = getFileBlobRecordSize(record)
    if (cachedBlobSizes.has(record.id)) {
      cachedBlobSizes.set(record.id, size)
      continue
    }
    if (record.storage === 'native-fs') {
      usage.electronNativeSourceMedia += size
    } else if (isElectron()) {
      usage.legacyElectronIndexedDbBlobs += size
    } else {
      usage.webIndexedDbSourceBlobs += size
    }
  }

  usage.syncCache = [...cachedBlobSizes.values()].reduce((sum, size) => sum + size, 0)

  for (const asset of derivedAssets) {
    const size = getDerivedAssetSize(asset)
    if (asset.status === 'failed') {
      usage.temporaryAndFailedJobFiles += size
      continue
    }

    usage[getDerivedAssetBucket(asset.kind)] += size
  }

  for (const cover of customCovers) {
    usage.customCoverOverrides += cover.blob.size ?? 0
  }

  return {
    usage,
    total: Object.values(usage).reduce((sum, value) => sum + value, 0),
    browser
  }
}

function getFileBlobRecordSize(record: FileBlobRecord): number {
  return record.size ?? record.blob?.size ?? 0
}

function getDerivedAssetSize(asset: DerivedAssetRecord): number {
  return (
    asset.size ?? asset.blob?.size ?? asset.blobs?.reduce((sum, blob) => sum + blob.size, 0) ?? 0
  )
}

function getDerivedAssetBucket(kind: DerivedAssetKind): keyof MediaStorageUsage {
  switch (kind) {
    case 'cover-thumbnail':
      return 'generatedCoverThumbnails'
    case 'pdf-page-thumbnails':
      return 'pdfPageThumbnails'
    case 'video-poster':
      return 'videoPosters'
    case 'media-metadata':
      return 'generatedCoverThumbnails'
    case 'presentation-page-document':
    case 'editable-presentation-document':
      return 'presentationDocuments'
  }
}

async function getBrowserStorageEstimate(): Promise<BrowserStorageEstimate | undefined> {
  if (!navigator.storage?.estimate) return undefined
  const [estimate, persisted] = await Promise.all([
    navigator.storage.estimate().catch(() => undefined),
    navigator.storage.persisted?.().catch(() => undefined)
  ])
  if (!estimate && persisted === undefined) return undefined
  return {
    quota: estimate?.quota,
    usage: estimate?.usage,
    persisted
  }
}
