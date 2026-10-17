import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import {
  convertSyncConnectionToNormalFolder,
  recoverPendingSyncResourceCleanups,
  unlinkHhcLineAccountFromApp,
  unlinkSyncConnectionFromApp,
  unlinkSyncRootFolderFromApp
} from '../sync-unlink'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import {
  getProviderConnection,
  getSyncCursor,
  getSyncEntryByRemoteItem,
  getSyncEntryPreference,
  listSyncEntriesByProviderConnection,
  listSyncTombstones,
  putProviderConnection,
  putSyncCursor,
  putSyncEntry,
  putSyncEntryPreference,
  putSyncTombstone,
  resetSyncDBForTests,
  SYNC_CONNECTION_UNLINK_MARKER
} from '../sync-db'

const { mockCleanupFileResources, mockListFileResourceCleanupItemIds } = vi.hoisted(() => ({
  mockCleanupFileResources: vi.fn(),
  mockListFileResourceCleanupItemIds: vi.fn()
}))

const { mockCancelSyncDownloadsAndWait } = vi.hoisted(() => ({
  mockCancelSyncDownloadsAndWait: vi.fn()
}))

const { mockCancelVideoPosterJobsAndWait } = vi.hoisted(() => ({
  mockCancelVideoPosterJobsAndWait: vi.fn()
}))

const { mockDeleteSyncEntryPreferences, mockDeleteSyncEntryPreferencesByProviderConnection } =
  vi.hoisted(() => ({
    mockDeleteSyncEntryPreferences: vi.fn(),
    mockDeleteSyncEntryPreferencesByProviderConnection: vi.fn()
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

vi.mock('../file-resource-cleanup', () => ({
  cleanupFileResources: mockCleanupFileResources,
  listFileResourceCleanupItemIds: mockListFileResourceCleanupItemIds
}))

vi.mock('../sync-download-queue', () => ({
  cancelSyncDownloadsAndWait: mockCancelSyncDownloadsAndWait
}))

vi.mock('../video-poster-jobs', () => ({
  cancelVideoPosterJobsAndWait: mockCancelVideoPosterJobsAndWait,
  fenceVideoPosterScope: vi.fn(() => vi.fn())
}))

vi.mock('../sync-db', async () => {
  const actual = await vi.importActual<typeof import('../sync-db')>('../sync-db')
  mockDeleteSyncEntryPreferences.mockImplementation(actual.deleteSyncEntryPreferences)
  mockDeleteSyncEntryPreferencesByProviderConnection.mockImplementation(
    actual.deleteSyncEntryPreferencesByProviderConnection
  )
  return {
    ...actual,
    deleteSyncEntryPreferences: mockDeleteSyncEntryPreferences,
    deleteSyncEntryPreferencesByProviderConnection:
      mockDeleteSyncEntryPreferencesByProviderConnection
  }
})

describe('sync unlink', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await resetSyncDBForTests()
    await resetFileExplorerDBForTests()
    mockCleanupFileResources.mockResolvedValue({
      folderIds: ['folder-1'],
      itemIds: ['item-1']
    })
    mockListFileResourceCleanupItemIds.mockImplementation(async (request) => request.itemIds ?? [])
    mockCancelSyncDownloadsAndWait.mockResolvedValue(0)
    mockCancelVideoPosterJobsAndWait.mockResolvedValue(0)
  })

  it('waits for active downloads before cleaning a connection', async () => {
    let resolveCancelled!: () => void
    mockCancelSyncDownloadsAndWait.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        resolveCancelled = () => resolve(1)
      })
    )

    const cleanup = unlinkSyncConnectionFromApp('connection-1')
    await vi.waitFor(() => expect(mockCancelSyncDownloadsAndWait).toHaveBeenCalled())
    expect(mockCleanupFileResources).not.toHaveBeenCalled()

    resolveCancelled()
    await cleanup
    expect(mockCleanupFileResources).toHaveBeenCalledOnce()
  })

  it('removes a sync connection from the app through tombstones and resource cleanup', async () => {
    await putProviderConnection({
      id: 'connection-1',
      providerType: 'onedrive',
      displayName: 'OneDrive'
    })
    await putSyncCursor({
      providerConnectionId: 'connection-1',
      remoteFolderId: 'root',
      cursor: 'cursor-1',
      updatedAt: 1
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-folder-1',
      parentRemoteItemId: null,
      kind: 'folder',
      name: 'Media',
      folderId: 'folder-1',
      status: 'available-offline'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: 'remote-folder-1',
      kind: 'file',
      name: 'clip.mp4',
      itemId: 'item-1',
      blobId: 'blob-1',
      mimeType: 'video/mp4',
      status: 'available-offline'
    })
    await putSyncEntryPreference({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      offlinePolicyOverride: 'always-offline'
    })
    await (
      await openFileExplorerDB()
    ).put('folder-records', {
      id: 'folder-1',
      name: 'Media',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'connection-1',
        providerType: 'onedrive',
        remoteFolderId: 'remote-folder-1',
        offlinePolicy: 'always-offline'
      }
    })
    mockListFileResourceCleanupItemIds.mockResolvedValueOnce(['item-1'])

    const result = await unlinkSyncConnectionFromApp('connection-1')

    expect(mockCleanupFileResources).toHaveBeenCalledWith({
      folderIds: ['folder-1'],
      itemIds: []
    })
    expect(result).toEqual({
      folderIds: ['folder-1'],
      itemIds: ['item-1'],
      tombstoneCount: 2
    })
    await expect(getProviderConnection('connection-1')).resolves.toBeUndefined()
    await expect(getSyncCursor('connection-1', 'root')).resolves.toBeUndefined()
    await expect(getSyncEntryByRemoteItem('connection-1', 'remote-file-1')).resolves.toBeUndefined()
    await expect(getSyncEntryPreference('connection-1', 'remote-file-1')).resolves.toBeUndefined()
    await expect(listSyncTombstones()).resolves.toEqual([])
    expect(mockCancelSyncDownloadsAndWait).toHaveBeenCalledWith({
      providerConnectionId: 'connection-1'
    })
  })

  it('keeps connection cleanup fences when metadata deletion fails and completes on retry', async () => {
    await putProviderConnection({
      id: 'connection-1',
      providerType: 'onedrive',
      displayName: 'OneDrive'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'clip.mp4',
      itemId: 'item-1',
      blobId: 'blob-1',
      status: 'available-offline'
    })
    await putSyncEntryPreference({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      offlinePolicyOverride: 'always-offline'
    })
    mockDeleteSyncEntryPreferencesByProviderConnection.mockRejectedValueOnce(
      new Error('metadata delete failed')
    )

    await expect(unlinkSyncConnectionFromApp('connection-1')).rejects.toThrow(
      'metadata delete failed'
    )

    await expect(getProviderConnection('connection-1')).resolves.toBeDefined()
    await expect(listSyncEntriesByProviderConnection('connection-1')).resolves.toHaveLength(1)
    await expect(listSyncTombstones()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerConnectionId: 'connection-1',
          remoteItemId: 'remote-file-1',
          reason: 'unlink'
        }),
        expect.objectContaining({
          providerConnectionId: 'connection-1',
          remoteItemId: SYNC_CONNECTION_UNLINK_MARKER,
          reason: 'unlink'
        })
      ])
    )

    await unlinkSyncConnectionFromApp('connection-1')

    await expect(getProviderConnection('connection-1')).resolves.toBeUndefined()
    await expect(listSyncTombstones()).resolves.toEqual([])
  })

  it('includes linked orphan roots in connection cleanup when their sync entry is missing', async () => {
    await (
      await openFileExplorerDB()
    ).put('folder-records', {
      id: 'orphan-root',
      name: 'Orphan',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'connection-1',
        providerType: 'local-fs',
        remoteFolderId: '.',
        offlinePolicy: 'always-offline'
      }
    })
    mockListFileResourceCleanupItemIds.mockResolvedValueOnce(['orphan-item'])

    await unlinkSyncConnectionFromApp('connection-1')

    expect(mockListFileResourceCleanupItemIds).toHaveBeenCalledWith({
      folderIds: ['orphan-root'],
      itemIds: []
    })
    expect(mockCancelVideoPosterJobsAndWait).toHaveBeenCalledWith(['orphan-item'])
  })

  it('disconnects one OneDrive mounted folder without removing the account connection', async () => {
    await putProviderConnection({
      id: 'connection-1',
      providerType: 'onedrive',
      displayName: 'OneDrive'
    })
    await putSyncCursor({
      providerConnectionId: 'connection-1',
      remoteFolderId: 'root-a',
      cursor: 'cursor-a',
      updatedAt: 1
    })
    await putSyncCursor({
      providerConnectionId: 'connection-1',
      remoteFolderId: 'root-b',
      cursor: 'cursor-b',
      updatedAt: 1
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'root-a',
      parentRemoteItemId: null,
      kind: 'folder',
      name: 'A',
      folderId: 'folder-a',
      status: 'remote-only'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'child-a',
      parentRemoteItemId: 'root-a',
      kind: 'folder',
      name: 'Child',
      folderId: 'folder-child-a',
      status: 'remote-only'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'file-a',
      parentRemoteItemId: 'child-a',
      kind: 'file',
      name: 'clip.mp4',
      itemId: 'item-a',
      blobId: 'item-a',
      mimeType: 'video/mp4',
      status: 'available-offline'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'root-b',
      parentRemoteItemId: null,
      kind: 'folder',
      name: 'B',
      folderId: 'folder-b',
      status: 'remote-only'
    })
    await putSyncTombstone({
      providerConnectionId: 'connection-1',
      remoteItemId: 'root-a',
      folderId: 'folder-a',
      reason: 'remote-delete'
    })
    await putSyncTombstone({
      providerConnectionId: 'connection-1',
      remoteItemId: 'root-b',
      folderId: 'folder-b',
      reason: 'remote-delete'
    })

    await unlinkSyncRootFolderFromApp({
      id: 'folder-a',
      name: 'A',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'connection-1',
        remoteFolderId: 'root-a',
        providerType: 'onedrive'
      }
    })

    expect(mockCleanupFileResources).toHaveBeenCalledWith({
      folderIds: ['folder-a'],
      itemIds: []
    })
    expect(mockCancelSyncDownloadsAndWait).toHaveBeenCalledWith({
      providerConnectionId: 'connection-1',
      rootRemoteFolderId: 'root-a'
    })
    await expect(getProviderConnection('connection-1')).resolves.toBeDefined()
    await expect(getSyncCursor('connection-1', 'root-a')).resolves.toBeUndefined()
    await expect(getSyncCursor('connection-1', 'root-b')).resolves.toBeDefined()
    await expect(getSyncEntryByRemoteItem('connection-1', 'root-a')).resolves.toBeUndefined()
    await expect(getSyncEntryByRemoteItem('connection-1', 'root-b')).resolves.toBeDefined()
    await expect(listSyncTombstones()).resolves.toEqual([
      expect.objectContaining({
        providerConnectionId: 'connection-1',
        remoteItemId: 'root-b'
      })
    ])
  })

  it('fences and waits for root poster jobs before resource cleanup', async () => {
    await putSyncEntry({
      providerConnectionId: 'hhc-line:user-a',
      remoteItemId: 'collection-a',
      parentRemoteItemId: null,
      kind: 'folder',
      name: 'Collection A',
      folderId: 'folder-a',
      status: 'remote-only'
    })
    await putSyncEntry({
      providerConnectionId: 'hhc-line:user-a',
      remoteItemId: 'video-a',
      parentRemoteItemId: 'collection-a',
      kind: 'file',
      name: 'video.mp4',
      itemId: 'item-a',
      blobId: 'blob-a',
      mimeType: 'video/mp4',
      status: 'available-offline'
    })
    let releasePosters = (): void => undefined
    mockListFileResourceCleanupItemIds.mockResolvedValueOnce(['item-a'])
    mockCancelVideoPosterJobsAndWait.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          releasePosters = () => resolve(1)
        })
    )
    const unlink = unlinkSyncRootFolderFromApp({
      id: 'folder-a',
      name: 'Collection A',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'hhc-line:user-a',
        remoteFolderId: 'collection-a',
        providerType: 'hhc-line'
      }
    })

    await vi.waitFor(() =>
      expect(mockCancelVideoPosterJobsAndWait).toHaveBeenCalledWith(['item-a'])
    )
    await expect(listSyncTombstones()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ remoteItemId: 'collection-a', reason: 'unlink' })
      ])
    )
    expect(mockCleanupFileResources).not.toHaveBeenCalled()

    releasePosters()
    await unlink
    expect(mockCleanupFileResources).toHaveBeenCalledOnce()
  })

  it('waits for orphan descendant posters in the authoritative cleanup closure', async () => {
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'root-a',
      parentRemoteItemId: null,
      kind: 'folder',
      name: 'A',
      folderId: 'folder-a',
      status: 'remote-only'
    })
    mockListFileResourceCleanupItemIds.mockResolvedValueOnce(['orphan-item'])

    await unlinkSyncRootFolderFromApp({
      id: 'folder-a',
      name: 'A',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'connection-1',
        remoteFolderId: 'root-a',
        providerType: 'onedrive'
      }
    })

    expect(mockListFileResourceCleanupItemIds).toHaveBeenCalledWith({
      folderIds: ['folder-a'],
      itemIds: []
    })
    expect(mockCancelVideoPosterJobsAndWait).toHaveBeenCalledWith(['orphan-item'])
  })

  it('does not trust cross-root local references from root sync entries', async () => {
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'root-a',
      parentRemoteItemId: null,
      kind: 'folder',
      name: 'A',
      folderId: 'folder-b',
      status: 'remote-only'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'file-a',
      parentRemoteItemId: 'root-a',
      kind: 'file',
      name: 'A.mp4',
      itemId: 'item-b',
      status: 'available-offline'
    })

    await unlinkSyncRootFolderFromApp({
      id: 'folder-a',
      name: 'A',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'connection-1',
        remoteFolderId: 'root-a',
        providerType: 'onedrive'
      }
    })

    expect(mockListFileResourceCleanupItemIds).toHaveBeenCalledWith({
      folderIds: ['folder-a'],
      itemIds: []
    })
    expect(mockCleanupFileResources).toHaveBeenCalledWith({
      folderIds: ['folder-a'],
      itemIds: []
    })
  })

  it('persists an explicit HHC root fence when the canonical root entry is missing', async () => {
    await putSyncEntry({
      providerConnectionId: 'hhc-line:user-a',
      remoteItemId: 'video-a',
      parentRemoteItemId: 'collection-a',
      kind: 'file',
      name: 'video.mp4',
      itemId: 'item-a',
      status: 'available-offline'
    })
    mockCancelVideoPosterJobsAndWait.mockImplementationOnce(async () => {
      await expect(listSyncTombstones()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerConnectionId: 'hhc-line:user-a',
            remoteItemId: 'collection-a',
            folderId: 'folder-a',
            reason: 'unlink'
          })
        ])
      )
      return 0
    })

    await unlinkSyncRootFolderFromApp({
      id: 'folder-a',
      name: 'A',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'hhc-line:user-a',
        remoteFolderId: 'collection-a',
        providerType: 'hhc-line'
      }
    })

    expect(mockCancelVideoPosterJobsAndWait).toHaveBeenCalled()
    await expect(listSyncTombstones()).resolves.toEqual([])
  })

  it('keeps root cleanup fences when metadata deletion fails and completes on retry', async () => {
    await putProviderConnection({
      id: 'connection-1',
      providerType: 'onedrive',
      displayName: 'OneDrive'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'root-a',
      parentRemoteItemId: null,
      kind: 'folder',
      name: 'A',
      folderId: 'folder-a',
      status: 'remote-only'
    })
    await putSyncEntryPreference({
      providerConnectionId: 'connection-1',
      remoteItemId: 'root-a',
      offlinePolicyOverride: 'always-offline'
    })
    const rootFolder: FolderRecord = {
      id: 'folder-a',
      name: 'A',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'connection-1',
        remoteFolderId: 'root-a',
        providerType: 'onedrive'
      }
    }
    mockDeleteSyncEntryPreferences.mockRejectedValueOnce(new Error('metadata delete failed'))

    await expect(unlinkSyncRootFolderFromApp(rootFolder)).rejects.toThrow('metadata delete failed')

    await expect(getProviderConnection('connection-1')).resolves.toBeDefined()
    await expect(getSyncEntryByRemoteItem('connection-1', 'root-a')).resolves.toBeDefined()
    await expect(listSyncTombstones()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerConnectionId: 'connection-1',
          remoteItemId: 'root-a',
          folderId: 'folder-a',
          unlinkScope: 'root',
          reason: 'unlink'
        })
      ])
    )

    await unlinkSyncRootFolderFromApp(rootFolder)

    await expect(getProviderConnection('connection-1')).resolves.toBeDefined()
    await expect(getSyncEntryByRemoteItem('connection-1', 'root-a')).resolves.toBeUndefined()
    await expect(listSyncTombstones()).resolves.toEqual([])
  })

  it('purges every HHC LINE root for one account without touching other providers or accounts', async () => {
    await Promise.all([
      putProviderConnection({
        id: 'hhc-line:user-a',
        providerType: 'hhc-line',
        displayName: 'User A',
        accountUserId: 'user-a'
      }),
      putProviderConnection({
        id: 'hhc-line:user-b',
        providerType: 'hhc-line',
        displayName: 'User B',
        accountUserId: 'user-b'
      }),
      putProviderConnection({
        id: 'onedrive:user-a',
        providerType: 'onedrive',
        displayName: 'OneDrive',
        accountUserId: 'user-a'
      })
    ])
    await Promise.all([
      putSyncCursor({
        providerConnectionId: 'hhc-line:user-a',
        remoteFolderId: 'collection-a-1',
        cursor: 'cursor-a-1',
        updatedAt: 1
      }),
      putSyncCursor({
        providerConnectionId: 'hhc-line:user-a',
        remoteFolderId: 'collection-a-2',
        cursor: 'cursor-a-2',
        updatedAt: 1
      }),
      putSyncCursor({
        providerConnectionId: 'hhc-line:user-b',
        remoteFolderId: 'collection-b',
        cursor: 'cursor-b',
        updatedAt: 1
      })
    ])
    await Promise.all([
      putSyncEntry({
        providerConnectionId: 'hhc-line:user-a',
        remoteItemId: 'collection-a-1',
        parentRemoteItemId: null,
        kind: 'folder',
        name: 'A1',
        folderId: 'folder-a-1',
        status: 'remote-only'
      }),
      putSyncEntry({
        providerConnectionId: 'hhc-line:user-a',
        remoteItemId: 'collection-a-2',
        parentRemoteItemId: null,
        kind: 'folder',
        name: 'A2',
        folderId: 'folder-a-2',
        status: 'remote-only'
      }),
      putSyncEntry({
        providerConnectionId: 'hhc-line:user-b',
        remoteItemId: 'collection-b',
        parentRemoteItemId: null,
        kind: 'folder',
        name: 'B',
        folderId: 'folder-b',
        status: 'remote-only'
      }),
      putSyncEntry({
        providerConnectionId: 'onedrive:user-a',
        remoteItemId: 'onedrive-root',
        parentRemoteItemId: null,
        kind: 'folder',
        name: 'OneDrive',
        folderId: 'folder-onedrive',
        status: 'remote-only'
      })
    ])
    await Promise.all([
      putSyncEntryPreference({
        providerConnectionId: 'hhc-line:user-a',
        remoteItemId: 'collection-a-1',
        offlinePolicyOverride: 'always-offline'
      }),
      putSyncEntryPreference({
        providerConnectionId: 'hhc-line:user-b',
        remoteItemId: 'collection-b',
        offlinePolicyOverride: 'always-offline'
      }),
      putSyncTombstone({
        providerConnectionId: 'hhc-line:user-a',
        remoteItemId: 'old-a',
        itemId: 'orphan-item-a',
        blobId: 'orphan-blob-a',
        reason: 'remote-delete'
      }),
      putSyncTombstone({
        providerConnectionId: 'hhc-line:user-b',
        remoteItemId: 'old-b',
        reason: 'remote-delete'
      })
    ])
    const db = await openFileExplorerDB()
    await Promise.all(
      [
        ['folder-a-1', 'collection-a-1'],
        ['folder-a-2', 'collection-a-2']
      ].map(([id, remoteFolderId]) =>
        db.put('folder-records', {
          id,
          name: id,
          parentId: 'file-root',
          sortIndex: 0,
          createdAt: 1,
          expiresAt: null,
          syncLink: {
            providerConnectionId: 'hhc-line:user-a',
            providerType: 'hhc-line',
            remoteFolderId,
            offlinePolicy: 'always-offline'
          }
        })
      )
    )

    await unlinkHhcLineAccountFromApp('user-a')

    expect(mockCancelSyncDownloadsAndWait).toHaveBeenCalledWith({
      providerConnectionId: 'hhc-line:user-a'
    })
    expect(mockCleanupFileResources).toHaveBeenCalledWith({
      folderIds: expect.arrayContaining(['folder-a-1', 'folder-a-2']),
      itemIds: ['orphan-item-a']
    })
    await expect(getProviderConnection('hhc-line:user-a')).resolves.toBeUndefined()
    await expect(getProviderConnection('hhc-line:user-b')).resolves.toBeDefined()
    await expect(getProviderConnection('onedrive:user-a')).resolves.toBeDefined()
    await expect(listSyncEntriesByProviderConnection('hhc-line:user-a')).resolves.toEqual([])
    await expect(listSyncEntriesByProviderConnection('hhc-line:user-b')).resolves.toHaveLength(1)
    await expect(listSyncEntriesByProviderConnection('onedrive:user-a')).resolves.toHaveLength(1)
    await expect(getSyncCursor('hhc-line:user-a', 'collection-a-1')).resolves.toBeUndefined()
    await expect(getSyncCursor('hhc-line:user-b', 'collection-b')).resolves.toBeDefined()
    await expect(
      getSyncEntryPreference('hhc-line:user-a', 'collection-a-1')
    ).resolves.toBeUndefined()
    await expect(getSyncEntryPreference('hhc-line:user-b', 'collection-b')).resolves.toBeDefined()
    await expect(listSyncTombstones()).resolves.toEqual([
      expect.objectContaining({
        providerConnectionId: 'hhc-line:user-b',
        remoteItemId: 'old-b'
      })
    ])
  })

  it('converts a fully downloaded sync connection into normal local files', async () => {
    await putProviderConnection({
      id: 'connection-1',
      providerType: 'onedrive',
      displayName: 'OneDrive'
    })
    await putSyncCursor({
      providerConnectionId: 'connection-1',
      remoteFolderId: 'root',
      cursor: 'cursor-1',
      updatedAt: 1
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-folder-1',
      parentRemoteItemId: null,
      kind: 'folder',
      name: 'Media',
      folderId: 'folder-1',
      status: 'available-offline'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: 'remote-folder-1',
      kind: 'file',
      name: 'clip.mp4',
      itemId: 'item-1',
      blobId: 'blob-1',
      mimeType: 'video/mp4',
      status: 'available-offline'
    })
    await putSyncEntryPreference({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      offlinePolicyOverride: 'always-offline'
    })

    const db = await openFileExplorerDB()
    const folder: FolderRecord = {
      id: 'folder-1',
      name: 'Media',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'connection-1',
        remoteFolderId: 'remote-folder-1',
        providerType: 'onedrive',
        offlinePolicy: 'always-offline'
      }
    }
    const item: FileItemRecord = {
      id: 'item-1',
      parentId: 'folder-1',
      type: 'file',
      name: 'clip.mp4',
      url: 'blob:blob-1',
      size: 1024,
      mimeType: 'video/mp4',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null
    }
    await db.put('folder-records', folder)
    await db.put('folder-items', item)
    await db.put('file-blobs', { id: 'blob-1', storage: 'native-fs', size: 1024, refCount: 1 })

    const result = await convertSyncConnectionToNormalFolder('connection-1')

    expect(result).toEqual({
      folderIds: ['folder-1'],
      itemIds: ['item-1'],
      removedSyncEntryCount: 2
    })
    await expect(db.get('folder-records', 'folder-1')).resolves.toEqual(
      expect.not.objectContaining({ syncLink: expect.anything() })
    )
    await expect(db.get('folder-items', 'item-1')).resolves.toMatchObject({ id: 'item-1' })
    await expect(db.get('file-blobs', 'blob-1')).resolves.toMatchObject({ id: 'blob-1' })
    await expect(getProviderConnection('connection-1')).resolves.toBeUndefined()
    await expect(getSyncCursor('connection-1', 'root')).resolves.toBeUndefined()
    await expect(getSyncEntryByRemoteItem('connection-1', 'remote-file-1')).resolves.toBeUndefined()
    await expect(getSyncEntryPreference('connection-1', 'remote-file-1')).resolves.toBeUndefined()
    await expect(listSyncTombstones()).resolves.toEqual([])
    expect(mockCleanupFileResources).not.toHaveBeenCalled()
  })

  it('rejects keep-files conversion when a synced file is not available offline', async () => {
    await putProviderConnection({
      id: 'connection-1',
      providerType: 'onedrive',
      displayName: 'OneDrive'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'remote-only.mp4',
      itemId: 'item-1',
      mimeType: 'video/mp4',
      status: 'remote-only'
    })

    await expect(convertSyncConnectionToNormalFolder('connection-1')).rejects.toThrow(
      'Cannot keep synced files before every file is available offline'
    )
    await expect(getProviderConnection('connection-1')).resolves.toBeDefined()
    await expect(listSyncEntriesByProviderConnection('connection-1')).resolves.toHaveLength(1)
  })

  it('recovers pending tombstone cleanup after restart', async () => {
    await (
      await openFileExplorerDB()
    ).put('folder-records', {
      id: 'folder-1',
      name: 'Recovered',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'connection-1',
        providerType: 'onedrive',
        remoteFolderId: 'remote-folder-1',
        offlinePolicy: 'always-offline'
      }
    })
    await putSyncTombstone({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-folder-1',
      folderId: 'folder-1',
      unlinkScope: 'root',
      reason: 'unlink'
    })
    await putSyncTombstone({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      itemId: 'item-1',
      blobId: 'blob-1',
      reason: 'remote-delete'
    })

    const result = await recoverPendingSyncResourceCleanups()

    expect(mockCleanupFileResources).toHaveBeenCalledWith({
      folderIds: ['folder-1'],
      itemIds: ['item-1']
    })
    expect(result).toEqual({
      folderIds: ['folder-1'],
      itemIds: ['item-1'],
      tombstoneCount: 2
    })
    await expect(listSyncTombstones()).resolves.toEqual([])
    expect(mockCancelVideoPosterJobsAndWait).toHaveBeenCalledWith(['item-1'])
  })

  it('ignores a raw descendant marker that points at a sibling root during restart', async () => {
    const db = await openFileExplorerDB()
    await Promise.all(
      [
        ['folder-a', 'remote-a'],
        ['folder-b', 'remote-b']
      ].map(([id, remoteFolderId]) =>
        db.put('folder-records', {
          id,
          name: id,
          parentId: 'file-root',
          sortIndex: 0,
          createdAt: 1,
          expiresAt: null,
          syncLink: {
            providerConnectionId: 'connection-1',
            providerType: 'onedrive',
            remoteFolderId,
            offlinePolicy: 'always-offline'
          }
        })
      )
    )
    await putSyncTombstone({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-a',
      folderId: 'folder-a',
      unlinkScope: 'root',
      reason: 'unlink'
    })
    await putSyncTombstone({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-b',
      folderId: 'folder-b',
      reason: 'unlink'
    })

    await recoverPendingSyncResourceCleanups()

    expect(mockCleanupFileResources).toHaveBeenCalledWith({
      folderIds: ['folder-a'],
      itemIds: []
    })
  })

  it('keeps tombstones when restart cleanup fails so the next launch can retry', async () => {
    mockCleanupFileResources.mockRejectedValueOnce(new Error('locked'))
    await putSyncTombstone({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      itemId: 'item-1',
      blobId: 'blob-1',
      reason: 'remote-delete'
    })

    await expect(recoverPendingSyncResourceCleanups()).rejects.toThrow('locked')

    await expect(listSyncTombstones()).resolves.toHaveLength(1)
  })
})
