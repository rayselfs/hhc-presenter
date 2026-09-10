import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import type { PersonalChangePage, PersonalRemoteNode } from '@shared/personal-cloud'
import type { PersonalCloudProvider } from './personal-cloud-provider'
import {
  openFileExplorerDB,
  isFileBlobRecordAvailable,
  type FileBlobRecord
} from './file-explorer-db'
import { assertPersonalSyncLease, type PersonalSyncNode } from './personal-sync-db'
import { createResourceCleanupRecord } from './resource-cleanup-journal'
import { getBlobId } from './blob-identity'
import { isElectron } from './env'
import { refreshImportedMediaAssets } from './local-sync-import'
import { usePersonalSyncStore } from '../stores/personal-sync'

type Download = FileBlobRecord & { mimeType: string; cleanupId?: string }

export function personalLocalNodeId(collectionId: string, remoteId: string): string {
  return `personal:${collectionId}:${remoteId}`
}

export async function pullPersonalChanges(
  ownerId: string,
  workerId: string,
  api: PersonalCloudProvider,
  signal: AbortSignal
): Promise<boolean> {
  const db = await openFileExplorerDB()
  const state = await db.get('personal-sync-state', ownerId)
  if (!state) throw new Error('Personal owner is missing')
  assertPersonalSyncLease(state, workerId)
  signal.throwIfAborted()
  const page = await api.getChanges(state.cursor, signal)
  if (page.collection.id !== state.collectionId) throw new Error('Personal collection changed')
  const latest = new Map<string, PersonalRemoteNode>()
  for (const node of page.items) {
    if ((latest.get(node.id)?.revision ?? -1) < node.revision) latest.set(node.id, node)
  }
  const nodes = await db.getAllFromIndex('personal-sync-nodes', 'by-owner', ownerId)
  const local = new Map(nodes.map((node) => [node.remoteId, node]))
  const downloads = new Map<string, Download>()
  const pending: PersonalRemoteNode[] = []
  for (const remote of latest.values()) {
    const node = local.get(remote.id)
    if (
      remote.kind !== 'file' ||
      remote.deletedAt ||
      (node &&
        (node.localRevision !== node.syncedLocalRevision || node.remoteRevision > remote.revision))
    )
      continue
    const item = node ? await db.get('folder-items', node.id) : undefined
    const blob = item?.type === 'file' ? await db.get('file-blobs', getBlobId(item)) : undefined
    // An acknowledged revision already has the exact local bytes, even before its asset ID is pulled.
    if (
      !blob ||
      (node?.remoteAssetId !== remote.assetId && node?.remoteRevision !== remote.revision) ||
      !(await isFileBlobRecordAvailable(blob))
    )
      pending.push(remote)
  }
  const stage = async (index: number): Promise<void> => {
    signal.throwIfAborted()
    const remote = pending[index]
    if (!remote) {
      await commitPersonalChangePage(ownerId, workerId, state.cursor, page, downloads, signal)
      return
    }
    const blobId = crypto.randomUUID()
    if (!isElectron()) {
      downloads.set(
        remote.id,
        await api.downloadSnapshot(remote.id, remote.revision, blobId, signal)
      )
      await stage(index + 1)
      return
    }
    const stagingLock = `personal-blob:${blobId}`
    await navigator.locks.request(stagingLock, { signal }, async () => {
      const cleanup = createResourceCleanupRecord({
        blobId,
        storage: 'native-fs',
        deleteNativeFile: true,
        deleteDerivedAssets: false,
        deletePdfPageThumbs: false,
        itemThumbnailIds: [],
        stagingLock
      })
      await db.add('resource-cleanup-journal', cleanup)
      const snapshot = await api.downloadSnapshot(remote.id, remote.revision, blobId, signal)
      downloads.set(remote.id, { ...snapshot, cleanupId: cleanup.id })
      // Keep every native staging lock until the entire page and cursor commit together.
      await stage(index + 1)
    })
  }
  await stage(0)
  for (const remote of pending) {
    const download = downloads.get(remote.id)
    if (!download) continue
    const id = personalLocalNodeId(state.collectionId, remote.id)
    const item = await db.get('folder-items', id)
    if (item?.type !== 'file' || item.url !== `blob:${download.id}`) continue
    void refreshImportedMediaAssets([item], async () => {
      if (usePersonalSyncStore.getState().activeOwnerId !== ownerId) return false
      const currentDb = await openFileExplorerDB()
      const [currentState, currentNode, currentItem] = await Promise.all([
        currentDb.get('personal-sync-state', ownerId),
        currentDb.get('personal-sync-nodes', id),
        currentDb.get('folder-items', id)
      ])
      return Boolean(
        currentState?.collectionId === page.collection.id &&
        currentNode?.ownerId === ownerId &&
        currentNode.remoteId === remote.id &&
        currentNode.remoteRevision === remote.revision &&
        currentNode.remoteAssetId === remote.assetId &&
        currentItem?.type === 'file' &&
        currentItem.personalOwnerId === ownerId &&
        currentItem.url === `blob:${download.id}`
      )
    })
  }
  return page.hasMore
}

export async function commitPersonalChangePage(
  ownerId: string,
  workerId: string,
  expectedCursor: string | undefined,
  page: PersonalChangePage,
  downloads: ReadonlyMap<string, Download>,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const db = await openFileExplorerDB()
  const tx = db.transaction(
    [
      'personal-sync-state',
      'personal-sync-nodes',
      'personal-sync-outbox',
      'folder-records',
      'folder-items',
      'file-blobs',
      'resource-cleanup-journal'
    ],
    'readwrite'
  )
  try {
    const states = tx.objectStore('personal-sync-state')
    const state = await states.get(ownerId)
    if (!state || state.collectionId !== page.collection.id || state.cursor !== expectedCursor) {
      throw new Error('Personal page cursor or owner changed')
    }
    assertPersonalSyncLease(state, workerId)
    const nodes = tx.objectStore('personal-sync-nodes')
    const existing = await nodes.index('by-owner').getAll(ownerId)
    const byRemote = new Map(existing.map((node) => [node.remoteId, node]))
    const latest = new Map<string, PersonalRemoteNode>()
    for (const remote of page.items) {
      if ((latest.get(remote.id)?.revision ?? -1) < remote.revision) latest.set(remote.id, remote)
    }
    let revision = state.pullRevision ?? state.collectionRevision
    for (const remote of latest.values()) {
      signal.throwIfAborted()
      revision = Math.max(revision, remote.revision)
      const previous = byRemote.get(remote.id)
      if (remote.purged) {
        if (!previous) continue
        const items = tx.objectStore('folder-items')
        const item = await items.get(previous.id)
        const blobs = tx.objectStore('file-blobs')
        if (item?.type === 'file') {
          const blob = await blobs.get(getBlobId(item))
          if (blob) await blobs.put({ ...blob, refCount: Math.max(0, (blob.refCount ?? 1) - 1) })
        }
        const outbox = tx.objectStore('personal-sync-outbox')
        for (const operation of await outbox.index('by-owner').getAll(ownerId)) {
          if (operation.nodeId !== previous.id) continue
          if (operation.snapshotBlobId) {
            const snapshot = await blobs.get(operation.snapshotBlobId)
            if (snapshot)
              await blobs.put({
                ...snapshot,
                refCount: Math.max(0, (snapshot.refCount ?? 1) - 1)
              })
          }
          await outbox.delete(operation.id)
        }
        await items.delete(previous.id)
        await tx.objectStore('folder-records').delete(previous.id)
        await nodes.delete(previous.id)
        byRemote.delete(remote.id)
        continue
      }
      if (
        !previous &&
        remote.deletedAt &&
        Date.parse(remote.deletedAt) <= Date.now() - 30 * 86_400_000
      )
        continue
      if (previous && previous.remoteRevision > remote.revision) continue
      if (previous && previous.localRevision !== previous.syncedLocalRevision) {
        await nodes.put({ ...previous, remoteHead: remote })
        continue
      }
      const id = previous?.id ?? personalLocalNodeId(state.collectionId, remote.id)
      const parentId = remote.parentId
        ? (byRemote.get(remote.parentId)?.id ??
          personalLocalNodeId(state.collectionId, remote.parentId))
        : state.rootId
      const oldFolder =
        remote.kind === 'folder' ? await tx.objectStore('folder-records').get(id) : undefined
      const oldItem =
        remote.kind === 'file' ? await tx.objectStore('folder-items').get(id) : undefined
      if (
        (oldFolder && oldFolder.personalOwnerId !== ownerId) ||
        (oldItem && oldItem.personalOwnerId !== ownerId)
      )
        throw new Error('Personal catalog ownership changed')
      const base: FolderRecord = {
        id,
        personalOwnerId: ownerId,
        name: remote.name,
        parentId,
        sortIndex: oldFolder?.sortIndex ?? oldItem?.sortIndex ?? 0,
        createdAt: oldFolder?.createdAt ?? oldItem?.createdAt ?? Date.now(),
        expiresAt: null,
        ...(remote.deletedAt
          ? { deletedAt: Date.parse(remote.deletedAt), originalParentId: parentId }
          : {})
      }
      if (remote.kind === 'folder') {
        await tx.objectStore('folder-records').put({ ...base, isFavorited: oldFolder?.isFavorited })
      } else {
        const oldFile = oldItem?.type === 'file' ? oldItem : undefined
        const download = downloads.get(remote.id)
        if (!download && !oldFile && !remote.deletedAt)
          throw new Error('Personal download is missing')
        if (download) {
          const { cleanupId, mimeType: _mimeType, ...blob } = download
          await tx.objectStore('file-blobs').add({ ...blob, refCount: 1 })
          if (cleanupId) await tx.objectStore('resource-cleanup-journal').delete(cleanupId)
          if (oldFile) {
            const oldBlob = await tx.objectStore('file-blobs').get(getBlobId(oldFile))
            if (oldBlob)
              await tx
                .objectStore('file-blobs')
                .put({ ...oldBlob, refCount: Math.max(0, (oldBlob.refCount ?? 1) - 1) })
          }
        }
        const file: FileItemRecord = {
          ...base,
          parentId,
          type: 'file',
          notes: oldFile?.notes,
          url: download ? `blob:${download.id}` : (oldFile?.url ?? `blob:${crypto.randomUUID()}`),
          size: download?.size ?? oldFile?.size ?? 0,
          mimeType: download?.mimeType ?? oldFile?.mimeType ?? 'application/octet-stream'
        }
        await tx.objectStore('folder-items').put(file)
      }
      const node: PersonalSyncNode = {
        id,
        ownerId,
        remoteId: remote.id,
        kind: remote.kind,
        localRevision: previous?.localRevision ?? 0,
        syncedLocalRevision: previous?.syncedLocalRevision ?? 0,
        remoteRevision: remote.revision,
        remoteAssetId: remote.assetId,
        deletionGroup: remote.deletedAt ? String(remote.revision) : undefined
      }
      await nodes.put(node)
      byRemote.set(remote.id, node)
    }
    await states.put({
      ...state,
      cursor: page.nextCursor,
      collectionRevision: page.hasMore
        ? state.collectionRevision
        : Math.max(state.collectionRevision, revision),
      pullRevision: page.hasMore ? revision : undefined
    })
    signal.throwIfAborted()
    assertPersonalSyncLease(state, workerId)
    await tx.done
  } catch (error) {
    try {
      tx.abort()
    } catch {
      /* Already aborted. */
    }
    await tx.done.catch(() => undefined)
    throw error
  }
}
