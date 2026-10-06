import { isElectron } from './env'
import { deleteFileBlob, listFileBlobRecords, openFileExplorerDB } from './file-explorer-db'
import {
  deleteDerivedAsset,
  listDerivedAssets,
  type DerivedAssetKind,
  type DerivedAssetRecord
} from './media-work-db'
import { isMediaResourceLocked, withMediaResourceCleanup } from './media-resource-locks'
import {
  getSyncEntryByRemoteItem,
  getSyncEntryPreference,
  listSyncEntries,
  putSyncEntry
} from './sync-db'

export interface MediaStorageCleanupResult {
  deletedAssetIds: string[]
  deletedSyncBlobIds?: string[]
}

const REGENERABLE_ASSET_KINDS: ReadonlySet<DerivedAssetKind> = new Set([
  'cover-thumbnail',
  'pdf-page-thumbnails',
  'video-poster'
])

export async function removeUnusedDerivedAssets(): Promise<MediaStorageCleanupResult> {
  const [fileBlobs, assets] = await Promise.all([listFileBlobRecords(), listDerivedAssets()])
  const sourceBlobIds = new Set(fileBlobs.map((record) => record.id))
  return deleteDerivedAssets(assets.filter((asset) => !sourceBlobIds.has(asset.sourceBlobId)))
}

export async function clearRegenerableDerivedAssets(): Promise<MediaStorageCleanupResult> {
  const assets = await listDerivedAssets()
  const result = await deleteDerivedAssets(
    assets.filter((asset) => REGENERABLE_ASSET_KINDS.has(asset.kind))
  )
  if (isElectron()) await window.api.nativeFs.clearVideoCache()
  return result
}

export async function evictRegenerableDerivedAssetsToBudget(
  maxBytes: number
): Promise<MediaStorageCleanupResult> {
  if (maxBytes < 0) throw new Error('Media storage budget must be non-negative')
  const assets = (await listDerivedAssets()).filter(
    (asset) =>
      asset.status === 'ready' &&
      REGENERABLE_ASSET_KINDS.has(asset.kind) &&
      !isMediaResourceLocked(asset.sourceBlobId)
  )
  const total = assets.reduce((sum, asset) => sum + getDerivedAssetSize(asset), 0)
  if (total <= maxBytes) return { deletedAssetIds: [] }

  let remaining = total
  const toDelete: DerivedAssetRecord[] = []
  for (const asset of [...assets].sort((a, b) => a.updatedAt - b.updatedAt)) {
    if (remaining <= maxBytes) break
    toDelete.push(asset)
    remaining -= getDerivedAssetSize(asset)
  }
  return deleteDerivedAssets(toDelete)
}

export async function clearUnpinnedSyncCache(): Promise<MediaStorageCleanupResult> {
  const entries = await listSyncEntries()
  const db = await openFileExplorerDB()
  const deletedSyncBlobIds: string[] = []

  for (const entry of entries) {
    if (!entry.blobId) continue
    if (!['available-offline', 'outdated', 'deleted-pending-release'].includes(entry.status)) {
      continue
    }
    if (isMediaResourceLocked(entry.blobId)) continue
    const preference = await getSyncEntryPreference(entry.providerConnectionId, entry.remoteItemId)
    if (preference?.offlinePolicyOverride === 'always-offline') continue

    await withMediaResourceCleanup(
      entry.blobId,
      async () => {
        const current = await getSyncEntryByRemoteItem(
          entry.providerConnectionId,
          entry.remoteItemId
        )
        if (!current || current.blobId !== entry.blobId || current.updatedAt !== entry.updatedAt)
          return
        await deleteFileBlob(db, entry.blobId!)
        await putSyncEntry({
          ...current,
          blobId: undefined,
          size: undefined,
          status: 'remote-only'
        })
        deletedSyncBlobIds.push(entry.blobId!)
      },
      { defer: false }
    )
  }

  return { deletedAssetIds: [], deletedSyncBlobIds }
}

async function deleteDerivedAssets(
  assets: DerivedAssetRecord[]
): Promise<MediaStorageCleanupResult> {
  const deletedAssetIds: string[] = []
  for (const asset of assets) {
    await withMediaResourceCleanup(
      asset.sourceBlobId,
      async () => {
        await deleteDerivedAsset(asset.sourceBlobId, asset.kind, asset.variant)
        deletedAssetIds.push(asset.id)
      },
      { defer: false }
    )
  }
  return { deletedAssetIds }
}

function getDerivedAssetSize(asset: DerivedAssetRecord): number {
  return (
    asset.size ?? asset.blob?.size ?? asset.blobs?.reduce((sum, blob) => sum + blob.size, 0) ?? 0
  )
}
