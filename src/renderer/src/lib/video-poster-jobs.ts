import { notifyThumbnailReady } from './thumbnail-events'
import { isWeb } from './env'
import { MediaJobBlockedError, mediaJobQueue } from './media-job-queue'
import type { MediaJobRecord } from './media-work-db'
import { saveThumbnail } from './thumbnail-db'
import type { SyncDownloadCommitGuard } from './sync-provider'
import {
  listSyncEntriesByLocalItem,
  listSyncTombstones,
  SYNC_CONNECTION_UNLINK_MARKER
} from './sync-db'
import { openFileExplorerDB } from './file-explorer-db'
import { getBlobId } from './blob-identity'

const guards = new Map<string, SyncDownloadCommitGuard>()
const scopeFences = new Map<string, number>()

type PosterScope = [providerConnectionId: string, rootRemoteFolderId: string]

interface PosterOwnership {
  syncScope: PosterScope | null
  fenceScopes: PosterScope[]
  hhcScope: PosterScope | null
}

function scopeKey(providerConnectionId: string, rootRemoteFolderId?: string): string {
  return `${providerConnectionId}\0${rootRemoteFolderId ?? ''}`
}

export function fenceVideoPosterScope(
  providerConnectionId: string,
  rootRemoteFolderId?: string
): () => void {
  const key = scopeKey(providerConnectionId, rootRemoteFolderId)
  scopeFences.set(key, (scopeFences.get(key) ?? 0) + 1)
  return () => {
    const remaining = (scopeFences.get(key) ?? 1) - 1
    if (remaining === 0) scopeFences.delete(key)
    else scopeFences.set(key, remaining)
  }
}

async function isVideoPosterScopeFenced(scopes: PosterScope[]): Promise<boolean> {
  if (
    scopes.some(
      ([providerConnectionId, rootRemoteFolderId]) =>
        scopeFences.has(scopeKey(providerConnectionId)) ||
        scopeFences.has(scopeKey(providerConnectionId, rootRemoteFolderId))
    )
  ) {
    return true
  }
  const tombstones = await listSyncTombstones()
  return scopes.some(([providerConnectionId, rootRemoteFolderId]) =>
    tombstones.some(
      (record) =>
        record.providerConnectionId === providerConnectionId &&
        record.reason === 'unlink' &&
        (record.remoteItemId === rootRemoteFolderId ||
          record.remoteItemId === SYNC_CONNECTION_UNLINK_MARKER)
    )
  )
}

async function resolvePosterOwnership(job: MediaJobRecord): Promise<PosterOwnership> {
  const db = await openFileExplorerDB()
  const requestedItem = await db.get('folder-items', job.itemId!)
  const item =
    requestedItem?.type === 'file' || !job.sourceBlobId
      ? requestedItem
      : (await db.getAll('folder-items')).find(
          (candidate) => candidate.type === 'file' && getBlobId(candidate) === job.sourceBlobId
        )
  const entries = await listSyncEntriesByLocalItem(item?.id ?? job.itemId!)
  const entryScopes: PosterScope[] = entries.map((entry) => {
    if (!entry.parentRemoteItemId) throw new MediaJobBlockedError('authentication')
    return [entry.providerConnectionId, entry.parentRemoteItemId]
  })
  if (
    !item &&
    entryScopes.some(([providerConnectionId]) => !providerConnectionId.startsWith('hhc-line:'))
  ) {
    throw new MediaJobBlockedError('authentication')
  }

  const ancestryScopes: PosterScope[] = []
  let parentId: string | null = item?.parentId ?? null
  if (item) {
    const folders = new Map(
      (await db.getAll('folder-records')).map((folder) => [folder.id, folder])
    )
    const seen = new Set<string>()
    while (parentId !== 'file-root') {
      if (!parentId) throw new MediaJobBlockedError('authentication')
      const folder = folders.get(parentId)
      if (!folder || seen.has(folder.id)) throw new MediaJobBlockedError('authentication')
      if (folder.syncLink) {
        ancestryScopes.push([folder.syncLink.providerConnectionId, folder.syncLink.remoteFolderId])
      }
      seen.add(folder.id)
      parentId = folder.parentId
    }
  }

  const ancestryScope = ancestryScopes[0] ?? null
  const providers = new Set(entryScopes.map(([providerConnectionId]) => providerConnectionId))
  ancestryScopes.forEach(([providerConnectionId]) => providers.add(providerConnectionId))
  if (
    providers.size > 1 ||
    (!ancestryScope && parentId === 'file-root' && entryScopes.length > 0)
  ) {
    throw new MediaJobBlockedError('authentication')
  }
  const hhcEntryScopes = new Set(
    entryScopes
      .filter(([providerConnectionId]) => providerConnectionId.startsWith('hhc-line:'))
      .map(([providerConnectionId, rootRemoteFolderId]) =>
        scopeKey(providerConnectionId, rootRemoteFolderId)
      )
  )
  if (ancestryScope?.[0].startsWith('hhc-line:')) {
    hhcEntryScopes.add(scopeKey(...ancestryScope))
  }
  if (hhcEntryScopes.size > 1) throw new MediaJobBlockedError('authentication')

  const syncScope = ancestryScope ?? entryScopes[0] ?? null
  if (!item && !syncScope) throw new MediaJobBlockedError('authentication')
  return {
    syncScope,
    fenceScopes: ancestryScopes.length > 0 ? ancestryScopes : entryScopes,
    hhcScope: syncScope?.[0].startsWith('hhc-line:') ? syncScope : null
  }
}

async function assertPosterCommit(job: MediaJobRecord, ownership: PosterOwnership): Promise<void> {
  const guard = guards.get(job.sourceBlobId!)
  if ((await guard?.()) === false) throw new MediaJobBlockedError('authentication')
  if (await isVideoPosterScopeFenced(ownership.fenceScopes)) {
    throw new MediaJobBlockedError('authentication')
  }
  if (
    ownership.hhcScope &&
    !(await (await import('./hhc-line-access')).canCommitHhcLinePoster(...ownership.hhcScope))
  ) {
    throw new MediaJobBlockedError('authentication')
  }
}

export async function enqueueVideoPosterJob(input: {
  sourceBlobId: string
  itemId: string
  priority?: number
  canCommit?: SyncDownloadCommitGuard
}): Promise<void> {
  if (isWeb()) return
  const { sourceBlobId: blobId, canCommit: guard } = input
  const dedupeKey = `video-poster:${blobId}`
  if ((await guard?.()) === false) return
  const unlinkPending =
    scopeFences.size > 0 ||
    (await listSyncTombstones()).some((record) => record.reason === 'unlink')
  if (unlinkPending) {
    try {
      const ownership = await resolvePosterOwnership({ itemId: input.itemId } as MediaJobRecord)
      if (await isVideoPosterScopeFenced(ownership.fenceScopes)) return
    } catch (error) {
      if (error instanceof MediaJobBlockedError) return
      throw error
    }
  }
  if (guard) guards.set(blobId, guard)
  const job = await mediaJobQueue.enqueue({
    type: 'video-poster',
    sourceBlobId: blobId,
    itemId: input.itemId,
    priority: input.priority,
    dedupeKey
  })
  if (['failed', 'blocked', 'paused'].includes(job.status)) await mediaJobQueue.retry(job.id)
}

export function cancelVideoPosterJobsAndWait(itemIds: string[]): Promise<number> {
  const targets = new Set(itemIds)
  return mediaJobQueue.cancelAndWait(
    (job) => job.type === 'video-poster' && !!job.itemId && targets.has(job.itemId)
  )
}

mediaJobQueue.registerExecutor('video-poster', async (job) => {
  if (!job.sourceBlobId || !job.itemId) throw new Error('Video poster job is missing source')
  if (isWeb()) throw new MediaJobBlockedError('configuration', 'Video posters require Electron')
  const blobId = job.sourceBlobId
  try {
    const ownership = await resolvePosterOwnership(job)
    await assertPosterCommit(job, ownership)
    const info = await window.api.videoPoster.getInfo()
    if (info.status !== 'ready') {
      throw new MediaJobBlockedError('configuration', info.status)
    }

    const result = await window.api.videoPoster.generate({ sourceFileId: blobId })
    await assertPosterCommit(job, ownership)
    await saveThumbnail(blobId, result.dataUrl)
    await assertPosterCommit(job, ownership)
    notifyThumbnailReady(job.itemId, blobId)
  } finally {
    guards.delete(blobId)
  }
})
