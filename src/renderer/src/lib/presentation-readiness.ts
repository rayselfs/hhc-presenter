import type { FileItemRecord } from '@shared/types/folder'
import { getBlobId } from './blob-identity'
import { isElectron } from './env'
import {
  getMediaSupport,
  resolveMediaCapability,
  type MediaPlatform,
  type MediaSupportMode
} from './media-capabilities'
import { getProviderConnection, getSyncEntryByLocalItem } from './sync-db'
import { getFileBlobRecord, isFileBlobAvailable } from './file-explorer-db'
import { ensureSourceMediaMetadata } from './media-metadata'
import { ensurePdfPageJob } from './pdf-page-jobs'

export type PresentationReadinessStatus =
  | 'ready'
  | 'preparing'
  | 'unsupported'
  | 'missing'
  | 'failed'

export interface PresentationReadiness {
  ready: number
  preparing: number
  unsupported: number
  missing: number
  failed: number
}

export interface PresentationReadinessItem {
  itemId: string
  blobId: string | null
  status: PresentationReadinessStatus
  reason: string
  support: MediaSupportMode | null
  derivativeId?: string
  playbackMode?: 'native' | 'vlc-embedded'
  playbackVariant?: 'source' | 'matroska-remux'
  seekable?: boolean
  durationMs?: number
  remoteItem?: {
    providerConnectionId: string
    remoteItemId: string
    rootRemoteFolderId: string
  }
}

export interface PresentationReadinessReport {
  summary: PresentationReadiness
  items: PresentationReadinessItem[]
}

export interface PresentationSnapshotEntry {
  index: number
  itemId: string
  blobId: string
  name: string
  mimeType: string
  sourceUrl: string
  derivativeId?: string
  playbackMode?: 'native' | 'vlc-embedded'
  playbackVariant?: 'source' | 'matroska-remux'
  seekable?: boolean
  durationMs?: number
  remoteItem?: {
    providerConnectionId: string
    remoteItemId: string
    rootRemoteFolderId: string
  }
  remoteSource?: {
    providerConnectionId: string
    remoteItemId: string
    rootRemoteFolderId: string
    leaseId?: string
    expiresAt?: number
    etag: string
  }
}

export interface PresentationSnapshot {
  id: string
  createdAt: number
  entries: PresentationSnapshotEntry[]
}

export function getPresentationPlatform(): MediaPlatform {
  return isElectron() ? 'electron' : 'web'
}

export function createPresentationSnapshot(
  items: FileItemRecord[],
  readinessItems: PresentationReadinessItem[] = []
): PresentationSnapshot {
  const readinessByItemId = new Map(readinessItems.map((item) => [item.itemId, item]))
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    entries: items.map((item, index) => ({
      index,
      itemId: item.id,
      blobId: getBlobId(item),
      name: item.name,
      mimeType: item.mimeType,
      sourceUrl: item.url,
      derivativeId: readinessByItemId.get(item.id)?.derivativeId,
      playbackMode: readinessByItemId.get(item.id)?.playbackMode,
      playbackVariant: readinessByItemId.get(item.id)?.playbackVariant,
      seekable: readinessByItemId.get(item.id)?.seekable,
      durationMs: readinessByItemId.get(item.id)?.durationMs,
      remoteItem: readinessByItemId.get(item.id)?.remoteItem
    }))
  }
}

export function getPresentationSnapshotResourceIds(snapshot: PresentationSnapshot): string[] {
  const ids = new Set<string>()
  for (const entry of snapshot.entries) {
    ids.add(entry.blobId)
    if (entry.derivativeId) ids.add(entry.derivativeId)
  }
  return [...ids]
}

export async function analyzePresentationReadiness(
  items: FileItemRecord[],
  platform: MediaPlatform = getPresentationPlatform()
): Promise<PresentationReadinessReport> {
  const report: PresentationReadinessReport = {
    summary: {
      ready: 0,
      preparing: 0,
      unsupported: 0,
      missing: 0,
      failed: 0
    },
    items: []
  }

  for (const item of items) {
    const result = await analyzePresentationItem(item, platform)
    report.items.push(result)
    report.summary[result.status] += 1
  }

  return report
}

async function analyzePresentationItem(
  item: FileItemRecord,
  platform: MediaPlatform
): Promise<PresentationReadinessItem> {
  const blobId = getBlobId(item)
  if (item.url.startsWith('unsupported:')) {
    return {
      itemId: item.id,
      blobId,
      status: 'unsupported',
      reason: 'unsupported-placeholder',
      support: null
    }
  }

  if (!item.url || !blobId) {
    return {
      itemId: item.id,
      blobId: null,
      status: 'missing',
      reason: 'missing-source',
      support: null
    }
  }

  const syncEntry = await getSyncEntryByLocalItem(item.id)
  if (syncEntry && syncEntry.status !== 'available-offline') {
    const connection = await getProviderConnection(syncEntry.providerConnectionId)
    if (
      (connection?.providerType === 'hhc-line' || connection?.providerType === 'hhc-share') &&
      syncEntry.status === 'remote-only'
    ) {
      const capability = resolveMediaCapability({ mimeType: item.mimeType, fileName: item.name })
      if (!capability) {
        return {
          itemId: item.id,
          blobId,
          status: 'unsupported',
          reason: 'unsupported-media',
          support: null
        }
      }
      const support = getMediaSupport(capability, platform)
      if (support === 'unsupported') {
        return {
          itemId: item.id,
          blobId,
          status: 'unsupported',
          reason: 'unsupported-platform',
          support
        }
      }
      if (support === 'desktop-engine' && !(await isVlcEngineReady(platform))) {
        return {
          itemId: item.id,
          blobId,
          status: 'failed',
          reason: 'video-engine-unavailable',
          support
        }
      }
      return {
        itemId: item.id,
        blobId,
        status: 'ready',
        reason: 'ready-remote',
        support,
        playbackMode: support === 'desktop-engine' ? 'vlc-embedded' : 'native',
        ...(support === 'desktop-engine' && capability.canonicalMimeType === 'video/x-matroska'
          ? { playbackVariant: 'matroska-remux' as const }
          : {}),
        ...(support !== 'desktop-engine'
          ? { seekable: capability.kind === 'video' || capability.kind === 'audio' }
          : {}),
        remoteItem: {
          providerConnectionId: syncEntry.providerConnectionId,
          remoteItemId: syncEntry.remoteItemId,
          rootRemoteFolderId: syncEntry.parentRemoteItemId!
        }
      }
    }
    if (syncEntry.status === 'failed' || syncEntry.status === 'insufficient-storage') {
      return {
        itemId: item.id,
        blobId,
        status: 'failed',
        reason: `sync-${syncEntry.status}`,
        support: null
      }
    }
    return {
      itemId: item.id,
      blobId,
      status: syncEntry.status === 'deleted-pending-release' ? 'missing' : 'preparing',
      reason: `sync-${syncEntry.status}`,
      support: null
    }
  }

  const capability = resolveMediaCapability({ mimeType: item.mimeType, fileName: item.name })
  if (!capability) {
    return {
      itemId: item.id,
      blobId,
      status: 'unsupported',
      reason: 'unsupported-media',
      support: null
    }
  }

  const support = getMediaSupport(capability, platform)
  if (support === 'unsupported') {
    return {
      itemId: item.id,
      blobId,
      status: 'unsupported',
      reason: 'unsupported-platform',
      support
    }
  }

  if (!(await isFileBlobAvailable(blobId))) {
    return {
      itemId: item.id,
      blobId,
      status: syncEntry ? 'preparing' : 'missing',
      reason: syncEntry ? 'sync-missing-source' : 'missing-source',
      support
    }
  }

  if (capability.kind === 'pdf') {
    try {
      await ensurePdfPageJob({ sourceBlobId: blobId, itemId: item.id })
    } catch (error) {
      console.warn('[pdf-pages] Failed to enqueue page thumbnails', { blobId, error })
    }
  }

  const metadata =
    capability.kind === 'video' && support !== 'desktop-engine'
      ? await ensureSourceMediaMetadata(blobId, item.mimeType)
      : null
  const durationMs = metadata?.durationMs

  if (
    platform === 'web' &&
    capability.kind === 'video' &&
    metadata?.browserPlayback === 'unplayable'
  ) {
    return {
      itemId: item.id,
      blobId,
      status: 'unsupported',
      reason: 'browser-video-unplayable',
      support
    }
  }

  if (support === 'desktop-engine') {
    if (await canUseVlcEmbedded(platform, blobId)) {
      return {
        itemId: item.id,
        blobId,
        status: 'ready',
        reason: 'ready-vlc-embedded',
        support,
        playbackMode: 'vlc-embedded',
        ...(capability.canonicalMimeType === 'video/x-matroska'
          ? { playbackVariant: 'matroska-remux' as const }
          : {})
      }
    }

    return {
      itemId: item.id,
      blobId,
      status: 'failed',
      reason: 'video-engine-unavailable',
      support
    }
  }

  return {
    itemId: item.id,
    blobId,
    status: 'ready',
    reason: 'ready-native',
    support,
    playbackMode: 'native',
    seekable: true,
    durationMs
  }
}

async function canUseVlcEmbedded(platform: MediaPlatform, blobId: string): Promise<boolean> {
  if (platform !== 'electron') return false
  try {
    const record = await getFileBlobRecord(blobId)
    if (record?.storage !== 'native-fs') return false
    const info = await window.api.projectionVlc.getInfo()
    return info.status === 'ready'
  } catch {
    return false
  }
}

async function isVlcEngineReady(platform: MediaPlatform): Promise<boolean> {
  if (platform !== 'electron') return false
  try {
    return (await window.api.projectionVlc.getInfo()).status === 'ready'
  } catch {
    return false
  }
}
