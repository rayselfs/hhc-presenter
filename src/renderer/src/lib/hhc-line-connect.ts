import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import type { HhcSession } from '@shared/hhc-auth'
import {
  FILE_EXPLORER_ROOT_ID,
  useFileExplorerStore,
  publishPersistedSyncRoot
} from '@renderer/stores/file-explorer'
import { useSettingsStore } from '@renderer/stores/settings'
import { resolveUniqueName } from './file-naming'
import { createHhcAssetApi } from './hhc-asset-api'
import { HhcLineReadonlyProvider } from './hhc-line-provider'
import { isElectron } from './env'
import { collectAvailableFileBlobIds, openFileExplorerDB } from './file-explorer-db'
import type {
  CloudImportResult,
  CloudRefreshSummary,
  CloudRemoteFolder,
  HhcLineCloudAuth
} from './cloud-provider'
import { getBlobId } from './blob-identity'
import { enqueueSyncDownload } from './sync-download-queue'
import type { SyncRemoteContentSource } from './sync-provider'
import {
  createHhcLineProviderConnectionId,
  getProviderConnection,
  getSyncEntryByLocalItem,
  getSyncEntryByRemoteItem,
  getSyncCursor,
  listSyncEntriesByProviderConnection,
  putSyncCursor,
  putSyncEntry,
  type ProviderConnectionRecord,
  type SyncEntryRecord
} from './sync-db'
import { refreshImportedMediaAssets } from './local-sync-import'
import {
  applySyncRefreshPlan,
  buildSyncDeltaRefreshPlan,
  buildSyncRefreshPlan,
  collectSyncChangePages
} from './sync-refresh'
import { unlinkSyncRootFolderFromApp } from './sync-unlink'
import { handleHhcLineAccessError, isHhcLineRootAuthorized } from './hhc-line-access'
import { dispatchPlannedSyncDownloads } from './sync-transfer-dispatch'

const importsInFlight = new Map<string, Promise<CloudImportResult>>()
const importQueueTails = new Map<string, Promise<void>>()
const refreshesInFlight = new Map<string, Promise<CloudRefreshSummary>>()
const MAX_COLLECTION_PAGES = 1_000

export interface HhcLinePresentationSource {
  providerConnectionId: string
  remoteItemId: string
  rootRemoteFolderId: string
  source: SyncRemoteContentSource
}

function requireSession(auth: HhcLineCloudAuth): HhcSession {
  const session = auth.getSession()
  if (!session) {
    throw Object.assign(new Error('HHC account authentication required'), {
      classification: 'auth-required'
    })
  }
  return session
}

function assertCurrentAccount(auth: HhcLineCloudAuth, expectedUserId: string): void {
  if (auth.getSession()?.userId !== expectedUserId) {
    throw Object.assign(new Error('HHC account changed'), { classification: 'auth-required' })
  }
}

function rootFolderId(connectionId: string, collectionId: string): string {
  return `${connectionId}:collection:${collectionId}`
}

function importedCollectionIds(connectionId: string): Set<string> {
  return new Set(
    Object.values(useFileExplorerStore.getState().folders)
      .filter(
        (folder) =>
          folder.syncLink?.providerType === 'hhc-line' &&
          folder.syncLink.providerConnectionId === connectionId
      )
      .map((folder) => folder.syncLink!.remoteFolderId)
  )
}

function collectionEntries(entries: SyncEntryRecord[], collectionId: string): SyncEntryRecord[] {
  return entries.filter(
    (entry) => entry.remoteItemId === collectionId || entry.parentRemoteItemId === collectionId
  )
}

async function createProvider(
  auth: HhcLineCloudAuth,
  expectedUserId?: string
): Promise<HhcLineReadonlyProvider> {
  return new HhcLineReadonlyProvider({
    api: await createHhcAssetApi(auth),
    getSession: async () => {
      const session = auth.getSession()
      return !expectedUserId || session?.userId === expectedUserId ? session : null
    },
    getAuthGeneration: auth.getAuthGeneration,
    onAccessError: (scope, error, requestAuth) =>
      handleHhcLineAccessError(auth, { kind: 'root', ...scope }, error, requestAuth)
  })
}

async function getHhcPresentationEntry(item: FileItemRecord): Promise<{
  connection: ProviderConnectionRecord
  entry: SyncEntryRecord
} | null> {
  const entry = await getSyncEntryByLocalItem(item.id)
  if (!entry) return null
  const connection = await getProviderConnection(entry.providerConnectionId)
  if (connection?.providerType !== 'hhc-line' || !entry.parentRemoteItemId) {
    return null
  }
  return { connection, entry }
}

export async function prepareHhcLinePresentationSource(
  auth: HhcLineCloudAuth,
  item: FileItemRecord
): Promise<HhcLinePresentationSource | null> {
  const found = await getHhcPresentationEntry(item)
  if (!found || found.entry.status === 'available-offline') return null
  const session = requireSession(auth)
  if (found.connection.accountUserId !== session.userId) {
    throw Object.assign(new Error('HHC account changed'), {
      classification: 'auth-required',
      providerConnectionId: found.entry.providerConnectionId,
      remoteItemId: found.entry.remoteItemId
    })
  }
  assertCurrentAccount(auth, session.userId)
  try {
    const provider = await createProvider(auth, session.userId)
    const source = await provider.getRemoteContentSource(
      found.entry.providerConnectionId,
      found.entry.remoteItemId
    )
    try {
      assertCurrentAccount(auth, session.userId)
    } catch (error) {
      if (source.kind === 'native-lease') {
        const release = window.api?.hhcAssets?.releaseContentLease
        if (release) {
          await release(source.leaseId).catch(() => release(source.leaseId).catch(() => undefined))
        }
      }
      throw error
    }
    return {
      providerConnectionId: found.entry.providerConnectionId,
      remoteItemId: found.entry.remoteItemId,
      rootRemoteFolderId: found.entry.parentRemoteItemId!,
      source
    }
  } catch (error) {
    if (error && typeof error === 'object') {
      Object.assign(error, {
        providerConnectionId: found.entry.providerConnectionId,
        remoteItemId: found.entry.remoteItemId
      })
    }
    throw error
  }
}

export async function ensureHhcLineDesktopItemAvailableForPresentation(
  auth: HhcLineCloudAuth,
  item: FileItemRecord
): Promise<boolean | null> {
  const found = await getHhcPresentationEntry(item)
  if (!found) return null
  if (found.entry.status === 'available-offline') return true
  const authGeneration = auth.getAuthGeneration?.() ?? 0
  const session = requireSession(auth)
  if (found.connection.accountUserId !== session.userId) {
    throw Object.assign(new Error('HHC account changed'), {
      classification: 'auth-required',
      providerConnectionId: found.entry.providerConnectionId,
      remoteItemId: found.entry.remoteItemId
    })
  }
  assertCurrentAccount(auth, session.userId)
  const provider = await createProvider(auth, session.userId)
  const result = await enqueueSyncDownload({
    provider,
    request: {
      providerConnectionId: found.entry.providerConnectionId,
      rootRemoteFolderId: found.entry.parentRemoteItemId!,
      remoteItemId: found.entry.remoteItemId,
      targetBlobId: getBlobId(item),
      offlinePolicy: 'on-demand'
    },
    entry: {
      providerConnectionId: found.entry.providerConnectionId,
      remoteItemId: found.entry.remoteItemId,
      parentRemoteItemId: found.entry.parentRemoteItemId,
      kind: 'file',
      name: found.entry.name,
      itemId: item.id,
      mimeType: found.entry.mimeType,
      size: found.entry.size,
      etag: found.entry.etag,
      contentHash: found.entry.contentHash
    },
    previousEntry: found.entry,
    priority: 'presentation',
    canCommit: () =>
      isHhcLineRootAuthorized(
        auth,
        found.entry.providerConnectionId,
        found.entry.parentRemoteItemId!
      ),
    onFailed: (error) =>
      handleHhcLineAccessError(
        auth,
        {
          kind: 'root',
          providerConnectionId: found.entry.providerConnectionId,
          rootRemoteFolderId: found.entry.parentRemoteItemId!,
          remoteItemId: found.entry.remoteItemId
        },
        error,
        { accountUserId: session.userId, authGeneration }
      ),
    onDownloaded: (_result, canCommit) => refreshImportedMediaAssets([item], canCommit)
  })
  assertCurrentAccount(auth, session.userId)
  if (!result) {
    const failed = await getSyncEntryByRemoteItem(
      found.entry.providerConnectionId,
      found.entry.remoteItemId
    )
    if (failed?.errorKind === 'access-revoked') {
      throw Object.assign(new Error('HHC Asset access revoked'), {
        classification: 'access-revoked',
        status: 403,
        providerConnectionId: found.entry.providerConnectionId,
        remoteItemId: found.entry.remoteItemId
      })
    }
  }
  return result !== null
}

export async function getConnectedHhcLineAccount(
  auth: HhcLineCloudAuth
): Promise<ProviderConnectionRecord | null> {
  const session = auth.getSession()
  if (!session) return null
  const connection = await getProviderConnection(createHhcLineProviderConnectionId(session.userId))
  assertCurrentAccount(auth, session.userId)
  return connection ?? null
}

export async function listHhcLineCollections(auth: HhcLineCloudAuth): Promise<CloudRemoteFolder[]> {
  const authGeneration = auth.getAuthGeneration?.() ?? 0
  const session = requireSession(auth)
  try {
    const api = await createHhcAssetApi(auth)
    const collections: CloudRemoteFolder[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    let hasMore = true
    let pageCount = 0

    while (hasMore) {
      const page = await api.listCollections(cursor)
      pageCount += 1
      assertCurrentAccount(auth, session.userId)
      for (const collection of page.collections) {
        if (!collection.deletedAt) {
          collections.push({
            remoteItemId: collection.id,
            name: collection.name,
            parentRemoteItemId: null
          })
        }
      }
      hasMore = page.hasMore
      if (!hasMore) continue
      if (pageCount >= MAX_COLLECTION_PAGES || !page.cursor || seenCursors.has(page.cursor)) {
        throw new Error('Invalid HHC collection pagination')
      }
      seenCursors.add(page.cursor)
      cursor = page.cursor
    }

    await useFileExplorerStore.getState().initialize()
    assertCurrentAccount(auth, session.userId)
    const imported = importedCollectionIds(createHhcLineProviderConnectionId(session.userId))
    return collections.filter((collection) => !imported.has(collection.remoteItemId))
  } catch (error) {
    await handleHhcLineAccessError(
      auth,
      { kind: 'account', accountUserId: session.userId },
      error,
      { accountUserId: session.userId, authGeneration }
    )
    throw error
  }
}

export function importHhcLineCollection(
  auth: HhcLineCloudAuth,
  collection: CloudRemoteFolder
): Promise<CloudImportResult> {
  const session = requireSession(auth)
  const connectionId = createHhcLineProviderConnectionId(session.userId)
  const key = `${connectionId}\u0000${collection.remoteItemId}`
  const existing = importsInFlight.get(key)
  if (existing) return existing

  const previous = importQueueTails.get(connectionId) ?? Promise.resolve()
  const pending = previous
    .catch(() => undefined)
    .then(() => runImport(auth, session.userId, connectionId, collection))
  const tail = pending.then(
    () => undefined,
    () => undefined
  )
  importsInFlight.set(key, pending)
  importQueueTails.set(connectionId, tail)
  void pending.then(
    () => {
      if (importsInFlight.get(key) === pending) importsInFlight.delete(key)
    },
    () => {
      if (importsInFlight.get(key) === pending) importsInFlight.delete(key)
    }
  )
  void tail.then(() => {
    if (importQueueTails.get(connectionId) === tail) importQueueTails.delete(connectionId)
  })
  return pending
}

async function runImport(
  auth: HhcLineCloudAuth,
  expectedUserId: string,
  connectionId: string,
  collection: CloudRemoteFolder
): Promise<CloudImportResult> {
  const authGeneration = auth.getAuthGeneration?.() ?? 0
  const offlinePolicy = useSettingsStore.getState().defaultSyncOfflinePolicy
  const store = useFileExplorerStore.getState()
  await store.initialize()
  assertCurrentAccount(auth, expectedUserId)
  const existing = Object.values(useFileExplorerStore.getState().folders).find(
    (folder) =>
      folder.syncLink?.providerConnectionId === connectionId &&
      folder.syncLink.remoteFolderId === collection.remoteItemId
  )
  const existingCursor = existing
    ? await getSyncCursor(connectionId, collection.remoteItemId)
    : undefined
  assertCurrentAccount(auth, expectedUserId)
  if (existing && existingCursor) {
    return {
      connectionId,
      displayName: existing.name,
      folderCount: 1,
      itemCount: 0,
      downloadedCount: 0,
      disabledCount: 0
    }
  }

  const provider = await createProvider(auth, expectedUserId)
  assertCurrentAccount(auth, expectedUserId)
  await provider.connect()
  assertCurrentAccount(auth, expectedUserId)
  const scan = await collectSyncChangePages(provider, connectionId, collection.remoteItemId)
  assertCurrentAccount(auth, expectedUserId)

  const current = useFileExplorerStore.getState()
  const roots = current.getChildFolders(FILE_EXPLORER_ROOT_ID)
  const now = Date.now()
  const root: FolderRecord = existing
    ? { ...existing, syncLink: { ...existing.syncLink!, offlinePolicy } }
    : {
        id: rootFolderId(connectionId, collection.remoteItemId),
        name: resolveUniqueName(
          collection.name,
          roots.map((folder) => folder.name)
        ),
        parentId: FILE_EXPLORER_ROOT_ID,
        sortIndex: roots.length,
        createdAt: now,
        expiresAt: null,
        syncLink: {
          providerConnectionId: connectionId,
          providerType: 'hhc-line',
          remoteFolderId: collection.remoteItemId,
          offlinePolicy,
          status: 'active'
        }
      }
  const db = await openFileExplorerDB()
  const [entries, fileBlobs] = await Promise.all([
    listSyncEntriesByProviderConnection(connectionId),
    db.getAll('file-blobs')
  ])
  const existingBlobIds = await collectAvailableFileBlobIds(fileBlobs)
  assertCurrentAccount(auth, expectedUserId)
  const plan = buildSyncRefreshPlan({
    providerConnectionId: connectionId,
    providerType: 'hhc-line',
    rootFolder: root,
    rootRemoteFolderId: collection.remoteItemId,
    offlinePolicy,
    platform: isElectron() ? 'electron' : 'web',
    existingFolders: Object.values(current.folders),
    existingItems: Object.values(current.items).filter(
      (item): item is FileItemRecord => item.type === 'file'
    ),
    existingEntries: collectionEntries(entries, collection.remoteItemId),
    existingBlobIds,
    remoteItems: scan.remoteItems
  })

  assertCurrentAccount(auth, expectedUserId)
  try {
    await putSyncEntry({
      providerConnectionId: connectionId,
      remoteItemId: collection.remoteItemId,
      parentRemoteItemId: null,
      kind: 'folder',
      name: collection.name,
      folderId: root.id,
      status: 'remote-only'
    })
    assertCurrentAccount(auth, expectedUserId)
    await applySyncRefreshPlan(plan)
    assertCurrentAccount(auth, expectedUserId)
    if (scan.nextCursor) {
      await putSyncCursor({
        providerConnectionId: connectionId,
        remoteFolderId: collection.remoteItemId,
        cursor: scan.nextCursor,
        updatedAt: Date.now()
      })
    }
    assertCurrentAccount(auth, expectedUserId)
    await db.put('folder-records', root)
    assertCurrentAccount(auth, expectedUserId)
  } catch (error) {
    await unlinkSyncRootFolderFromApp(root).catch(() => undefined)
    throw error
  }
  publishPersistedSyncRoot(root)
  dispatchPlannedSyncDownloads({
    provider,
    providerConnectionId: connectionId,
    rootRemoteFolderId: collection.remoteItemId,
    offlinePolicy,
    plan,
    remoteItems: scan.remoteItems,
    existingEntries: collectionEntries(entries, collection.remoteItemId),
    canCommit: () =>
      (auth.getAuthGeneration?.() ?? 0) === authGeneration &&
      auth.getSession()?.userId === expectedUserId &&
      isHhcLineRootAuthorized(auth, connectionId, collection.remoteItemId),
    onFailed: (error, transfer) =>
      handleHhcLineAccessError(
        auth,
        {
          kind: 'root',
          providerConnectionId: connectionId,
          rootRemoteFolderId: collection.remoteItemId,
          remoteItemId: transfer.remoteItemId
        },
        error,
        { accountUserId: expectedUserId, authGeneration }
      ),
    onDownloaded: (item, canCommit) => refreshImportedMediaAssets([item], canCommit)
  })

  return {
    connectionId,
    displayName: root.name,
    folderCount: plan.folders.length + 1,
    itemCount: plan.items.length,
    downloadedCount: 0,
    disabledCount: plan.disabledCount
  }
}

export function refreshHhcLineFolder(
  auth: HhcLineCloudAuth,
  rootFolderIdValue: string,
  options: { forceRetry?: boolean } = {}
): Promise<CloudRefreshSummary> {
  const existing = refreshesInFlight.get(rootFolderIdValue)
  if (existing) return existing

  const pending = runHhcLineFolderRefresh(auth, rootFolderIdValue, options)
  refreshesInFlight.set(rootFolderIdValue, pending)
  void pending.then(
    () => {
      if (refreshesInFlight.get(rootFolderIdValue) === pending) {
        refreshesInFlight.delete(rootFolderIdValue)
      }
    },
    () => {
      if (refreshesInFlight.get(rootFolderIdValue) === pending) {
        refreshesInFlight.delete(rootFolderIdValue)
      }
    }
  )
  return pending
}

async function runHhcLineFolderRefresh(
  auth: HhcLineCloudAuth,
  rootFolderIdValue: string,
  options: { forceRetry?: boolean }
): Promise<CloudRefreshSummary> {
  const authGeneration = auth.getAuthGeneration?.() ?? 0
  const offlinePolicy = useSettingsStore.getState().defaultSyncOfflinePolicy
  const session = requireSession(auth)
  const connectionId = createHhcLineProviderConnectionId(session.userId)
  const store = useFileExplorerStore.getState()
  await store.initialize()
  assertCurrentAccount(auth, session.userId)
  const root = useFileExplorerStore.getState().folders[rootFolderIdValue]
  if (
    root?.syncLink?.providerType !== 'hhc-line' ||
    root.syncLink.providerConnectionId !== connectionId
  ) {
    throw new Error('HHC LINE root folder not found')
  }
  const refreshedRoot =
    root.syncLink.offlinePolicy === offlinePolicy
      ? root
      : { ...root, syncLink: { ...root.syncLink, offlinePolicy } }

  const provider = await createProvider(auth, session.userId)
  assertCurrentAccount(auth, session.userId)
  const cursor = await getSyncCursor(connectionId, root.syncLink.remoteFolderId)
  assertCurrentAccount(auth, session.userId)
  let scan = await collectSyncChangePages(
    provider,
    connectionId,
    root.syncLink.remoteFolderId,
    cursor?.cursor
  )
  assertCurrentAccount(auth, session.userId)
  const db = await openFileExplorerDB()
  const [folders, allItems, entries, fileBlobs] = await Promise.all([
    db.getAll('folder-records'),
    db.getAll('folder-items'),
    listSyncEntriesByProviderConnection(connectionId),
    db.getAll('file-blobs')
  ])
  const existingBlobIds = await collectAvailableFileBlobIds(fileBlobs)
  assertCurrentAccount(auth, session.userId)
  let input = {
    providerConnectionId: connectionId,
    providerType: 'hhc-line' as const,
    rootFolder: refreshedRoot,
    rootRemoteFolderId: root.syncLink.remoteFolderId,
    offlinePolicy,
    platform: isElectron() ? ('electron' as const) : ('web' as const),
    existingFolders: folders,
    existingItems: allItems.filter((item): item is FileItemRecord => item.type === 'file'),
    existingEntries: collectionEntries(entries, root.syncLink.remoteFolderId),
    existingBlobIds,
    remoteItems: scan.remoteItems,
    forceRetry: options.forceRetry
  }
  const delta = scan.usedCursor ? buildSyncDeltaRefreshPlan(input) : null
  if (delta?.needsFullScan) {
    scan = await collectSyncChangePages(provider, connectionId, root.syncLink.remoteFolderId)
    assertCurrentAccount(auth, session.userId)
    input = { ...input, remoteItems: scan.remoteItems }
  }
  const plan = delta && !delta.needsFullScan ? delta : buildSyncRefreshPlan(input)
  assertCurrentAccount(auth, session.userId)
  await applySyncRefreshPlan(plan)
  try {
    assertCurrentAccount(auth, session.userId)
  } catch (error) {
    await unlinkSyncRootFolderFromApp(root).catch(() => undefined)
    throw error
  }
  if (scan.nextCursor) {
    await putSyncCursor({
      providerConnectionId: connectionId,
      remoteFolderId: root.syncLink.remoteFolderId,
      cursor: scan.nextCursor,
      updatedAt: Date.now()
    })
  }
  try {
    assertCurrentAccount(auth, session.userId)
  } catch (error) {
    await unlinkSyncRootFolderFromApp(root).catch(() => undefined)
    throw error
  }
  if (refreshedRoot !== root) {
    try {
      assertCurrentAccount(auth, session.userId)
      await db.put('folder-records', refreshedRoot)
      assertCurrentAccount(auth, session.userId)
    } catch (error) {
      await unlinkSyncRootFolderFromApp(root).catch(() => undefined)
      throw error
    }
    publishPersistedSyncRoot(refreshedRoot)
  }
  if (offlinePolicy === 'always-offline') {
    for (const entry of input.existingEntries) {
      if (
        entry.syncReceipt?.state !== 'pending' ||
        !entry.blobId ||
        !existingBlobIds.has(entry.blobId)
      )
        continue
      void provider.retryReceipt(
        connectionId,
        entry.remoteItemId,
        () =>
          (auth.getAuthGeneration?.() ?? 0) === authGeneration &&
          auth.getSession()?.userId === session.userId &&
          isHhcLineRootAuthorized(auth, connectionId, root.syncLink!.remoteFolderId)
      )
    }
  }
  dispatchPlannedSyncDownloads({
    provider,
    providerConnectionId: connectionId,
    rootRemoteFolderId: root.syncLink.remoteFolderId,
    offlinePolicy,
    plan,
    remoteItems: scan.remoteItems,
    existingEntries: input.existingEntries,
    canCommit: () =>
      (auth.getAuthGeneration?.() ?? 0) === authGeneration &&
      auth.getSession()?.userId === session.userId &&
      isHhcLineRootAuthorized(auth, connectionId, root.syncLink!.remoteFolderId),
    onFailed: (error, transfer) =>
      handleHhcLineAccessError(
        auth,
        {
          kind: 'root',
          providerConnectionId: connectionId,
          rootRemoteFolderId: root.syncLink!.remoteFolderId,
          remoteItemId: transfer.remoteItemId
        },
        error,
        { accountUserId: session.userId, authGeneration }
      ),
    onDownloaded: (item, canCommit) => refreshImportedMediaAssets([item], canCommit)
  })

  return {
    connectionId,
    rootFolderId: root.id,
    updatedItemCount: plan.items.length,
    removedItemCount: plan.removedItemIds.length,
    removedFolderCount: plan.removedFolderIds.length,
    downloadedCount: 0,
    failedFileCount: 0,
    disabledFileCount: plan.disabledCount,
    changedCount: plan.items.length + plan.removedItemIds.length + plan.removedFolderIds.length,
    pendingFileCount: plan.fileTransfers.length,
    retryableFileCount: 0,
    usedCursor: scan.usedCursor,
    fullScanFallback: Boolean(delta?.needsFullScan)
  }
}
