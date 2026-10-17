import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FILE_EXPLORER_ROOT_ID, useFileExplorerStore } from '@renderer/stores/file-explorer'
import type { FileItemRecord, FolderRecord, SyncOfflinePolicy } from '@shared/types/folder'
import {
  buildOneDriveImportPlan,
  ensureOneDriveItemAvailableForPresentation,
  importOneDriveFolder,
  loginOneDriveAccount,
  refreshOneDriveFolder,
  scanOneDriveFolder
} from '../onedrive-connect'
import type { OneDriveReadonlyProvider } from '../onedrive-provider'
import type { SyncChangePage } from '../sync-provider'
import { openFileExplorerDB } from '../file-explorer-db'
import { refreshImportedMediaAssets } from '../local-sync-import'
import {
  getSyncCursor,
  listProviderConnectionsByType,
  listSyncEntriesByProviderConnection,
  putSyncCursor,
  putSyncEntry,
  putSyncTombstone,
  type SyncEntryRecord
} from '../sync-db'
import { getSyncEntryByLocalItem } from '../sync-db'
import { resetSyncDownloadQueueForTests } from '../sync-download-queue'
import { cleanupFileResources } from '../file-resource-cleanup'

const providerMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  initialScan: vi.fn(),
  incrementalChanges: vi.fn(),
  downloadContent: vi.fn()
}))

const settingsMocks = vi.hoisted(() => ({
  offlinePolicy: 'always-offline' as SyncOfflinePolicy
}))

const cleanupMocks = vi.hoisted(() => ({
  cleanupFileResources: vi.fn(async () => ({ folderIds: [], itemIds: [] }))
}))

vi.mock('../sync-refresh-lifetime', async () => {
  const actual = await vi.importActual<typeof import('../sync-refresh-lifetime')>(
    '../sync-refresh-lifetime'
  )
  return {
    ...actual,
    withSyncConnectionMutation: (_id: string, operation: () => Promise<unknown>) => operation()
  }
})

vi.mock('../env', () => ({
  isElectron: vi.fn(() => true),
  isWeb: vi.fn(() => false)
}))

vi.mock('@renderer/stores/settings', () => ({
  getEffectiveOneDriveClientId: () => '11111111-2222-3333-4444-555555555555',
  useSettingsStore: {
    getState: () => ({ defaultSyncOfflinePolicy: settingsMocks.offlinePolicy })
  }
}))

vi.mock('../onedrive-auth', async () => {
  const actual = await vi.importActual<typeof import('../onedrive-auth')>('../onedrive-auth')
  return {
    ...actual,
    createOneDriveAuthRequest: vi.fn(async (input: { redirectUri: string }) => ({
      authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      clientId: '11111111-2222-3333-4444-555555555555',
      redirectUri: input.redirectUri,
      state: 'state-1',
      codeVerifier: 'verifier-1',
      scopes: ['offline_access', 'User.Read', 'Files.Read']
    }))
  }
})

vi.mock('../onedrive-provider', () => {
  class MockOneDriveReadonlyProvider {
    connect = providerMocks.connect
    initialScan = providerMocks.initialScan
    incrementalChanges = providerMocks.incrementalChanges
    downloadContent = providerMocks.downloadContent
  }
  return {
    OneDriveReadonlyProvider: MockOneDriveReadonlyProvider
  }
})

vi.mock('../sync-db', () => ({
  deleteProviderConnection: vi.fn(async () => undefined),
  getProviderConnection: vi.fn(async () => ({
    id: 'onedrive:account-1',
    providerType: 'onedrive',
    displayName: 'OneDrive - Alice',
    accountLabel: 'alice@example.com',
    createdAt: 1,
    updatedAt: 1
  })),
  getSyncCursor: vi.fn(async () => undefined),
  getSyncEntryByLocalItem: vi.fn(async () => undefined),
  getSyncEntryByRemoteItem: vi.fn(async () => undefined),
  listProviderConnectionsByType: vi.fn(async () => []),
  listSyncEntriesByProviderConnection: vi.fn(async () => []),
  putProviderConnection: vi.fn(async (record) => ({
    ...record,
    createdAt: 1,
    updatedAt: 1
  })),
  putSyncCursor: vi.fn(async () => undefined),
  putSyncEntry: vi.fn(async () => undefined),
  putSyncTombstone: vi.fn(async () => undefined)
}))

vi.mock('../file-resource-cleanup', () => cleanupMocks)

vi.mock('../file-explorer-db', () => ({
  collectAvailableFileBlobIds: vi.fn(async (records: Array<{ id: string }>) => {
    return new Set(records.map((record) => record.id))
  }),
  getFileBlobRecord: vi.fn(async () => undefined),
  openFileExplorerDB: vi.fn()
}))

vi.mock('../local-sync-import', () => ({
  refreshImportedMediaAssets: vi.fn(async () => undefined)
}))

vi.mock('../sync-download-storage', () => ({
  isSyncStorageLimitError: vi.fn(() => false),
  saveElectronOneDriveDownloadedContent: vi.fn(),
  saveWebOneDriveDownloadedContent: vi.fn()
}))

vi.mock('../onedrive-web-credentials', () => ({
  deleteWebOneDriveCredentials: vi.fn(async () => undefined),
  getWebOneDriveAccessToken: vi.fn(async () => 'access-token'),
  saveWebOneDriveCredentials: vi.fn(async () => undefined)
}))

vi.mock('@heroui/react/toast', () => ({
  toast: { warning: vi.fn() }
}))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function setupTwoRootRefresh(options: {
  rootAOfflinePolicy: SyncOfflinePolicy
  availableA: boolean
  mutate?: (fixture: {
    rootA: FolderRecord
    rootB: FolderRecord
    itemA: FileItemRecord
    itemB: FileItemRecord
    folders: FolderRecord[]
    items: FileItemRecord[]
    entries: SyncEntryRecord[]
  }) => void
}): {
  rootA: FolderRecord
  rootB: FolderRecord
  itemA: FileItemRecord
  itemB: FileItemRecord
} {
  const rootA: FolderRecord = {
    id: 'onedrive-root-a',
    name: 'Root A',
    parentId: FILE_EXPLORER_ROOT_ID,
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    syncLink: {
      providerConnectionId: 'onedrive:account-1',
      remoteFolderId: 'remote-root-a',
      providerType: 'onedrive',
      offlinePolicy: options.rootAOfflinePolicy
    }
  }
  const rootB: FolderRecord = {
    id: 'onedrive-root-b',
    name: 'Root B',
    parentId: FILE_EXPLORER_ROOT_ID,
    sortIndex: 1,
    createdAt: 1,
    expiresAt: null,
    syncLink: {
      providerConnectionId: 'onedrive:account-1',
      remoteFolderId: 'remote-root-b',
      providerType: 'onedrive',
      offlinePolicy: 'on-demand'
    }
  }
  const itemA: FileItemRecord = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'a.jpg',
    type: 'file',
    parentId: rootA.id,
    url: 'blob:11111111-1111-4111-8111-111111111111',
    size: 10,
    mimeType: 'image/jpeg',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null
  }
  const itemB: FileItemRecord = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'b.jpg',
    type: 'file',
    parentId: rootB.id,
    url: 'blob:22222222-2222-4222-8222-222222222222',
    size: 20,
    mimeType: 'image/jpeg',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null
  }
  const entries: SyncEntryRecord[] = [
    {
      id: 'entry-root-a',
      providerConnectionId: 'onedrive:account-1',
      remoteItemId: 'remote-root-a',
      parentRemoteItemId: null,
      kind: 'folder',
      name: 'Root A',
      folderId: rootA.id,
      status: 'remote-only',
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'entry-file-a',
      providerConnectionId: 'onedrive:account-1',
      remoteItemId: 'remote-file-a',
      parentRemoteItemId: 'remote-root-a',
      kind: 'file',
      name: itemA.name,
      itemId: itemA.id,
      ...(options.availableA ? { blobId: itemA.id } : {}),
      mimeType: itemA.mimeType,
      size: itemA.size,
      etag: 'etag-a',
      status: options.availableA ? 'available-offline' : 'remote-only',
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'entry-root-b',
      providerConnectionId: 'onedrive:account-1',
      remoteItemId: 'remote-root-b',
      parentRemoteItemId: null,
      kind: 'folder',
      name: 'Root B',
      folderId: rootB.id,
      status: 'remote-only',
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'entry-file-b',
      providerConnectionId: 'onedrive:account-1',
      remoteItemId: 'remote-file-b',
      parentRemoteItemId: 'remote-root-b',
      kind: 'file',
      name: itemB.name,
      itemId: itemB.id,
      blobId: itemB.id,
      mimeType: itemB.mimeType,
      size: itemB.size,
      etag: 'etag-b',
      status: 'remote-only',
      createdAt: 1,
      updatedAt: 1
    }
  ]
  const fileBlobs = [
    ...(options.availableA ? [{ id: itemA.id, blob: new Blob(['a']), refCount: 1 }] : []),
    { id: itemB.id, blob: new Blob(['b']), refCount: 1 }
  ]
  const folders = [rootA, rootB]
  const items = [itemA, itemB]
  options.mutate?.({ rootA, rootB, itemA, itemB, folders, items, entries })

  useFileExplorerStore.getState().folders = Object.fromEntries(
    folders.map((folder) => [folder.id, folder])
  )
  useFileExplorerStore.getState().items = Object.fromEntries(items.map((item) => [item.id, item]))
  vi.mocked(listSyncEntriesByProviderConnection).mockResolvedValueOnce(entries)
  vi.mocked(openFileExplorerDB).mockResolvedValue({
    get: vi.fn(async (_store: string, id: string) => folders.find((folder) => folder.id === id)),
    getAll: vi.fn(async (store: string) => {
      if (store === 'folder-records') return folders
      if (store === 'folder-items') return items
      if (store === 'file-blobs') return fileBlobs
      return []
    }),
    put: vi.fn(async () => undefined),
    transaction: () => ({
      objectStore: () => ({
        delete: vi.fn(async () => undefined),
        get: vi.fn(async (id: string) => folders.find((folder) => folder.id === id)),
        getAll: vi.fn(async () => []),
        put: vi.fn(async () => undefined)
      }),
      done: Promise.resolve()
    })
  } as never)

  return { rootA, rootB, itemA, itemB }
}

function rootASnapshot(): SyncChangePage {
  return {
    items: [
      {
        remoteItemId: 'remote-root-a',
        parentRemoteItemId: null,
        kind: 'folder',
        name: 'Root A'
      },
      {
        remoteItemId: 'remote-file-a',
        parentRemoteItemId: 'remote-root-a',
        kind: 'file',
        name: 'a.jpg',
        mimeType: 'image/jpeg',
        size: 10,
        etag: 'etag-a'
      }
    ],
    nextCursor: 'cursor-full',
    hasMore: false
  }
}

function rootAOnlySnapshot(): SyncChangePage {
  return {
    items: [rootASnapshot().items[0]],
    nextCursor: 'cursor-full',
    hasMore: false
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  settingsMocks.offlinePolicy = 'always-offline'
  resetSyncDownloadQueueForTests()
  useFileExplorerStore.getState().folders = {}
  useFileExplorerStore.getState().items = {}
  useFileExplorerStore.getState()._childFoldersByParent = {}
  useFileExplorerStore.getState()._itemsByParent = {}
  useFileExplorerStore.getState()._foldersArray = []
  useFileExplorerStore.getState()._itemsArray = []
  useFileExplorerStore.getState().loadedParents = new Set()
  vi.spyOn(useFileExplorerStore.getState(), 'initialize').mockResolvedValue(undefined)
  providerMocks.connect.mockResolvedValue({
    id: 'onedrive:account-1',
    providerType: 'onedrive',
    displayName: 'OneDrive - Alice',
    accountLabel: 'alice@example.com'
  })
  vi.mocked(openFileExplorerDB).mockResolvedValue({
    transaction: () => ({
      objectStore: () => ({
        put: vi.fn(async () => undefined)
      }),
      done: Promise.resolve()
    })
  } as never)
})

describe('buildOneDriveImportPlan', () => {
  it('mounts the selected OneDrive folder instead of the account root', () => {
    const plan = buildOneDriveImportPlan({
      connectionId: 'onedrive:account-1',
      displayName: 'Drama Audio',
      rootRemoteFolderId: 'remote-folder-1',
      offlinePolicy: 'always-offline',
      existingRootFolderNames: [],
      platform: 'electron',
      remoteItems: [
        {
          remoteItemId: 'remote-folder-1',
          parentRemoteItemId: 'root',
          kind: 'folder',
          name: 'Drama Audio',
          deleted: false
        },
        {
          remoteItemId: 'child-folder-1',
          parentRemoteItemId: 'remote-folder-1',
          kind: 'folder',
          name: 'Scene 1',
          deleted: false
        },
        {
          remoteItemId: 'file-1',
          parentRemoteItemId: 'child-folder-1',
          kind: 'file',
          name: 'cue.mp4',
          mimeType: 'video/mp4',
          size: 2048,
          deleted: false
        },
        {
          remoteItemId: 'system-file',
          parentRemoteItemId: 'child-folder-1',
          kind: 'file',
          name: '.DS_Store',
          size: 100,
          deleted: false
        }
      ]
    })

    expect(plan.folders[0]).toMatchObject({
      name: 'Drama Audio',
      parentId: FILE_EXPLORER_ROOT_ID,
      syncLink: {
        remoteFolderId: 'remote-folder-1',
        providerType: 'onedrive'
      }
    })
    expect(plan.syncEntries[0]).toMatchObject({
      remoteItemId: 'remote-folder-1',
      parentRemoteItemId: null,
      kind: 'folder',
      folderId: plan.folders[0].id
    })
    expect(plan.folders).toHaveLength(2)
    expect(plan.folders[1]).toMatchObject({
      name: 'Scene 1',
      parentId: plan.folders[0].id
    })
    expect(plan.items[0]).toMatchObject({
      name: 'cue.mp4',
      parentId: plan.folders[1].id
    })
    expect(plan.items.find((item) => item.name === '.DS_Store')).toBeUndefined()
    expect(plan.items[0].id).toMatch(UUID_PATTERN)
    expect(plan.downloadableItems[0]).toMatchObject({ itemId: plan.items[0].id })
    const fileEntry = plan.syncEntries.find((entry) => entry.remoteItemId === 'file-1')
    expect(fileEntry).toMatchObject({
      itemId: plan.items[0].id,
      status: 'queued'
    })
    expect(fileEntry).not.toHaveProperty('blobId')
  })

  it('uses the shared media policy for Web OneDrive imports', () => {
    const plan = buildOneDriveImportPlan({
      connectionId: 'onedrive:account-1',
      displayName: 'Videos',
      rootRemoteFolderId: 'remote-folder-1',
      offlinePolicy: 'always-offline',
      existingRootFolderNames: [],
      platform: 'web',
      remoteItems: [
        {
          remoteItemId: 'remote-folder-1',
          parentRemoteItemId: 'root',
          kind: 'folder',
          name: 'Videos',
          deleted: false
        },
        {
          remoteItemId: 'mkv-file',
          parentRemoteItemId: 'remote-folder-1',
          kind: 'file',
          name: 'clip.mkv',
          mimeType: 'video/x-matroska',
          size: 100,
          deleted: false
        },
        {
          remoteItemId: 'avi-file',
          parentRemoteItemId: 'remote-folder-1',
          kind: 'file',
          name: 'legacy.avi',
          mimeType: 'video/x-msvideo',
          size: 100,
          deleted: false
        },
        {
          remoteItemId: 'psd-file',
          parentRemoteItemId: 'remote-folder-1',
          kind: 'file',
          name: 'layout.psd',
          mimeType: 'image/vnd.adobe.photoshop',
          size: 100,
          deleted: false
        },
        {
          remoteItemId: 'system-file',
          parentRemoteItemId: 'remote-folder-1',
          kind: 'file',
          name: '.DS_Store',
          size: 100,
          deleted: false
        }
      ]
    })

    expect(plan.items.map((item) => item.name)).toEqual(['clip.mkv', 'legacy.avi'])
    expect(plan.items.find((item) => item.name === 'layout.psd')).toBeUndefined()
    expect(plan.items.find((item) => item.name === 'clip.mkv')).toMatchObject({
      mimeType: 'video/x-matroska'
    })
    const mkvEntry = plan.syncEntries.find((entry) => entry.remoteItemId === 'mkv-file')
    expect(mkvEntry).toMatchObject({
      itemId: plan.items.find((item) => item.name === 'clip.mkv')?.id,
      status: 'queued'
    })
    expect(mkvEntry).not.toHaveProperty('blobId')
    expect(plan.items.find((item) => item.name === 'legacy.avi')).toMatchObject({
      url: expect.stringMatching(/^unsupported:/)
    })
    expect(plan.syncEntries.find((entry) => entry.remoteItemId === 'avi-file')).toMatchObject({
      status: 'remote-only'
    })
    expect(plan.disabledCount).toBe(1)
  })
})

describe('scanOneDriveFolder', () => {
  it('starts from incremental changes when a cursor is available', async () => {
    const provider = {
      initialScan: vi.fn(),
      incrementalChanges: vi.fn().mockResolvedValueOnce({
        items: [
          {
            remoteItemId: 'file-1',
            parentRemoteItemId: 'folder-1',
            kind: 'file',
            name: 'one.mp4'
          }
        ],
        nextCursor: 'cursor-2',
        hasMore: false
      })
    } as unknown as OneDriveReadonlyProvider

    await expect(
      scanOneDriveFolder(provider, 'connection-1', 'folder-1', 'cursor-1')
    ).resolves.toMatchObject({
      usedCursor: true,
      nextCursor: 'cursor-2',
      remoteItems: [expect.objectContaining({ remoteItemId: 'file-1' })]
    })
    expect(provider.initialScan).not.toHaveBeenCalled()
    expect(provider.incrementalChanges).toHaveBeenCalledWith({
      providerConnectionId: 'connection-1',
      remoteFolderId: 'folder-1',
      cursor: 'cursor-1'
    })
  })

  it('rejects a repeated page cursor instead of looping forever', async () => {
    const provider = {
      initialScan: vi.fn(),
      incrementalChanges: vi
        .fn()
        .mockResolvedValueOnce({
          items: [],
          nextCursor: 'cursor-1',
          hasMore: true
        })
        .mockRejectedValueOnce(new Error('unbounded pagination escaped'))
    } as unknown as OneDriveReadonlyProvider

    await expect(
      scanOneDriveFolder(provider, 'connection-1', 'folder-1', 'cursor-1')
    ).rejects.toThrow('Invalid sync change pagination')
  })
})

describe('refreshOneDriveFolder', () => {
  it('refreshes a persisted OneDrive root with the selected offline policy', async () => {
    const rootFolder = {
      id: 'onedrive-root',
      name: 'OneDrive',
      parentId: FILE_EXPLORER_ROOT_ID,
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'onedrive:account-1',
        remoteFolderId: 'remote-folder-1',
        providerType: 'onedrive' as const,
        offlinePolicy: 'on-demand' as const
      }
    }
    const put = vi.fn(async () => undefined)
    useFileExplorerStore.getState().folders = { [rootFolder.id]: rootFolder }
    settingsMocks.offlinePolicy = 'always-offline'
    vi.mocked(openFileExplorerDB).mockResolvedValue({
      get: vi.fn(async () => rootFolder),
      getAll: vi.fn(async (store: string) => (store === 'folder-records' ? [rootFolder] : [])),
      put,
      transaction: () => ({
        objectStore: () => ({
          delete: vi.fn(async () => undefined),
          get: vi.fn(async () => rootFolder),
          getAll: vi.fn(async () => []),
          put: vi.fn(async () => undefined)
        }),
        done: Promise.resolve()
      })
    } as never)
    providerMocks.initialScan.mockResolvedValueOnce({
      items: [
        {
          remoteItemId: 'remote-folder-1',
          parentRemoteItemId: null,
          kind: 'folder',
          name: 'Selected'
        },
        {
          remoteItemId: 'remote-file-1',
          parentRemoteItemId: 'remote-folder-1',
          kind: 'file',
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: 10
        }
      ],
      nextCursor: 'cursor-1',
      hasMore: false
    })

    await refreshOneDriveFolder(rootFolder.id)

    expect(put).toHaveBeenCalledWith(
      'folder-records',
      expect.objectContaining({
        id: rootFolder.id,
        syncLink: expect.objectContaining({ offlinePolicy: 'always-offline' })
      })
    )
    expect(useFileExplorerStore.getState().folders).toMatchObject({
      [rootFolder.id]: {
        id: rootFolder.id,
        syncLink: { offlinePolicy: 'always-offline' }
      }
    })
    expect(putSyncEntry).toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-file-1', status: 'queued' })
    )
  })

  it('reconciles root A as always-offline without planning or cleaning sibling root B', async () => {
    const { rootA, itemA, itemB } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'on-demand',
      availableA: false
    })
    vi.mocked(getSyncCursor).mockResolvedValueOnce({
      id: 'cursor-record',
      providerConnectionId: 'onedrive:account-1',
      remoteFolderId: 'remote-root-a',
      cursor: 'cursor-1',
      updatedAt: 1
    })
    providerMocks.incrementalChanges.mockResolvedValueOnce({
      items: [],
      nextCursor: 'cursor-2',
      hasMore: false
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootASnapshot())
    providerMocks.downloadContent.mockResolvedValueOnce({
      blobId: itemA.id,
      size: 10,
      mimeType: 'image/jpeg'
    })

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({
      fullScanFallback: true,
      pendingFileCount: 1,
      removedFolderCount: 0,
      removedItemCount: 0
    })
    await vi.waitFor(() => expect(providerMocks.downloadContent).toHaveBeenCalledOnce())
    expect(providerMocks.downloadContent.mock.calls[0]?.[0]).toMatchObject({
      rootRemoteFolderId: 'remote-root-a',
      remoteItemId: 'remote-file-a'
    })
    expect(putSyncTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-root-b' })
    )
    expect(putSyncTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-file-b', blobId: itemB.id })
    )
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
  })

  it.each(['missing', 'expired'] as const)(
    'keeps sibling root B outside a %s-cursor full scan of root A',
    async (cursorState) => {
      const { rootA, itemB } = setupTwoRootRefresh({
        rootAOfflinePolicy: 'always-offline',
        availableA: true
      })
      if (cursorState === 'missing') {
        vi.mocked(getSyncCursor).mockResolvedValueOnce(undefined)
      } else {
        vi.mocked(getSyncCursor).mockResolvedValueOnce({
          id: 'cursor-record',
          providerConnectionId: 'onedrive:account-1',
          remoteFolderId: 'remote-root-a',
          cursor: 'cursor-expired',
          updatedAt: 1
        })
        providerMocks.incrementalChanges.mockRejectedValueOnce(
          Object.assign(new Error('410 expired cursor'), { status: 410 })
        )
      }
      providerMocks.initialScan.mockResolvedValueOnce(rootASnapshot())

      const summary = await refreshOneDriveFolder(rootA.id)

      expect(summary).toMatchObject({
        usedCursor: false,
        removedFolderCount: 0,
        removedItemCount: 0
      })
      expect(providerMocks.initialScan).toHaveBeenCalledOnce()
      expect(putSyncTombstone).not.toHaveBeenCalledWith(
        expect.objectContaining({ remoteItemId: 'remote-root-b' })
      )
      expect(putSyncTombstone).not.toHaveBeenCalledWith(
        expect.objectContaining({ remoteItemId: 'remote-file-b', blobId: itemB.id })
      )
      expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
    }
  )

  it('uses local item ancestry to clean a root A entry with a missing remote parent', async () => {
    const { rootA, itemA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ entries }) => {
        entries.find((entry) => entry.id === 'entry-file-a')!.parentRemoteItemId =
          'missing-remote-parent'
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootAOnlySnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 1 })
    expect(putSyncTombstone).toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-file-a', itemId: itemA.id })
    )
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [itemA.id] })
  })

  it('uses remote ancestry when the local item record is missing', async () => {
    const missingItemId = '55555555-5555-4555-8555-555555555555'
    const { rootA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ entries }) => {
        entries.find((entry) => entry.id === 'entry-file-a')!.itemId = missingItemId
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootAOnlySnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 1 })
    expect(putSyncTombstone).toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-file-a', itemId: missingItemId })
    )
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [missingItemId] })
  })

  it('bounds disconnected remote cycles by local root A ancestry and keeps root B safe', async () => {
    const folderA1: FolderRecord = {
      id: 'onedrive-folder-a-1',
      name: 'Folder A1',
      parentId: 'onedrive-root-a',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'onedrive:account-1',
        remoteFolderId: 'remote-cycle-a',
        providerType: 'onedrive',
        offlinePolicy: 'always-offline'
      }
    }
    const folderA2: FolderRecord = {
      id: 'onedrive-folder-a-2',
      name: 'Folder A2',
      parentId: folderA1.id,
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'onedrive:account-1',
        remoteFolderId: 'remote-cycle-b',
        providerType: 'onedrive',
        offlinePolicy: 'always-offline'
      }
    }
    const { rootA, itemA, itemB } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ itemA, items, folders, entries }) => {
        folders.push(folderA1, folderA2)
        items.find((item) => item.id === itemA.id)!.parentId = folderA1.id
        entries.find((entry) => entry.id === 'entry-file-a')!.parentRemoteItemId = 'remote-cycle-a'
        entries.push(
          {
            id: 'entry-cycle-a',
            providerConnectionId: 'onedrive:account-1',
            remoteItemId: 'remote-cycle-a',
            parentRemoteItemId: 'remote-cycle-b',
            kind: 'folder',
            name: folderA1.name,
            folderId: folderA1.id,
            status: 'available-offline',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'entry-cycle-b',
            providerConnectionId: 'onedrive:account-1',
            remoteItemId: 'remote-cycle-b',
            parentRemoteItemId: 'remote-cycle-a',
            kind: 'folder',
            name: folderA2.name,
            folderId: folderA2.id,
            status: 'available-offline',
            createdAt: 1,
            updatedAt: 1
          }
        )
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootAOnlySnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 2, removedItemCount: 1 })
    expect(cleanupFileResources).toHaveBeenCalledWith({
      folderIds: expect.arrayContaining([folderA1.id, folderA2.id]),
      itemIds: [itemA.id]
    })
    expect(putSyncTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-root-b' })
    )
    expect(putSyncTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-file-b', itemId: itemB.id })
    )
  })

  it('still tombstones and cleans an ordinary root A remote deletion', async () => {
    const { rootA, itemA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootAOnlySnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 1 })
    expect(putSyncTombstone).toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-file-a', itemId: itemA.id })
    )
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [itemA.id] })
  })

  it('protects the selected root from a malformed file entry with a folder reference', async () => {
    const { rootA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ rootA, entries }) => {
        entries.find((entry) => entry.id === 'entry-file-a')!.folderId = rootA.id
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootAOnlySnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalled()
    expect(cleanupFileResources).toHaveBeenCalledOnce()
    const cleanup = vi.mocked(cleanupFileResources).mock.calls[0]![0]
    expect(cleanup).toEqual({ folderIds: [], itemIds: [] })
    expect([...(cleanup.folderIds ?? []), ...(cleanup.itemIds ?? [])]).not.toContain(rootA.id)
    expect(useFileExplorerStore.getState().folders).toHaveProperty(rootA.id)
  })

  it('protects a malformed folder entry carrying an item reference under the selected root', async () => {
    const { rootA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ entries }) => {
        entries.find((entry) => entry.id === 'entry-file-a')!.kind = 'folder'
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootAOnlySnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalled()
    expect(cleanupFileResources).toHaveBeenCalledOnce()
    const cleanup = vi.mocked(cleanupFileResources).mock.calls[0]![0]
    expect(cleanup).toEqual({ folderIds: [], itemIds: [] })
    expect([...(cleanup.folderIds ?? []), ...(cleanup.itemIds ?? [])]).not.toContain(rootA.id)
    expect(useFileExplorerStore.getState().folders).toHaveProperty(rootA.id)
  })

  it('retains the previous cursor when malformed ownership protects removals', async () => {
    const { rootA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ rootA, entries }) => {
        entries.find((entry) => entry.id === 'entry-file-a')!.folderId = rootA.id
      }
    })
    vi.mocked(getSyncCursor).mockResolvedValueOnce({
      id: 'cursor-record',
      providerConnectionId: 'onedrive:account-1',
      remoteFolderId: 'remote-root-a',
      cursor: 'cursor-old',
      updatedAt: 1
    })
    providerMocks.incrementalChanges.mockResolvedValueOnce({
      items: [],
      nextCursor: 'cursor-next',
      hasMore: false
    })

    await refreshOneDriveFolder(rootA.id)

    expect(putSyncCursor).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'file entry with only a folder reference',
      mutate: ({ rootA, entries }: { rootA: FolderRecord; entries: SyncEntryRecord[] }) => {
        const entry = entries.find((candidate) => candidate.id === 'entry-file-a')!
        entry.parentRemoteItemId = 'missing-remote-parent'
        entry.itemId = 'missing-local-item'
        entry.folderId = rootA.id
      },
      deletedKind: 'file' as const
    },
    {
      name: 'folder entry with only an item reference',
      mutate: ({ entries }: { rootA: FolderRecord; entries: SyncEntryRecord[] }) => {
        const entry = entries.find((candidate) => candidate.id === 'entry-file-a')!
        entry.parentRemoteItemId = 'missing-remote-parent'
        entry.kind = 'folder'
        delete entry.folderId
      },
      deletedKind: 'folder' as const
    }
  ])('retains a deletion for replay when a malformed $name identifies root A', async (testCase) => {
    const { rootA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: testCase.mutate
    })
    vi.mocked(getSyncCursor).mockResolvedValueOnce({
      id: 'cursor-record',
      providerConnectionId: 'onedrive:account-1',
      remoteFolderId: 'remote-root-a',
      cursor: 'cursor-old',
      updatedAt: 1
    })
    providerMocks.incrementalChanges.mockResolvedValueOnce({
      items: [
        {
          remoteItemId: 'remote-file-a',
          parentRemoteItemId: 'missing-remote-parent',
          kind: testCase.deletedKind,
          name: 'a.jpg',
          deleted: true
        }
      ],
      nextCursor: 'cursor-next',
      hasMore: false
    })

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalled()
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
    expect(putSyncCursor).not.toHaveBeenCalled()
  })

  it('persists the next cursor after an unprotected refresh', async () => {
    const { rootA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true
    })
    vi.mocked(getSyncCursor).mockResolvedValueOnce({
      id: 'cursor-record',
      providerConnectionId: 'onedrive:account-1',
      remoteFolderId: 'remote-root-a',
      cursor: 'cursor-old',
      updatedAt: 1
    })
    providerMocks.incrementalChanges.mockResolvedValueOnce({
      items: [],
      nextCursor: 'cursor-next',
      hasMore: false
    })

    await refreshOneDriveFolder(rootA.id)

    expect(putSyncCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConnectionId: 'onedrive:account-1',
        remoteFolderId: 'remote-root-a',
        cursor: 'cursor-next'
      })
    )
  })

  it('does not guess remote-A/local-B or unowned malformed entries into root A cleanup', async () => {
    const conflictItemId = '33333333-3333-4333-8333-333333333333'
    const { rootA, itemA, itemB } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ rootB, itemB, items, entries }) => {
        items.push({
          id: conflictItemId,
          name: 'conflict.jpg',
          type: 'file',
          parentId: rootB.id,
          url: `blob:${conflictItemId}`,
          size: 30,
          mimeType: 'image/jpeg',
          sortIndex: 1,
          createdAt: 1,
          expiresAt: null
        })
        entries.push(
          {
            id: 'entry-ambiguous',
            providerConnectionId: 'onedrive:account-1',
            remoteItemId: 'remote-ambiguous',
            parentRemoteItemId: 'remote-root-a',
            kind: 'file',
            name: 'ambiguous.jpg',
            itemId: conflictItemId,
            blobId: conflictItemId,
            mimeType: 'image/jpeg',
            size: 20,
            status: 'available-offline',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'entry-unowned',
            providerConnectionId: 'onedrive:account-1',
            remoteItemId: 'remote-unowned',
            parentRemoteItemId: 'missing-remote-parent',
            kind: 'file',
            name: 'unowned.jpg',
            itemId: 'missing-local-item',
            blobId: itemB.id,
            mimeType: 'image/jpeg',
            size: 20,
            status: 'available-offline',
            createdAt: 1,
            updatedAt: 1
          }
        )
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootASnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-ambiguous', itemId: conflictItemId })
    )
    expect(putSyncTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-unowned', blobId: itemB.id })
    )
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
    expect(useFileExplorerStore.getState().items).toHaveProperty(itemA.id)
    expect(useFileExplorerStore.getState().items).toHaveProperty(itemB.id)
  })

  it('excludes a remote-B/local-A inverse conflict from root A cleanup', async () => {
    const { rootA, itemA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ itemA, entries }) => {
        entries.find((entry) => entry.id === 'entry-file-a')!.itemId =
          '44444444-4444-4444-8444-444444444444'
        entries.find((entry) => entry.id === 'entry-file-b')!.itemId = itemA.id
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootASnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-file-b', itemId: itemA.id })
    )
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
  })

  it('excludes entries that share one local item ID from root cleanup', async () => {
    const { rootA, itemA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ itemA, entries }) => {
        entries.find((entry) => entry.id === 'entry-file-b')!.itemId = itemA.id
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootASnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-file-b', itemId: itemA.id })
    )
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
  })

  it('excludes entries that share one local folder ID from root cleanup', async () => {
    const folderA: FolderRecord = {
      id: 'onedrive-folder-a',
      name: 'Folder A',
      parentId: 'onedrive-root-a',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null
    }
    const { rootA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ folders, entries }) => {
        folders.push(folderA)
        entries.push(
          {
            id: 'entry-folder-a',
            providerConnectionId: 'onedrive:account-1',
            remoteItemId: 'remote-folder-a',
            parentRemoteItemId: 'remote-root-a',
            kind: 'folder',
            name: folderA.name,
            folderId: folderA.id,
            status: 'available-offline',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'entry-folder-b',
            providerConnectionId: 'onedrive:account-1',
            remoteItemId: 'remote-folder-b',
            parentRemoteItemId: 'remote-root-b',
            kind: 'folder',
            name: folderA.name,
            folderId: folderA.id,
            status: 'available-offline',
            createdAt: 1,
            updatedAt: 1
          }
        )
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootASnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ folderId: folderA.id })
    )
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
  })

  it('excludes a remote-B root record that points at the root A folder', async () => {
    const { rootA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ rootA, entries }) => {
        entries.find((entry) => entry.id === 'entry-root-a')!.folderId = 'missing-root-a-local'
        entries.find((entry) => entry.id === 'entry-root-b')!.folderId = rootA.id
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootASnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-root-b', folderId: rootA.id })
    )
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
  })

  it('reserves the selected local root ID for its canonical root entry', async () => {
    const { rootA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ rootA, entries }) => {
        delete entries.find((entry) => entry.id === 'entry-root-a')!.folderId
        entries.push({
          id: 'entry-root-a-collision',
          providerConnectionId: 'onedrive:account-1',
          remoteItemId: 'remote-root-a-collision',
          parentRemoteItemId: 'remote-root-a',
          kind: 'folder',
          name: 'Root A collision',
          folderId: rootA.id,
          status: 'available-offline',
          createdAt: 1,
          updatedAt: 1
        })
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootASnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-root-a-collision', folderId: rootA.id })
    )
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
    expect(useFileExplorerStore.getState().folders).toHaveProperty(rootA.id)
  })

  it('protects a removed folder when its local subtree contains an ambiguous descendant', async () => {
    const folderA: FolderRecord = {
      id: 'onedrive-folder-a',
      name: 'Folder A',
      parentId: 'onedrive-root-a',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null
    }
    const { rootA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ itemA, folders, entries }) => {
        folders.push(folderA)
        itemA.parentId = folderA.id
        entries.find((entry) => entry.id === 'entry-file-a')!.parentRemoteItemId = 'remote-folder-a'
        entries.push(
          {
            id: 'entry-folder-a',
            providerConnectionId: 'onedrive:account-1',
            remoteItemId: 'remote-folder-a',
            parentRemoteItemId: 'remote-root-a',
            kind: 'folder',
            name: folderA.name,
            folderId: folderA.id,
            status: 'available-offline',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'entry-file-a-duplicate',
            providerConnectionId: 'onedrive:account-1',
            remoteItemId: 'remote-file-a-duplicate',
            parentRemoteItemId: 'remote-folder-a',
            kind: 'file',
            name: 'a duplicate.jpg',
            itemId: itemA.id,
            blobId: itemA.id,
            mimeType: 'image/jpeg',
            size: 10,
            status: 'available-offline',
            createdAt: 1,
            updatedAt: 1
          }
        )
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootAOnlySnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-folder-a', folderId: folderA.id })
    )
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
  })

  it('protects descendants of an ambiguous folder entry from partial tombstones', async () => {
    const folderA: FolderRecord = {
      id: 'onedrive-folder-a',
      name: 'Folder A',
      parentId: 'onedrive-root-a',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null
    }
    const { rootA, itemA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ itemA, folders, entries }) => {
        folders.push(folderA)
        itemA.parentId = folderA.id
        entries.find((entry) => entry.id === 'entry-file-a')!.parentRemoteItemId = 'remote-folder-a'
        entries.push(
          {
            id: 'entry-folder-a',
            providerConnectionId: 'onedrive:account-1',
            remoteItemId: 'remote-folder-a',
            parentRemoteItemId: 'remote-root-a',
            kind: 'folder',
            name: folderA.name,
            folderId: folderA.id,
            status: 'available-offline',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'entry-folder-a-duplicate',
            providerConnectionId: 'onedrive:account-1',
            remoteItemId: 'remote-folder-a-duplicate',
            parentRemoteItemId: 'remote-root-a',
            kind: 'folder',
            name: 'Folder A duplicate',
            folderId: folderA.id,
            status: 'available-offline',
            createdAt: 1,
            updatedAt: 1
          }
        )
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootAOnlySnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ remoteItemId: 'remote-file-a', itemId: itemA.id })
    )
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
  })

  it('excludes isolated same-root entries that share one local item ID', async () => {
    const { rootA, itemA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ rootB, itemB, itemA, folders, items, entries }) => {
        folders.splice(folders.indexOf(rootB), 1)
        items.splice(items.indexOf(itemB), 1)
        entries.splice(
          0,
          entries.length,
          ...entries.filter((entry) => entry.id !== 'entry-root-b' && entry.id !== 'entry-file-b')
        )
        entries.push({
          id: 'entry-file-a-duplicate',
          providerConnectionId: 'onedrive:account-1',
          remoteItemId: 'remote-file-a-duplicate',
          parentRemoteItemId: 'remote-root-a',
          kind: 'file',
          name: 'a duplicate.jpg',
          itemId: itemA.id,
          blobId: itemA.id,
          mimeType: 'image/jpeg',
          size: 10,
          status: 'available-offline',
          createdAt: 1,
          updatedAt: 1
        })
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootAOnlySnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalledWith(expect.objectContaining({ itemId: itemA.id }))
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
  })

  it('excludes isolated same-root entries that share one local folder ID', async () => {
    const folderA: FolderRecord = {
      id: 'onedrive-folder-a',
      name: 'Folder A',
      parentId: 'onedrive-root-a',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null
    }
    const { rootA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ rootB, itemA, itemB, folders, items, entries }) => {
        folders.splice(folders.indexOf(rootB), 1)
        folders.push(folderA)
        items.splice(items.indexOf(itemA), 1)
        items.splice(items.indexOf(itemB), 1)
        entries.splice(0, entries.length, ...entries.filter((entry) => entry.id === 'entry-root-a'))
        entries.push(
          {
            id: 'entry-folder-a',
            providerConnectionId: 'onedrive:account-1',
            remoteItemId: 'remote-folder-a',
            parentRemoteItemId: 'remote-root-a',
            kind: 'folder',
            name: folderA.name,
            folderId: folderA.id,
            status: 'available-offline',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'entry-folder-a-duplicate',
            providerConnectionId: 'onedrive:account-1',
            remoteItemId: 'remote-folder-a-duplicate',
            parentRemoteItemId: 'remote-root-a',
            kind: 'folder',
            name: 'Folder A duplicate',
            folderId: folderA.id,
            status: 'available-offline',
            createdAt: 1,
            updatedAt: 1
          }
        )
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootAOnlySnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ folderId: folderA.id })
    )
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
  })

  it('protects a deleted sibling-root item from root A cleanup', async () => {
    const { rootA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ itemB, entries }) => {
        itemB.deletedAt = 2
        entries.find((entry) => entry.id === 'entry-file-a')!.itemId = itemB.id
        entries.find((entry) => entry.id === 'entry-file-b')!.itemId = 'missing-local-b'
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootAOnlySnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalled()
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
    expect(putSyncCursor).not.toHaveBeenCalled()
  })

  it('protects a deleted sibling-root folder from root A cleanup', async () => {
    const deletedFolder: FolderRecord = {
      id: 'deleted-folder-b',
      name: 'Deleted folder B',
      parentId: 'onedrive-root-b',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      deletedAt: 2
    }
    const { rootA } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ folders, entries }) => {
        folders.push(deletedFolder)
        entries.push({
          id: 'entry-deleted-folder',
          providerConnectionId: 'onedrive:account-1',
          remoteItemId: 'remote-deleted-folder',
          parentRemoteItemId: 'remote-root-a',
          kind: 'folder',
          name: deletedFolder.name,
          folderId: deletedFolder.id,
          status: 'available-offline',
          createdAt: 1,
          updatedAt: 1
        })
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootASnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalled()
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
    expect(putSyncCursor).not.toHaveBeenCalled()
  })

  it('protects a deleted sibling OneDrive root boundary from root A cleanup', async () => {
    const { rootA, rootB } = setupTwoRootRefresh({
      rootAOfflinePolicy: 'always-offline',
      availableA: true,
      mutate: ({ rootB, entries }) => {
        rootB.deletedAt = 2
        entries.find((entry) => entry.id === 'entry-root-b')!.parentRemoteItemId = 'remote-root-a'
      }
    })
    providerMocks.initialScan.mockResolvedValueOnce(rootASnapshot())

    const summary = await refreshOneDriveFolder(rootA.id)

    expect(summary).toMatchObject({ removedFolderCount: 0, removedItemCount: 0 })
    expect(putSyncTombstone).not.toHaveBeenCalled()
    expect(cleanupFileResources).toHaveBeenCalledWith({ folderIds: [], itemIds: [] })
    expect(useFileExplorerStore.getState().folders).toHaveProperty(rootB.id)
    expect(putSyncCursor).not.toHaveBeenCalled()
  })

  it('does not publish a deferred scan after its root was unlinked', async () => {
    const { rootA } = setupTwoRootRefresh({ rootAOfflinePolicy: 'on-demand', availableA: false })
    const scan = deferred<SyncChangePage>()
    providerMocks.initialScan.mockReturnValueOnce(scan.promise)
    const refreshing = refreshOneDriveFolder(rootA.id)
    const outcome = refreshing.then(
      () => 'resolved',
      () => 'rejected'
    )
    await vi.waitFor(() => expect(providerMocks.initialScan).toHaveBeenCalled())
    const db = await openFileExplorerDB()
    vi.mocked(db.getAll).mockResolvedValue([])
    vi.mocked(db.get).mockResolvedValue(undefined)
    scan.resolve(rootASnapshot())
    expect(await outcome).toBe('rejected')
    expect(putSyncEntry).not.toHaveBeenCalled()
    expect(putSyncCursor).not.toHaveBeenCalled()
    expect(providerMocks.downloadContent).not.toHaveBeenCalled()
  })

  it('coalesces concurrent refreshes for the same root folder', async () => {
    const scan = deferred<SyncChangePage>()
    const rootFolder = {
      id: 'onedrive-root',
      name: 'OneDrive',
      parentId: FILE_EXPLORER_ROOT_ID,
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'onedrive:account-1',
        remoteFolderId: 'remote-folder-1',
        providerType: 'onedrive' as const,
        offlinePolicy: 'always-offline' as const
      }
    }
    vi.mocked(openFileExplorerDB).mockResolvedValue({
      get: vi.fn(async () => rootFolder),
      getAll: vi.fn(async (store: string) => {
        if (store === 'folder-records') return [rootFolder]
        return []
      }),
      transaction: () => ({
        objectStore: () => ({
          delete: vi.fn(async () => undefined),
          get: vi.fn(async () => rootFolder),
          getAll: vi.fn(async () => []),
          put: vi.fn(async () => undefined)
        }),
        done: Promise.resolve()
      })
    } as never)
    providerMocks.initialScan.mockReturnValue(scan.promise)
    providerMocks.downloadContent.mockResolvedValue({
      blobId: 'local-file-1',
      size: 10,
      mimeType: 'image/jpeg'
    })

    const first = refreshOneDriveFolder('onedrive-root')
    const second = refreshOneDriveFolder('onedrive-root')

    await vi.waitFor(() => expect(providerMocks.initialScan).toHaveBeenCalled())
    expect(providerMocks.initialScan).toHaveBeenCalledTimes(1)

    scan.resolve({
      items: [
        {
          remoteItemId: 'remote-folder-1',
          parentRemoteItemId: null,
          kind: 'folder',
          name: 'Selected'
        },
        {
          remoteItemId: 'remote-file-1',
          parentRemoteItemId: 'remote-folder-1',
          kind: 'file',
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: 10
        }
      ],
      nextCursor: 'cursor-1',
      hasMore: false
    })
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    await vi.waitFor(() => expect(providerMocks.downloadContent).toHaveBeenCalledOnce())
    expect(providerMocks.downloadContent.mock.calls[0]?.[0]).toMatchObject({
      rootRemoteFolderId: 'remote-folder-1'
    })
  })
})

describe('OneDrive production download roots', () => {
  it('uses the selected sync root for presentation downloads', async () => {
    useFileExplorerStore.getState().folders = {
      'selected-root': {
        id: 'selected-root',
        name: 'Selected',
        parentId: 'root',
        sortIndex: 0,
        createdAt: 1,
        expiresAt: null,
        syncLink: {
          providerConnectionId: 'onedrive:account-1',
          remoteFolderId: 'remote-selected-root',
          providerType: 'onedrive'
        }
      }
    }
    vi.mocked(getSyncEntryByLocalItem).mockResolvedValueOnce({
      id: 'entry-1',
      providerConnectionId: 'onedrive:account-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: 'remote-selected-root',
      kind: 'file',
      name: 'photo.jpg',
      itemId: 'item-1',
      status: 'remote-only',
      createdAt: 1,
      updatedAt: 1
    })
    providerMocks.downloadContent.mockResolvedValueOnce({
      blobId: 'item-1',
      size: 10,
      mimeType: 'image/jpeg'
    })

    await ensureOneDriveItemAvailableForPresentation({
      id: 'item-1',
      name: 'photo.jpg',
      type: 'file',
      parentId: 'selected-root',
      url: '',
      size: 10,
      mimeType: 'image/jpeg',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null
    })

    expect(providerMocks.downloadContent.mock.calls[0]?.[0]).toMatchObject({
      rootRemoteFolderId: 'remote-selected-root'
    })
  })
})

describe('importOneDriveFolder', () => {
  it('does not publish catalog records when the import transaction fails', async () => {
    vi.mocked(listProviderConnectionsByType).mockResolvedValueOnce([
      {
        id: 'onedrive:account-1',
        providerType: 'onedrive',
        displayName: 'OneDrive - Alice',
        createdAt: 1,
        updatedAt: 1
      }
    ])
    providerMocks.initialScan.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      hasMore: false
    })
    vi.mocked(openFileExplorerDB).mockResolvedValueOnce({
      transaction: () => ({
        objectStore: () => ({ put: vi.fn(async () => undefined) }),
        done: Promise.reject(new Error('Transaction aborted'))
      })
    } as never)
    const before = useFileExplorerStore.getState()
    await expect(
      importOneDriveFolder({
        remoteItemId: 'remote-folder-1',
        parentRemoteItemId: null,
        name: 'Media'
      })
    ).rejects.toThrow('Transaction aborted')
    const after = useFileExplorerStore.getState()
    expect(after.folders).toBe(before.folders)
    expect(after.items).toBe(before.items)
    expect(after._childFoldersByParent).toBe(before._childFoldersByParent)
    expect(after.loadedParents).toBe(before.loadedParents)
  })

  it('returns after linking the folder without waiting for background downloads', async () => {
    vi.mocked(listProviderConnectionsByType).mockResolvedValueOnce([
      {
        id: 'onedrive:account-1',
        providerType: 'onedrive',
        displayName: 'OneDrive - Alice',
        createdAt: 1,
        updatedAt: 1
      }
    ])
    providerMocks.initialScan.mockResolvedValueOnce({
      items: [
        {
          remoteItemId: 'remote-folder-1',
          parentRemoteItemId: 'root',
          kind: 'folder',
          name: 'Media',
          deleted: false
        },
        {
          remoteItemId: 'file-1',
          parentRemoteItemId: 'remote-folder-1',
          kind: 'file',
          name: 'one.png',
          mimeType: 'image/png',
          size: 100,
          deleted: false
        }
      ],
      nextCursor: 'cursor-1',
      hasMore: false
    })
    const download = deferred<{ blobId: string; size: number; mimeType: string }>()
    providerMocks.downloadContent.mockReturnValue(download.promise)

    const result = await importOneDriveFolder({
      remoteItemId: 'remote-folder-1',
      parentRemoteItemId: null,
      name: 'Media'
    })

    expect(result).toMatchObject({ itemCount: 1, downloadedCount: 0 })
    await vi.waitFor(() => expect(providerMocks.downloadContent).toHaveBeenCalledTimes(1))
    expect(providerMocks.downloadContent.mock.calls[0]?.[0]).toMatchObject({
      rootRemoteFolderId: 'remote-folder-1'
    })

    download.resolve({ blobId: 'file-1', size: 100, mimeType: 'image/png' })
    await vi.waitFor(() => expect(refreshImportedMediaAssets).toHaveBeenCalledTimes(1))
  })

  it('refreshes media assets after each downloaded file', async () => {
    vi.mocked(listProviderConnectionsByType).mockResolvedValueOnce([
      {
        id: 'onedrive:account-1',
        providerType: 'onedrive',
        displayName: 'OneDrive - Alice',
        createdAt: 1,
        updatedAt: 1
      }
    ])
    providerMocks.initialScan.mockResolvedValueOnce({
      items: [
        {
          remoteItemId: 'remote-folder-1',
          parentRemoteItemId: 'root',
          kind: 'folder',
          name: 'Media',
          deleted: false
        },
        {
          remoteItemId: 'file-1',
          parentRemoteItemId: 'remote-folder-1',
          kind: 'file',
          name: 'one.png',
          mimeType: 'image/png',
          size: 100,
          deleted: false
        },
        {
          remoteItemId: 'file-2',
          parentRemoteItemId: 'remote-folder-1',
          kind: 'file',
          name: 'two.png',
          mimeType: 'image/png',
          size: 100,
          deleted: false
        }
      ],
      nextCursor: 'cursor-1',
      hasMore: false
    })
    providerMocks.downloadContent.mockResolvedValue({
      blobId: 'blob-1',
      size: 100,
      mimeType: 'image/png'
    })

    await importOneDriveFolder({
      remoteItemId: 'remote-folder-1',
      parentRemoteItemId: null,
      name: 'Media'
    })

    await vi.waitFor(() => expect(refreshImportedMediaAssets).toHaveBeenCalledTimes(2))
    expect(
      providerMocks.downloadContent.mock.calls.map(([request]) => request.remoteItemId)
    ).toEqual(['file-1', 'file-2'])
    expect(
      vi
        .mocked(refreshImportedMediaAssets)
        .mock.calls.map(([items]) => items.map((item) => item.name))
    ).toEqual([['one.png'], ['two.png']])
  })
})

describe('loginOneDriveAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providerMocks.connect.mockResolvedValue({
      id: 'onedrive:account-1',
      providerType: 'onedrive',
      displayName: 'OneDrive - Alice',
      accountLabel: 'alice@example.com'
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        oneDrive: {
          deleteCredentials: vi.fn(async () => undefined),
          getAuthRedirectUri: vi.fn(async () => 'hhc-presenter://auth/onedrive'),
          waitAuthCallback: vi.fn(
            async () => 'hhc-presenter://auth/onedrive?code=code-1&state=state-1'
          ),
          completeAuth: vi.fn(async () => ({
            id: 'onedrive:account-1',
            providerType: 'onedrive',
            displayName: 'OneDrive - Alice',
            accountLabel: 'alice@example.com'
          }))
        }
      }
    })
    window.open = vi.fn()
    window.prompt = vi.fn()
    global.fetch = vi.fn(async () =>
      Response.json({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        token_type: 'Bearer'
      })
    )
  })

  it('uses a custom protocol callback for the default Electron flow', async () => {
    await expect(loginOneDriveAccount()).resolves.toMatchObject({ id: 'onedrive:account-1' })

    expect(window.api.oneDrive.getAuthRedirectUri).toHaveBeenCalled()
    expect(window.open).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      '_blank',
      'noopener,noreferrer'
    )
    expect(window.api.oneDrive.waitAuthCallback).toHaveBeenCalledWith('state-1')
    expect(window.api.oneDrive.completeAuth).toHaveBeenCalledWith({
      clientId: '11111111-2222-3333-4444-555555555555',
      redirectUri: 'hhc-presenter://auth/onedrive',
      code: 'code-1',
      codeVerifier: 'verifier-1'
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('supports Web login with the same callback flow', async () => {
    const { isElectron } = await import('../env')
    vi.mocked(isElectron).mockReturnValue(false)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: undefined
    })
    const callbackUrl = `${window.location.origin}/onedrive-callback.html?code=code-1&state=state-1`

    await expect(
      loginOneDriveAccount({
        requestCallbackUrl: vi.fn(async () => callbackUrl)
      })
    ).resolves.toMatchObject({ id: 'onedrive:account-1' })
  })

  it('opens Web OAuth with an opener so the callback page can notify the app', async () => {
    const { isElectron } = await import('../env')
    vi.mocked(isElectron).mockReturnValue(false)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: undefined
    })
    const callbackUrl = `${window.location.origin}/onedrive-callback.html?code=code-1&state=state-1`

    await loginOneDriveAccount({
      requestCallbackUrl: vi.fn(async () => callbackUrl)
    })

    expect(window.open).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      '_blank',
      'popup,width=520,height=720'
    )
  })

  it('unblocks Web login when no OAuth callback arrives', async () => {
    vi.useFakeTimers()
    const { isElectron } = await import('../env')
    vi.mocked(isElectron).mockReturnValue(false)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: undefined
    })
    const popup = {
      get closed(): boolean {
        throw new Error('window.closed should not be read for Web OAuth popups')
      }
    } as Window
    window.open = vi.fn(() => popup)

    const login = loginOneDriveAccount()
    await vi.advanceTimersByTimeAsync(2 * 60_000)

    await expect(login).resolves.toBeNull()
    vi.useRealTimers()
  })

  it('unblocks Web login when the OAuth popup cannot be opened', async () => {
    const { isElectron } = await import('../env')
    vi.mocked(isElectron).mockReturnValue(false)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: undefined
    })
    window.open = vi.fn(() => null)

    await expect(loginOneDriveAccount()).resolves.toBeNull()
  })
})
