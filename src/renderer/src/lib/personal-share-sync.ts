import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import type { SharedFolderRoot } from '@shared/personal-cloud'
import type { HhcLineCloudAuth } from './cloud-provider'
import { createPersonalCloudProvider } from './personal-cloud-provider'
import {
  PersonalShareProvider,
  personalShareConnectionId,
  personalShareRemoteId
} from './personal-share-provider'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { useSettingsStore } from '@renderer/stores/settings'
import { isElectron } from './env'
import { collectAvailableFileBlobIds, openFileExplorerDB } from './file-explorer-db'
import {
  getSyncCursor,
  getProviderConnection,
  getSyncEntryByLocalItem,
  deletePendingShareLeave,
  listPendingShareLeaves,
  listSyncEntriesByProviderConnection,
  putPendingShareLeave,
  putSyncCursor,
  putSyncEntry
} from './sync-db'
import { applySyncRefreshPlan, buildSyncRefreshPlan, collectSyncChangePages } from './sync-refresh'
import { dispatchPlannedSyncDownloads } from './sync-transfer-dispatch'
import { refreshImportedMediaAssets } from './local-sync-import'
import { unlinkSyncRootFolderFromApp } from './sync-unlink'
import { getBlobId } from './blob-identity'
import { enqueueSyncDownload } from './sync-download-queue'

export function personalShareContainerId(recipientId: string): string {
  return `hhc-share-root:${recipientId}`
}

function localRootId(recipientId: string, grantId: string): string {
  return `hhc-share-folder:${recipientId}:${grantId}`
}

function publish(folder: FolderRecord): void {
  useFileExplorerStore.setState((state) => {
    const folders = { ...state.folders, [folder.id]: folder }
    const parent = folder.parentId ?? ''
    const previousParent = state.folders[folder.id]?.parentId ?? ''
    const siblings = [
      ...(state._childFoldersByParent[parent] ?? []).filter((item) => item.id !== folder.id),
      folder
    ].sort((a, b) => a.sortIndex - b.sortIndex)
    const childFoldersByParent = { ...state._childFoldersByParent, [parent]: siblings }
    if (previousParent !== parent) {
      childFoldersByParent[previousParent] = (childFoldersByParent[previousParent] ?? []).filter(
        (item) => item.id !== folder.id
      )
    }
    return {
      folders,
      _foldersArray: Object.values(folders),
      _childFoldersByParent: childFoldersByParent
    }
  })
}

function requireSession(
  auth: HhcLineCloudAuth
): NonNullable<ReturnType<HhcLineCloudAuth['getSession']>> {
  const session = auth.getSession()
  if (!session) {
    throw Object.assign(new Error('HHC account authentication required'), {
      classification: 'auth-required'
    })
  }
  return session
}

export async function createPersonalShareProvider(
  auth: HhcLineCloudAuth,
  recipientId: string
): Promise<PersonalShareProvider> {
  const cloud = createPersonalCloudProvider(auth, recipientId)
  return new PersonalShareProvider({
    api: {
      listSharedFolders: cloud.listSharedFolders,
      getSharedFolderSnapshot: cloud.getSharedFolderSnapshot,
      downloadSharedContent: (grantId, itemId, signal, targetBlobId) => {
        if (!targetBlobId) throw new Error('Shared download target is required')
        return cloud.downloadSharedSnapshot(grantId, itemId, targetBlobId, signal)
      }
    },
    getSession: () => (auth.getSession()?.userId === recipientId ? auth.getSession() : null)
  })
}

async function importOrRefresh(
  auth: HhcLineCloudAuth,
  recipientId: string,
  shared: SharedFolderRoot,
  index: number
): Promise<Set<string>> {
  const connectionId = personalShareConnectionId(recipientId)
  const rootRemoteFolderId = personalShareRemoteId(shared.grantId, shared.root.id)
  const rootId = localRootId(recipientId, shared.grantId)
  const db = await openFileExplorerDB()
  const current = useFileExplorerStore.getState()
  const existing = current.folders[rootId]
  const offlinePolicy = useSettingsStore.getState().defaultSyncOfflinePolicy
  const root: FolderRecord = {
    ...(existing ?? { id: rootId, createdAt: Date.now(), expiresAt: null }),
    name: shared.root.name,
    parentId: personalShareContainerId(recipientId),
    sortIndex: index,
    sharedRecipientId: recipientId,
    syncLink: {
      providerConnectionId: connectionId,
      providerType: 'hhc-share',
      remoteFolderId: rootRemoteFolderId,
      offlinePolicy,
      status: 'active'
    }
  }
  const provider = await createPersonalShareProvider(auth, recipientId)
  await provider.connect()
  const cursor = await getSyncCursor(connectionId, rootRemoteFolderId)
  const scan = await collectSyncChangePages(
    provider,
    connectionId,
    rootRemoteFolderId,
    cursor?.cursor
  )
  if (auth.getSession()?.userId !== recipientId) throw new Error('HHC account changed')
  const [folders, items, entries, blobs] = await Promise.all([
    db.getAll('folder-records'),
    db.getAll('folder-items'),
    listSyncEntriesByProviderConnection(connectionId),
    db.getAll('file-blobs')
  ])
  const rootEntries = entries.filter((entry) => entry.remoteItemId.startsWith(`${shared.grantId}:`))
  const plan = buildSyncRefreshPlan({
    providerConnectionId: connectionId,
    providerType: 'hhc-share',
    rootFolder: root,
    rootRemoteFolderId,
    offlinePolicy,
    platform: isElectron() ? 'electron' : 'web',
    existingFolders: folders,
    existingItems: items.filter((item): item is FileItemRecord => item.type === 'file'),
    existingEntries: rootEntries,
    existingBlobIds: await collectAvailableFileBlobIds(blobs),
    remoteItems: scan.remoteItems
  })
  plan.folders = plan.folders.map((folder) => ({ ...folder, sharedRecipientId: recipientId }))
  plan.items = plan.items.map((item) => ({ ...item, sharedRecipientId: recipientId }))
  await putSyncEntry({
    providerConnectionId: connectionId,
    remoteItemId: rootRemoteFolderId,
    parentRemoteItemId: null,
    kind: 'folder',
    name: shared.root.name,
    folderId: root.id,
    status: 'remote-only'
  })
  await applySyncRefreshPlan(plan)
  if (scan.nextCursor) {
    await putSyncCursor({
      providerConnectionId: connectionId,
      remoteFolderId: rootRemoteFolderId,
      cursor: scan.nextCursor,
      updatedAt: Date.now()
    })
  }
  await db.put('folder-records', root)
  publish(root)
  dispatchPlannedSyncDownloads({
    provider,
    providerConnectionId: connectionId,
    rootRemoteFolderId,
    offlinePolicy,
    plan,
    remoteItems: scan.remoteItems,
    existingEntries: rootEntries,
    canCommit: () => auth.getSession()?.userId === recipientId,
    onDownloaded: (item, canCommit) => refreshImportedMediaAssets([item], canCommit)
  })
  return new Set(
    scan.remoteItems.map((item) => item.remoteItemId.slice(item.remoteItemId.indexOf(':') + 1))
  )
}

async function suppressCoveredRoot(folder: FolderRecord): Promise<void> {
  const hidden = { ...folder, parentId: null }
  await (await openFileExplorerDB()).put('folder-records', hidden)
  useFileExplorerStore.setState((state) => {
    const folders = { ...state.folders, [hidden.id]: hidden }
    const parent = folder.parentId ?? ''
    return {
      folders,
      _foldersArray: Object.values(folders),
      _childFoldersByParent: {
        ...state._childFoldersByParent,
        [parent]: (state._childFoldersByParent[parent] ?? []).filter(
          (item) => item.id !== folder.id
        )
      }
    }
  })
}

export async function reconcilePersonalShares(auth: HhcLineCloudAuth): Promise<string> {
  const recipientId = requireSession(auth).userId
  const cloud = createPersonalCloudProvider(auth, recipientId)
  for (const pending of await listPendingShareLeaves(recipientId)) {
    await cloud.leaveSharedFolder(pending.grantId)
    await deletePendingShareLeave(recipientId, pending.grantId)
  }
  const roots = await cloud.listSharedFolders()
  if (auth.getSession()?.userId !== recipientId) throw new Error('HHC account changed')
  await useFileExplorerStore.getState().initialize()
  const containerId = personalShareContainerId(recipientId)
  const db = await openFileExplorerDB()
  const container: FolderRecord = useFileExplorerStore.getState().folders[containerId] ?? {
    id: containerId,
    name: '與我分享',
    parentId: null,
    sortIndex: 0,
    createdAt: Date.now(),
    expiresAt: null,
    sharedRecipientId: recipientId
  }
  await db.put('folder-records', container)
  publish(container)
  const active = new Set(roots.map((root) => localRootId(recipientId, root.grantId)))
  const stale = Object.values(useFileExplorerStore.getState().folders).filter(
    (folder) =>
      folder.sharedRecipientId === recipientId &&
      folder.id.startsWith(`hhc-share-folder:${recipientId}:`) &&
      folder.syncLink?.providerType === 'hhc-share' &&
      !active.has(folder.id)
  )
  const reachable = new Set<string>()
  for (const [index, root] of roots.entries()) {
    for (const itemId of await importOrRefresh(auth, recipientId, root, index)) {
      reachable.add(itemId)
    }
  }
  for (const folder of stale) {
    const remoteRootId = folder.syncLink!.remoteFolderId
    const itemId = remoteRootId.slice(remoteRootId.indexOf(':') + 1)
    if (reachable.has(itemId)) await suppressCoveredRoot(folder)
    else await unlinkSyncRootFolderFromApp(folder)
  }
  return containerId
}

export async function leavePersonalShare(
  auth: HhcLineCloudAuth,
  folder: FolderRecord
): Promise<void> {
  const recipientId = requireSession(auth).userId
  if (folder.sharedRecipientId !== recipientId || folder.syncLink?.providerType !== 'hhc-share') {
    throw new Error('Shared folder is unavailable')
  }
  const grantId = folder.syncLink.remoteFolderId.split(':', 1)[0]
  try {
    await createPersonalCloudProvider(auth, recipientId).leaveSharedFolder(grantId)
  } catch (error) {
    if (
      !(error instanceof TypeError) &&
      !(error && typeof error === 'object' && 'status' in error && error.status === 0)
    )
      throw error
    await putPendingShareLeave(recipientId, grantId)
  }
  await unlinkSyncRootFolderFromApp(folder)
}

export async function ensurePersonalShareItemAvailableForPresentation(
  auth: HhcLineCloudAuth,
  item: FileItemRecord
): Promise<boolean | null> {
  const entry = await getSyncEntryByLocalItem(item.id)
  if (!entry) return null
  const connection = await getProviderConnection(entry.providerConnectionId)
  if (connection?.providerType !== 'hhc-share') return null
  if (entry.status === 'available-offline') return true
  const recipientId = requireSession(auth).userId
  if (connection.accountUserId !== recipientId || !entry.parentRemoteItemId) return false
  const provider = await createPersonalShareProvider(auth, recipientId)
  const result = await enqueueSyncDownload({
    provider,
    request: {
      providerConnectionId: connection.id,
      rootRemoteFolderId: entry.parentRemoteItemId,
      remoteItemId: entry.remoteItemId,
      targetBlobId: getBlobId(item),
      offlinePolicy: 'on-demand'
    },
    entry: {
      providerConnectionId: connection.id,
      remoteItemId: entry.remoteItemId,
      parentRemoteItemId: entry.parentRemoteItemId,
      kind: 'file',
      name: entry.name,
      itemId: item.id,
      mimeType: entry.mimeType,
      size: entry.size,
      etag: entry.etag,
      contentHash: entry.contentHash
    },
    previousEntry: entry,
    priority: 'presentation',
    canCommit: () => auth.getSession()?.userId === recipientId,
    onDownloaded: (_result, canCommit) => refreshImportedMediaAssets([item], canCommit)
  })
  return Boolean(result)
}
