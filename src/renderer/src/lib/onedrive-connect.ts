import type { FileItemRecord, FolderRecord, SyncOfflinePolicy } from '@shared/types/folder'
import {
  FILE_EXPLORER_ROOT_ID,
  useFileExplorerStore,
  mergePersistedSyncCatalog,
  publishPersistedSyncRoot
} from '@renderer/stores/file-explorer'
import { getEffectiveOneDriveClientId, useSettingsStore } from '@renderer/stores/settings'
import { isElectron } from './env'
import {
  createOneDriveAuthRequest,
  createOneDriveTokenExchangeBody,
  ONEDRIVE_TOKEN_ENDPOINT,
  parseOneDriveAuthCallback
} from './onedrive-auth'
import { OneDriveReadonlyProvider } from './onedrive-provider'
import { collectAvailableFileBlobIds, openFileExplorerDB } from './file-explorer-db'
import { resolveUniqueName } from './file-naming'
import {
  listProviderConnectionsByType,
  deleteProviderConnection,
  getProviderConnection,
  getSyncEntryByLocalItem,
  listSyncEntriesByProviderConnection,
  getSyncCursor,
  putProviderConnection,
  putSyncCursor,
  putSyncEntry,
  type ProviderConnectionRecord,
  type SyncEntryRecord
} from './sync-db'
import {
  saveElectronOneDriveDownloadedContent,
  saveWebOneDriveDownloadedContent
} from './sync-download-storage'
import {
  deleteWebOneDriveCredentials,
  getWebOneDriveAccessToken,
  saveWebOneDriveCredentials
} from './onedrive-web-credentials'
import type { MediaPlatform } from './media-capabilities'
import { classifyMediaImport } from './media-import-policy'
import type { RemoteSyncItem } from './sync-provider'
import { enqueueSyncDownload } from './sync-download-queue'
import {
  applySyncRefreshPlan,
  buildSyncDeltaRefreshPlan,
  buildSyncRefreshPlan,
  collectSyncChangePages
} from './sync-refresh'
import { refreshImportedMediaAssets } from './local-sync-import'
import { isIgnoredSystemPath } from '@shared/file-ignore-policy'
import { dispatchPlannedSyncDownloads } from './sync-transfer-dispatch'

const ONEDRIVE_WEB_CALLBACK_PATH = '/onedrive-callback.html'
const ONEDRIVE_WEB_CALLBACK_STORAGE_KEY = 'hhc-presenter:onedrive-callback'
const ONEDRIVE_WEB_CALLBACK_TIMEOUT_MS = 2 * 60_000

function rootOwner(
  id: string | undefined,
  parents: Map<string, string | null | undefined>,
  roots: Map<string, string>
): string | false | undefined {
  let owner: string | undefined
  const seen = new Set<string>()
  while (id && !seen.has(id)) {
    seen.add(id)
    const candidate = roots.get(id)
    if (candidate && owner && candidate !== owner) return false
    if (candidate) owner = candidate
    id = parents.get(id) ?? undefined
  }
  return owner
}

function hasParent(
  id: string | null | undefined,
  parents: Map<string, string | null | undefined>,
  target: string | Set<string>
): boolean {
  const seen = new Set<string>()
  while (id && !seen.has(id)) {
    if (typeof target === 'string' ? id === target : target.has(id)) return true
    seen.add(id)
    id = parents.get(id)
  }
  return false
}

function scopeRoot(
  entries: SyncEntryRecord[],
  connectionId: string,
  rootId: string,
  folders: FolderRecord[],
  items: Array<{ id: string; parentId: string; deletedAt?: number }>
): {
  entries: SyncEntryRecord[]
  protectRemovals: boolean
} {
  const roots = folders.filter((folder) => {
    const syncLink = folder.syncLink
    return (
      folder.parentId === FILE_EXPLORER_ROOT_ID &&
      syncLink?.providerType === 'onedrive' &&
      syncLink.providerConnectionId === connectionId
    )
  })
  const root = roots.find((candidate) => candidate.id === rootId && candidate.deletedAt == null)
  if (!root) return { entries: [], protectRemovals: false }
  const remoteRoot = new Map(
    roots.map((candidate) => [candidate.syncLink!.remoteFolderId, candidate.id])
  )
  const localRoot = new Map(roots.map((candidate) => [candidate.id, candidate.id]))
  const remoteUp = new Map(entries.map((entry) => [entry.remoteItemId, entry.parentRemoteItemId]))
  const folderById = new Map(folders.map((folder) => [folder.id, folder]))
  const localUp = new Map(folders.map((folder) => [folder.id, folder.parentId]))
  const itemById = new Map(items.map((item) => [item.id, item]))
  const remoteOf = (id: string): string | false | undefined => rootOwner(id, remoteUp, remoteRoot)
  const localOf = (folderId?: string): string | false | undefined =>
    rootOwner(folderId, localUp, localRoot)

  const refCounts = new Map<string, number>()
  for (const entry of entries) {
    const id = entry.kind === 'folder' ? entry.folderId : entry.itemId
    if (!id) continue
    const key = `${entry.kind}\0${id}`
    refCounts.set(key, (refCounts.get(key) ?? 0) + 1)
  }
  const activeOf = (entry: SyncEntryRecord): string | false | undefined => {
    if (entry.kind === 'folder' && entry.folderId) {
      return folderById.get(entry.folderId)?.deletedAt == null ? localOf(entry.folderId) : undefined
    }
    const item = entry.kind === 'file' && entry.itemId ? itemById.get(entry.itemId) : undefined
    return item && item.deletedAt == null ? localOf(item.parentId) : undefined
  }

  const scoped: SyncEntryRecord[] = []
  const unsafeIds = new Set<string>()
  for (const entry of entries) {
    const localId = entry.kind === 'folder' ? entry.folderId : entry.itemId
    const remote = remoteOf(entry.remoteItemId)
    const local = activeOf(entry)
    const owners = [
      remote,
      localOf(entry.folderId),
      localOf(itemById.get(entry.itemId ?? '')?.parentId)
    ]
    const wrongKind = entry.kind === 'file' ? entry.folderId : entry.itemId
    const ambiguous =
      wrongKind ||
      (localId && (refCounts.get(`${entry.kind}\0${localId}`) ?? 0) > 1) ||
      (entry.kind === 'folder' &&
        entry.folderId === rootId &&
        entry.remoteItemId !== root.syncLink!.remoteFolderId) ||
      owners.includes(false) ||
      new Set(owners.filter(Boolean)).size > 1
    const owner = remote ?? local
    if (ambiguous || !owner) {
      unsafeIds.add(entry.remoteItemId)
    } else if (owner === rootId) {
      scoped.push(entry)
    }
  }

  return {
    entries: scoped,
    protectRemovals: entries.some((entry) => {
      if (!hasParent(entry.remoteItemId, remoteUp, unsafeIds)) return false
      const parentId = itemById.get(entry.itemId ?? '')?.parentId
      return (
        hasParent(entry.remoteItemId, remoteUp, root.syncLink!.remoteFolderId) ||
        hasParent(entry.folderId, localUp, rootId) ||
        hasParent(parentId, localUp, rootId)
      )
    })
  }
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in?: number
  scope?: string
  token_type?: 'Bearer'
}

interface OneDriveImportPlan {
  folders: FolderRecord[]
  items: FileItemRecord[]
  syncEntries: Array<Omit<SyncEntryRecord, 'id' | 'createdAt' | 'updatedAt'>>
  downloadableItems: Array<{ itemId: string; remoteItemId: string }>
  disabledCount: number
}

export interface OneDriveConnectResult {
  connectionId: string
  displayName: string
  folderCount: number
  itemCount: number
  downloadedCount: number
  disabledCount: number
}

export interface OneDriveRemoteFolder {
  remoteItemId: string
  name: string
  parentRemoteItemId: string | null
}

function safeIdPart(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '_')
}

function createRootFolderId(connectionId: string, remoteFolderId: string): string {
  return `onedrive-folder-${safeIdPart(connectionId)}-${safeIdPart(remoteFolderId)}`
}

function createSyncedFolderId(connectionId: string, remoteItemId: string): string {
  return `onedrive-folder-${safeIdPart(connectionId)}-${safeIdPart(remoteItemId)}`
}

function createSyncedItemId(): string {
  return crypto.randomUUID()
}

function classifyRemoteFile(
  item: RemoteSyncItem,
  platform: MediaPlatform
): {
  mimeType: string
  disabled: boolean
  skip: boolean
} {
  const decision = classifyMediaImport({ name: item.name, mimeType: item.mimeType }, platform)
  if (decision.action === 'skip') return { mimeType: decision.mimeType, disabled: true, skip: true }
  return {
    mimeType: decision.mimeType,
    disabled: decision.action === 'platform-unsupported',
    skip: false
  }
}

export function buildOneDriveImportPlan(input: {
  connectionId: string
  displayName: string
  rootRemoteFolderId: string
  offlinePolicy: SyncOfflinePolicy
  remoteItems: RemoteSyncItem[]
  existingRootFolderNames: string[]
  platform: MediaPlatform
}): OneDriveImportPlan {
  const now = Date.now()
  const rootFolderId = createRootFolderId(input.connectionId, input.rootRemoteFolderId)
  const rootFolder: FolderRecord = {
    id: rootFolderId,
    name: resolveUniqueName(input.displayName, input.existingRootFolderNames),
    parentId: FILE_EXPLORER_ROOT_ID,
    sortIndex: input.existingRootFolderNames.length,
    createdAt: now,
    expiresAt: null,
    syncLink: {
      providerConnectionId: input.connectionId,
      remoteFolderId: input.rootRemoteFolderId,
      providerType: 'onedrive',
      offlinePolicy: input.offlinePolicy
    }
  }

  const folders: FolderRecord[] = [rootFolder]
  const items: FileItemRecord[] = []
  const syncEntries: OneDriveImportPlan['syncEntries'] = [
    {
      providerConnectionId: input.connectionId,
      remoteItemId: input.rootRemoteFolderId,
      parentRemoteItemId: null,
      kind: 'folder',
      name: input.displayName,
      folderId: rootFolderId,
      status: 'remote-only'
    }
  ]
  const downloadableItems: OneDriveImportPlan['downloadableItems'] = []
  const remoteFolderToLocalId = new Map<string | null, string>([
    [null, rootFolderId],
    [input.rootRemoteFolderId, rootFolderId]
  ])
  const folderSortCounts = new Map<string, number>([
    [FILE_EXPLORER_ROOT_ID, input.existingRootFolderNames.length + 1]
  ])
  const itemSortCounts = new Map<string, number>()
  const ignoredRemoteIds = new Set<string>()
  let disabledCount = 0

  for (const remoteItem of input.remoteItems) {
    if (
      isIgnoredSystemPath(remoteItem.name) ||
      (remoteItem.parentRemoteItemId && ignoredRemoteIds.has(remoteItem.parentRemoteItemId))
    ) {
      ignoredRemoteIds.add(remoteItem.remoteItemId)
      continue
    }
    if (remoteItem.kind !== 'folder' || remoteItem.deleted) continue
    if (remoteItem.remoteItemId === input.rootRemoteFolderId) continue
    const parentId = remoteFolderToLocalId.get(remoteItem.parentRemoteItemId) ?? rootFolderId
    const folderId = createSyncedFolderId(input.connectionId, remoteItem.remoteItemId)
    const sortIndex = folderSortCounts.get(parentId) ?? 0
    folderSortCounts.set(parentId, sortIndex + 1)
    folders.push({
      id: folderId,
      name: remoteItem.name,
      parentId,
      sortIndex,
      createdAt: now,
      expiresAt: null,
      syncLink: {
        providerConnectionId: input.connectionId,
        remoteFolderId: remoteItem.remoteItemId,
        providerType: 'onedrive',
        offlinePolicy: input.offlinePolicy
      }
    })
    remoteFolderToLocalId.set(remoteItem.remoteItemId, folderId)
    syncEntries.push({
      providerConnectionId: input.connectionId,
      remoteItemId: remoteItem.remoteItemId,
      parentRemoteItemId: remoteItem.parentRemoteItemId,
      kind: 'folder',
      name: remoteItem.name,
      folderId,
      status: 'remote-only'
    })
  }

  for (const remoteItem of input.remoteItems) {
    if (ignoredRemoteIds.has(remoteItem.remoteItemId)) continue
    if (remoteItem.kind !== 'file' || remoteItem.deleted) continue
    const parentId = remoteFolderToLocalId.get(remoteItem.parentRemoteItemId) ?? rootFolderId
    const policy = classifyRemoteFile(remoteItem, input.platform)
    if (policy.skip) continue
    const itemId = createSyncedItemId()
    const sortIndex = itemSortCounts.get(parentId) ?? 0
    itemSortCounts.set(parentId, sortIndex + 1)
    items.push({
      id: itemId,
      parentId,
      type: 'file',
      sortIndex,
      createdAt: now,
      expiresAt: null,
      name: remoteItem.name,
      url: policy.disabled ? `unsupported:${itemId}` : `blob:${itemId}`,
      size: remoteItem.size ?? 0,
      mimeType: policy.mimeType
    })
    if (policy.disabled) {
      disabledCount++
      syncEntries.push({
        providerConnectionId: input.connectionId,
        remoteItemId: remoteItem.remoteItemId,
        parentRemoteItemId: remoteItem.parentRemoteItemId,
        kind: 'file',
        name: remoteItem.name,
        itemId,
        mimeType: policy.mimeType,
        size: remoteItem.size,
        etag: remoteItem.etag,
        contentHash: remoteItem.contentHash,
        status: 'remote-only'
      })
      continue
    }
    downloadableItems.push({ itemId, remoteItemId: remoteItem.remoteItemId })
    syncEntries.push({
      providerConnectionId: input.connectionId,
      remoteItemId: remoteItem.remoteItemId,
      parentRemoteItemId: remoteItem.parentRemoteItemId,
      kind: 'file',
      name: remoteItem.name,
      itemId,
      mimeType: policy.mimeType,
      size: remoteItem.size,
      etag: remoteItem.etag,
      contentHash: remoteItem.contentHash,
      status: input.offlinePolicy === 'always-offline' ? 'queued' : 'remote-only'
    })
  }

  return { folders, items, syncEntries, downloadableItems, disabledCount }
}

async function exchangeWebToken(input: {
  clientId: string
  redirectUri: string
  code: string
  codeVerifier: string
}): Promise<TokenResponse> {
  const response = await fetch(ONEDRIVE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: createOneDriveTokenExchangeBody(input)
  })
  if (!response.ok) throw new Error(`OneDrive token exchange failed: ${response.status}`)
  const data = (await response.json()) as Partial<TokenResponse>
  if (!data.access_token || !data.refresh_token) {
    throw new Error('Invalid OneDrive token response')
  }
  return data as TokenResponse
}

async function saveImportedRecords(
  folders: FolderRecord[],
  items: FileItemRecord[]
): Promise<void> {
  const db = await openFileExplorerDB()
  const tx = db.transaction(['folder-records', 'folder-items'], 'readwrite')
  await Promise.all([
    ...folders.map((folder) => tx.objectStore('folder-records').put(folder)),
    ...items.map((item) => tx.objectStore('folder-items').put(item)),
    tx.done
  ])
}

function getOneDriveRedirectUri(): string {
  return `${window.location.origin}${ONEDRIVE_WEB_CALLBACK_PATH}`
}

function getOneDriveMediaPlatform(): MediaPlatform {
  return isElectron() ? 'electron' : 'web'
}

function waitForWebOneDriveCallback(authWindow: Window | null): Promise<string | null> {
  if (!authWindow) return Promise.resolve(null)

  return new Promise((resolve) => {
    const cleanup = (): void => {
      window.removeEventListener('message', handleMessage)
      window.removeEventListener('storage', handleStorage)
      window.clearTimeout(timeout)
    }
    const done = (url: string | null): void => {
      cleanup()
      if (url) clearStoredWebOneDriveCallback()
      resolve(url)
    }
    const handleStorage = (event: StorageEvent): void => {
      if (event.key === ONEDRIVE_WEB_CALLBACK_STORAGE_KEY && typeof event.newValue === 'string') {
        done(event.newValue)
      }
    }
    const handleMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) return
      const data = event.data
      if (
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        data.type === 'hhc-presenter:onedrive-callback' &&
        'url' in data &&
        typeof data.url === 'string'
      ) {
        done(data.url)
      }
    }
    window.addEventListener('message', handleMessage)
    window.addEventListener('storage', handleStorage)
    const timeout = window.setTimeout(
      () => done(readStoredWebOneDriveCallback()),
      ONEDRIVE_WEB_CALLBACK_TIMEOUT_MS
    )
  })
}

function clearStoredWebOneDriveCallback(): void {
  try {
    localStorage.removeItem(ONEDRIVE_WEB_CALLBACK_STORAGE_KEY)
  } catch {
    // Ignore storage errors; postMessage still handles the normal callback path.
  }
}

function readStoredWebOneDriveCallback(): string | null {
  try {
    return localStorage.getItem(ONEDRIVE_WEB_CALLBACK_STORAGE_KEY)
  } catch {
    return null
  }
}

function getOneDriveClientId(): string {
  return getEffectiveOneDriveClientId()
}

function createStoredOneDriveProvider(connectionId: string): OneDriveReadonlyProvider {
  const clientId = getOneDriveClientId()
  return new OneDriveReadonlyProvider({
    getAccessToken: async () => {
      if (!isElectron()) return getWebOneDriveAccessToken({ connectionId, clientId })
      if (!window.api?.oneDrive) throw new Error('OneDrive desktop API is not available')
      const token = await window.api.oneDrive.getAccessToken({ connectionId, clientId })
      return token.accessToken
    },
    saveDownloadedContent: (downloadRequest, _response, metadata, canCommit) =>
      isElectron()
        ? saveElectronOneDriveDownloadedContent(downloadRequest, clientId, metadata, canCommit)
        : saveWebOneDriveDownloadedContent(downloadRequest, _response, metadata, canCommit),
    fetchContentBeforeSave: !isElectron()
  })
}

async function downloadOneDriveItemForPresentation(item: FileItemRecord): Promise<boolean> {
  const entry = await getSyncEntryByLocalItem(item.id)
  if (!entry || entry.status === 'available-offline') return true
  if (
    entry.kind !== 'file' ||
    entry.status === 'insufficient-storage' ||
    entry.status === 'deleted-pending-release'
  ) {
    return false
  }

  const connection = await getProviderConnection(entry.providerConnectionId)
  if (connection?.providerType !== 'onedrive') return false
  const folders = useFileExplorerStore.getState().folders
  let parent: FolderRecord | undefined = folders[item.parentId]
  while (parent && !parent.syncLink) parent = parent.parentId ? folders[parent.parentId] : undefined
  const rootRemoteFolderId = parent?.syncLink?.remoteFolderId
  if (!rootRemoteFolderId) return false

  const provider = createStoredOneDriveProvider(entry.providerConnectionId)
  const result = await enqueueSyncDownload({
    provider,
    request: {
      providerConnectionId: entry.providerConnectionId,
      rootRemoteFolderId,
      remoteItemId: entry.remoteItemId,
      targetBlobId: item.id,
      offlinePolicy: 'always-offline'
    },
    entry: {
      providerConnectionId: entry.providerConnectionId,
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
    onDownloaded: () => refreshImportedMediaAssets([item])
  })
  return result !== null
}

export function ensureOneDriveItemAvailableForPresentation(item: FileItemRecord): Promise<boolean> {
  return downloadOneDriveItemForPresentation(item)
}

export async function scanOneDriveFolder(
  provider: OneDriveReadonlyProvider,
  connectionId: string,
  remoteFolderId: string,
  cursor?: string
): Promise<{ remoteItems: RemoteSyncItem[]; nextCursor?: string; usedCursor: boolean }> {
  return collectSyncChangePages(provider, connectionId, remoteFolderId, cursor)
}

export async function getConnectedOneDriveAccount(): Promise<ProviderConnectionRecord | null> {
  const connections = await listProviderConnectionsByType('onedrive')
  return connections[0] ?? null
}

export async function loginOneDriveAccount(options?: {
  requestCallbackUrl?: () => Promise<string | null>
}): Promise<ProviderConnectionRecord | null> {
  const existing = await listProviderConnectionsByType('onedrive')
  if (existing.length > 0) {
    throw new Error('Only one OneDrive account can be connected')
  }

  const clientId = getEffectiveOneDriveClientId()
  const electronMode = isElectron()
  const electronRedirectUri = electronMode ? await window.api.oneDrive.getAuthRedirectUri() : null
  if (!electronMode) clearStoredWebOneDriveCallback()
  const request = await createOneDriveAuthRequest({
    clientId,
    redirectUri: electronRedirectUri ?? getOneDriveRedirectUri(),
    prompt: 'select_account'
  })
  const authWindow = window.open(
    request.authorizationUrl,
    '_blank',
    isElectron() ? 'noopener,noreferrer' : 'popup,width=520,height=720'
  )
  const callbackUrl = await (options?.requestCallbackUrl
    ? options.requestCallbackUrl()
    : isElectron()
      ? window.api.oneDrive.waitAuthCallback(request.state)
      : waitForWebOneDriveCallback(authWindow))
  if (!callbackUrl) return null

  const callback = parseOneDriveAuthCallback(callbackUrl, request.state)
  if (electronMode) {
    let connectionIdToDelete: string | null = null
    try {
      if (!window.api?.oneDrive) throw new Error('OneDrive desktop API is not available')
      const connectedAccount = await window.api.oneDrive.completeAuth({
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        code: callback.code,
        codeVerifier: request.codeVerifier
      })
      connectionIdToDelete = connectedAccount.id
      const latestConnections = await listProviderConnectionsByType('onedrive')
      if (latestConnections.some((connection) => connection.id !== connectedAccount.id)) {
        throw new Error('Only one OneDrive account can be connected')
      }
      return putProviderConnection({
        id: connectedAccount.id,
        providerType: connectedAccount.providerType,
        displayName: connectedAccount.displayName,
        accountLabel: connectedAccount.accountLabel
      })
    } catch (error) {
      if (connectionIdToDelete) {
        await window.api.oneDrive.deleteCredentials(connectionIdToDelete).catch(() => undefined)
      }
      throw error
    }
  }

  const token = await exchangeWebToken({
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    code: callback.code,
    codeVerifier: request.codeVerifier
  })
  const provider = new OneDriveReadonlyProvider({
    getAccessToken: async () => token.access_token,
    saveDownloadedContent: (downloadRequest, _response, metadata, canCommit) =>
      saveWebOneDriveDownloadedContent(downloadRequest, _response, metadata, canCommit),
    fetchContentBeforeSave: true
  })

  const connection = await provider.connect()
  try {
    const credentials = {
      connectionId: connection.id,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt:
        typeof token.expires_in === 'number' && Number.isFinite(token.expires_in)
          ? Date.now() + token.expires_in * 1000
          : undefined,
      scope: token.scope,
      tokenType: token.token_type
    }
    await saveWebOneDriveCredentials(credentials)
    return (await getProviderConnection(connection.id)) ?? null
  } catch (error) {
    await deleteWebOneDriveCredentials(connection.id).catch(() => undefined)
    await deleteProviderConnection(connection.id).catch(() => undefined)
    throw error
  }
}

export async function listOneDriveFolders(
  parentRemoteFolderId = 'root'
): Promise<OneDriveRemoteFolder[]> {
  const connection = await getConnectedOneDriveAccount()
  if (!connection) throw new Error('OneDrive account is not connected')
  const provider = createStoredOneDriveProvider(connection.id)
  const folders = await provider.listFolders(parentRemoteFolderId)
  return folders.map((folder) => ({
    remoteItemId: folder.remoteItemId,
    parentRemoteItemId: folder.parentRemoteItemId,
    name: folder.name
  }))
}

export async function importOneDriveFolder(
  remoteFolder: OneDriveRemoteFolder
): Promise<OneDriveConnectResult> {
  const connection = await getConnectedOneDriveAccount()
  if (!connection) throw new Error('OneDrive account is not connected')

  const { defaultSyncOfflinePolicy } = useSettingsStore.getState()
  const provider = createStoredOneDriveProvider(connection.id)
  const { remoteItems, nextCursor } = await scanOneDriveFolder(
    provider,
    connection.id,
    remoteFolder.remoteItemId
  )

  const store = useFileExplorerStore.getState()
  await store.initialize()
  const plan = buildOneDriveImportPlan({
    connectionId: connection.id,
    displayName: remoteFolder.name,
    rootRemoteFolderId: remoteFolder.remoteItemId,
    offlinePolicy: defaultSyncOfflinePolicy,
    remoteItems,
    existingRootFolderNames: store
      .getChildFolders(FILE_EXPLORER_ROOT_ID)
      .map((folder) => folder.name),
    platform: getOneDriveMediaPlatform()
  })
  await saveImportedRecords(plan.folders, plan.items)
  await Promise.all(plan.syncEntries.map((entry) => putSyncEntry(entry)))
  if (nextCursor) {
    await putSyncCursor({
      providerConnectionId: connection.id,
      remoteFolderId: remoteFolder.remoteItemId,
      cursor: nextCursor,
      updatedAt: Date.now()
    })
  }

  mergePersistedSyncCatalog(plan.folders, plan.items)

  if (defaultSyncOfflinePolicy === 'always-offline') {
    dispatchPlannedSyncDownloads({
      provider,
      providerConnectionId: connection.id,
      rootRemoteFolderId: remoteFolder.remoteItemId,
      offlinePolicy: defaultSyncOfflinePolicy,
      plan: {
        items: plan.items,
        fileTransfers: plan.downloadableItems.map((transfer) => ({
          ...transfer,
          mimeType: plan.items.find((item) => item.id === transfer.itemId)!.mimeType
        }))
      },
      remoteItems,
      existingEntries: [],
      onDownloaded: (item) => refreshImportedMediaAssets([item])
    })
  }

  return {
    connectionId: connection.id,
    displayName: remoteFolder.name,
    folderCount: plan.folders.length,
    itemCount: plan.items.length,
    downloadedCount: 0,
    disabledCount: plan.disabledCount
  }
}

export interface OneDriveRefreshSummary {
  connectionId: string
  rootFolderId: string
  updatedItemCount: number
  removedItemCount: number
  removedFolderCount: number
  downloadedCount: number
  failedFileCount: number
  disabledFileCount: number
  changedCount: number
  pendingFileCount: number
  retryableFileCount: number
  nextRetryAt?: number
  usedCursor: boolean
  fullScanFallback: boolean
}

const oneDriveRefreshesInFlight = new Map<string, Promise<OneDriveRefreshSummary>>()

function isExpiredCursorError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    return (error as { status?: unknown }).status === 410
  }
  return error instanceof Error && error.message.includes('410')
}

export async function refreshOneDriveFolder(
  rootFolderId: string,
  options: { forceRetry?: boolean } = {}
): Promise<OneDriveRefreshSummary> {
  const existing = oneDriveRefreshesInFlight.get(rootFolderId)
  if (existing) return existing
  const refresh = runOneDriveFolderRefresh(rootFolderId, options)
  oneDriveRefreshesInFlight.set(rootFolderId, refresh)
  try {
    return await refresh
  } finally {
    if (oneDriveRefreshesInFlight.get(rootFolderId) === refresh) {
      oneDriveRefreshesInFlight.delete(rootFolderId)
    }
  }
}

async function runOneDriveFolderRefresh(
  rootFolderId: string,
  options: { forceRetry?: boolean } = {}
): Promise<OneDriveRefreshSummary> {
  const offlinePolicy = useSettingsStore.getState().defaultSyncOfflinePolicy
  const store = useFileExplorerStore.getState()
  await store.initialize()
  const db = await openFileExplorerDB()
  const [folders, allItems, fileBlobs] = await Promise.all([
    db.getAll('folder-records'),
    db.getAll('folder-items'),
    db.getAll('file-blobs')
  ])
  const rootFolder = folders.find((folder) => folder.id === rootFolderId)
  const syncLink = rootFolder?.syncLink
  if (!rootFolder || !syncLink || syncLink.providerType !== 'onedrive') {
    throw new Error('OneDrive root folder not found')
  }
  const refreshedRoot =
    syncLink.offlinePolicy === offlinePolicy
      ? rootFolder
      : { ...rootFolder, syncLink: { ...syncLink, offlinePolicy } }

  const provider = createStoredOneDriveProvider(syncLink.providerConnectionId)
  const cursor = await getSyncCursor(syncLink.providerConnectionId, syncLink.remoteFolderId)
  const accountEntries = await listSyncEntriesByProviderConnection(syncLink.providerConnectionId)
  const scope = scopeRoot(
    accountEntries,
    syncLink.providerConnectionId,
    rootFolder.id,
    folders,
    allItems
  )
  const existingEntries = scope.entries
  const existingFolderIds = new Set([
    rootFolder.id,
    ...existingEntries.flatMap((entry) => (entry.folderId ? [entry.folderId] : []))
  ])
  const existingItemIds = new Set(
    existingEntries.flatMap((entry) => (entry.itemId ? [entry.itemId] : []))
  )

  let scan: Awaited<ReturnType<typeof scanOneDriveFolder>>
  let fullScanFallback = false
  try {
    scan = await scanOneDriveFolder(
      provider,
      syncLink.providerConnectionId,
      syncLink.remoteFolderId,
      cursor?.cursor
    )
  } catch (error) {
    if (!cursor?.cursor || !isExpiredCursorError(error)) throw error
    fullScanFallback = true
    scan = await scanOneDriveFolder(
      provider,
      syncLink.providerConnectionId,
      syncLink.remoteFolderId
    )
  }

  const basePlanInput = {
    providerConnectionId: syncLink.providerConnectionId,
    providerType: 'onedrive' as const,
    rootFolder: refreshedRoot,
    rootRemoteFolderId: syncLink.remoteFolderId,
    offlinePolicy,
    platform: getOneDriveMediaPlatform(),
    existingFolders: folders.filter((folder) => existingFolderIds.has(folder.id)),
    existingItems: allItems.filter(
      (item): item is FileItemRecord => item.type === 'file' && existingItemIds.has(item.id)
    ),
    existingEntries,
    existingBlobIds: await collectAvailableFileBlobIds(fileBlobs),
    forceRetry: options.forceRetry
  }

  let plan = scan.usedCursor
    ? buildSyncDeltaRefreshPlan({ ...basePlanInput, remoteItems: scan.remoteItems })
    : buildSyncRefreshPlan({ ...basePlanInput, remoteItems: scan.remoteItems })

  if ('needsFullScan' in plan && plan.needsFullScan) {
    fullScanFallback = true
    scan = await scanOneDriveFolder(
      provider,
      syncLink.providerConnectionId,
      syncLink.remoteFolderId
    )
    plan = buildSyncRefreshPlan({ ...basePlanInput, remoteItems: scan.remoteItems })
  }

  if (scope.protectRemovals) {
    plan.removedEntries = []
    plan.removedFolderIds = []
    plan.removedItemIds = []
  }

  await applySyncRefreshPlan(plan)
  if (!scope.protectRemovals && scan.nextCursor) {
    await putSyncCursor({
      providerConnectionId: syncLink.providerConnectionId,
      remoteFolderId: syncLink.remoteFolderId,
      cursor: scan.nextCursor,
      updatedAt: Date.now()
    })
  }
  if (refreshedRoot !== rootFolder) {
    await db.put('folder-records', refreshedRoot)
    publishPersistedSyncRoot(refreshedRoot)
  }

  const downloadedCount = 0
  const failedFileCount = 0
  const retryableFileCount = plan.syncEntries.filter(
    (entry) =>
      entry.status === 'failed' &&
      (entry.errorKind === 'retryable' || entry.errorKind === 'offline')
  ).length
  const nextRetryAt = plan.syncEntries
    .map((entry) => entry.nextRetryAt)
    .filter((value): value is number => typeof value === 'number')
    .sort((a, b) => a - b)[0]
  dispatchPlannedSyncDownloads({
    provider,
    providerConnectionId: syncLink.providerConnectionId,
    rootRemoteFolderId: syncLink.remoteFolderId,
    offlinePolicy,
    plan,
    remoteItems: scan.remoteItems,
    existingEntries,
    onDownloaded: (item) => refreshImportedMediaAssets([item])
  })

  const changedCount =
    plan.folders.length +
    plan.items.length +
    plan.removedFolderIds.length +
    plan.removedItemIds.length
  const pendingFileCount = plan.fileTransfers.length - downloadedCount

  return {
    connectionId: syncLink.providerConnectionId,
    rootFolderId,
    updatedItemCount: plan.items.length,
    removedItemCount: plan.removedItemIds.length,
    removedFolderCount: plan.removedFolderIds.length,
    downloadedCount,
    failedFileCount,
    disabledFileCount: plan.disabledCount,
    changedCount,
    pendingFileCount,
    retryableFileCount,
    nextRetryAt,
    usedCursor: scan.usedCursor && !fullScanFallback,
    fullScanFallback
  }
}

export async function refreshAllOneDriveFolders(
  options: { forceRetry?: boolean } = {}
): Promise<OneDriveRefreshSummary[]> {
  const db = await openFileExplorerDB()
  const folders = await db.getAll('folder-records')
  const roots = folders.filter(
    (folder) =>
      folder.parentId === FILE_EXPLORER_ROOT_ID && folder.syncLink?.providerType === 'onedrive'
  )
  const results: OneDriveRefreshSummary[] = []
  for (const folder of roots) {
    results.push(await refreshOneDriveFolder(folder.id, options))
  }
  return results
}
