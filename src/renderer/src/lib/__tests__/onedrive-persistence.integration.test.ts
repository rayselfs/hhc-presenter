import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OneDriveReadonlyProvider } from '../onedrive-provider'
import { importOneDriveFolder, refreshOneDriveFolder } from '../onedrive-connect'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { resetSyncDBForTests, getSyncCursor, listSyncEntriesByProviderConnection } from '../sync-db'
import {
  resetWebOneDriveCredentialDB,
  saveWebOneDriveCredentials
} from '../onedrive-web-credentials'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { useSettingsStore } from '@renderer/stores/settings'

const fetchMock = vi.fn()
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
const firstCursor = 'https://graph.microsoft.com/v1.0/delta/first'
const secondCursor = 'https://graph.microsoft.com/v1.0/delta/second'

function graphFile(name = 'Original.png', etag = 'v1'): object {
  return {
    id: 'remote-file',
    name,
    parentReference: { id: 'remote-root' },
    file: { mimeType: 'image/png' },
    size: 3,
    eTag: etag,
    createdDateTime: '2026-01-01T00:00:00Z'
  }
}

beforeEach(async () => {
  vi.restoreAllMocks()
  await useFileExplorerStore.getState().flushPersistence()
  await resetFileExplorerDBForTests()
  await resetSyncDBForTests()
  await resetWebOneDriveCredentialDB()
  useSettingsStore.setState({ defaultSyncOfflinePolicy: 'online-only' })
  useFileExplorerStore.setState({
    folders: {},
    items: {},
    _foldersArray: [],
    _itemsArray: [],
    _childFoldersByParent: {},
    _itemsByParent: {},
    loadedParents: new Set(),
    isInitialized: false,
    isLoading: true
  })
  fetchMock.mockReset().mockImplementation(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/me'))
      return Response.json({
        id: 'synthetic-account',
        displayName: 'Synthetic',
        mail: 'fixture@example.invalid'
      })
    if (url.endsWith('/me/drive/items/remote-root/delta'))
      return Response.json({ value: [graphFile()], '@odata.deltaLink': firstCursor })
    if (url === firstCursor)
      return Response.json({
        value: [graphFile('Renamed.png', 'v2')],
        '@odata.deltaLink': secondCursor
      })
    throw new Error(`Unexpected network boundary: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  // jsdom has no Web Locks host API; persistence and refresh remain the real implementations.
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, operation: () => Promise<unknown>): Promise<unknown> =>
        operation()
    }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})

async function connect(): Promise<string> {
  const provider = new OneDriveReadonlyProvider({
    getAccessToken: async () => 'synthetic-token',
    saveDownloadedContent: async () => {
      throw new Error('Online-only should not download')
    }
  })
  const connection = await provider.connect()
  await saveWebOneDriveCredentials({
    connectionId: connection.id,
    accessToken: 'synthetic-token',
    refreshToken: 'synthetic-refresh',
    expiresAt: Date.now() + 3600_000
  })
  return connection.id
}

it('connects, imports and delta-refreshes through the real store and IndexedDB schema', async () => {
  const connectionId = await connect()
  await importOneDriveFolder({
    remoteItemId: 'remote-root',
    parentRemoteItemId: null,
    name: 'Slides'
  })
  const db = await openFileExplorerDB()
  expect(await db.getAll('folder-items')).toHaveLength(1)
  const initial = (await db.getAll('folder-items'))[0]
  expect(initial).toMatchObject({ name: 'Original.png' })
  expect(await getSyncCursor(connectionId, 'remote-root')).toMatchObject({ cursor: firstCursor })
  expect(useFileExplorerStore.getState().items[initial.id]).toEqual(initial)
  const root = (await db.getAll('folder-records')).find(
    (folder) => folder.syncLink?.providerConnectionId === connectionId
  )
  if (!root) throw new Error('Missing persisted OneDrive root')
  await refreshOneDriveFolder(root.id)
  const refreshed = await db.get('folder-items', initial.id)
  expect(refreshed).toMatchObject({ id: initial.id, name: 'Renamed.png' })
  expect(useFileExplorerStore.getState().items[initial.id]).toEqual(refreshed)
  expect(await getSyncCursor(connectionId, 'remote-root')).toMatchObject({ cursor: secondCursor })
  expect(await db.getAll('folder-items')).toHaveLength(1)
  expect(await listSyncEntriesByProviderConnection(connectionId)).toHaveLength(2)
  expect(await listSyncEntriesByProviderConnection(connectionId)).toContainEqual(
    expect.objectContaining({ itemId: initial.id, name: 'Renamed.png', etag: 'v2' })
  )
})

it('does not publish a failed import transaction or create sync entries/cursor', async () => {
  const connectionId = await connect()
  const publication = vi.fn()
  const unsubscribe = useFileExplorerStore.subscribe((state) => {
    if (state._itemsArray.length || state._foldersArray.some((folder) => folder.syncLink))
      publication()
  })
  let abortCount = 0
  const originalPut = IDBObjectStore.prototype.put
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ): IDBRequest<IDBValidKey> {
    const request = originalPut.call(this, value, key)
    if (
      this.name === 'folder-records' &&
      typeof value === 'object' &&
      value !== null &&
      'syncLink' in value
    )
      request.addEventListener(
        'success',
        () => {
          abortCount++
          this.transaction.abort()
        },
        { once: true }
      )
    return request
  })
  try {
    await expect(
      importOneDriveFolder({
        remoteItemId: 'remote-root',
        parentRemoteItemId: null,
        name: 'Slides'
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    put.mockRestore()
    unsubscribe()
  }
  expect(abortCount).toBe(1)
  expect(publication).not.toHaveBeenCalled()
  const db = await openFileExplorerDB()
  expect((await db.getAll('folder-records')).map((folder) => folder.id)).toEqual(['file-root'])
  expect(await db.getAll('folder-items')).toEqual([])
  expect(await listSyncEntriesByProviderConnection(connectionId)).toEqual([])
  expect(await getSyncCursor(connectionId, 'remote-root')).toBeUndefined()
  expect(useFileExplorerStore.getState()._foldersArray.map((folder) => folder.id)).toEqual([
    'file-root'
  ])
  expect(useFileExplorerStore.getState()._itemsArray).toEqual([])
  expect(useFileExplorerStore.getState().items).toEqual({})
  expect(Object.keys(useFileExplorerStore.getState().folders)).toEqual(['file-root'])
})

it('keeps the prior catalog, sync entries and cursor after a real refresh transaction abort', async () => {
  const connectionId = await connect()
  await importOneDriveFolder({
    remoteItemId: 'remote-root',
    parentRemoteItemId: null,
    name: 'Slides'
  })
  const db = await openFileExplorerDB()
  const root = (await db.getAll('folder-records')).find(
    (folder) => folder.syncLink?.providerConnectionId === connectionId
  )
  if (!root) throw new Error('Missing persisted root')
  const before = {
    folders: await db.getAll('folder-records'),
    items: await db.getAll('folder-items'),
    entries: await listSyncEntriesByProviderConnection(connectionId),
    cursor: await getSyncCursor(connectionId, 'remote-root')
  }
  const storeBefore = useFileExplorerStore.getState()
  const publication = vi.fn()
  const unsubscribe = useFileExplorerStore.subscribe((state) => {
    if (state.items !== storeBefore.items || state.folders !== storeBefore.folders) publication()
  })
  let abortCount = 0
  const originalPut = IDBObjectStore.prototype.put
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ): IDBRequest<IDBValidKey> {
    const request = originalPut.call(this, value, key)
    if (
      this.name === 'folder-items' &&
      typeof value === 'object' &&
      value !== null &&
      'name' in value &&
      value.name === 'Renamed.png'
    )
      request.addEventListener(
        'success',
        () => {
          abortCount++
          this.transaction.abort()
        },
        { once: true }
      )
    return request
  })
  try {
    await expect(refreshOneDriveFolder(root.id)).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    put.mockRestore()
    unsubscribe()
  }
  expect(abortCount).toBe(1)
  expect(publication).not.toHaveBeenCalled()
  expect(await db.getAll('folder-records')).toEqual(before.folders)
  expect(await db.getAll('folder-items')).toEqual(before.items)
  expect(await listSyncEntriesByProviderConnection(connectionId)).toEqual(before.entries)
  expect(await getSyncCursor(connectionId, 'remote-root')).toEqual(before.cursor)
  expect(useFileExplorerStore.getState()._itemsArray).toEqual(before.items)
  expect(useFileExplorerStore.getState()._foldersArray).toEqual(before.folders)
  expect(useFileExplorerStore.getState().items).toBe(storeBefore.items)
  expect(useFileExplorerStore.getState().folders).toBe(storeBefore.folders)
})
