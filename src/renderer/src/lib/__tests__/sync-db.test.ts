import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHhcLineProviderConnectionId,
  deleteProviderConnection,
  deleteSyncEntries,
  deleteSyncCursorsByProviderConnection,
  deleteSyncEntriesByProviderConnection,
  deleteSyncEntryPreferencesByProviderConnection,
  getProviderConnection,
  SYNC_ENTRY_CHANGED_EVENT,
  getSyncCursor,
  getSyncEntryByRemoteItem,
  getSyncEntryPreference,
  listHhcLineProviderConnectionsByAccountUser,
  listPendingShareLeaves,
  listSyncEntriesByProviderConnection,
  openSyncDB,
  putProviderConnection,
  putPendingShareLeave,
  deletePendingShareLeave,
  putSyncCursor,
  putSyncEntry,
  putSyncEntryPreference,
  putSyncTombstone,
  resetSyncDBForTests,
  updateSyncDownloadProgress
} from '../sync-db'

function seedLegacyProviderConnections(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('hhc-sync', 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('provider-connections', { keyPath: 'id' })
      store.createIndex('by-provider-type', 'providerType')
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('provider-connections', 'readwrite')
      const store = tx.objectStore('provider-connections')
      store.put({
        id: 'onedrive:legacy',
        providerType: 'onedrive',
        displayName: 'Legacy OneDrive',
        accountLabel: 'legacy@example.com',
        createdAt: 1,
        updatedAt: 2
      })
      store.put({
        id: 'local:legacy',
        providerType: 'local-fs',
        displayName: 'Legacy local folder',
        createdAt: 3,
        updatedAt: 4
      })
      tx.onerror = () => reject(tx.error)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
    }
  })
}

describe('sync-db', () => {
  beforeEach(async () => {
    await resetSyncDBForTests()
  })

  it('stores provider connections without credentials or cursors', async () => {
    await putProviderConnection({
      id: 'connection-1',
      providerType: 'onedrive',
      displayName: 'OneDrive',
      accountLabel: 'user@example.com'
    })

    await expect(getProviderConnection('connection-1')).resolves.toMatchObject({
      id: 'connection-1',
      providerType: 'onedrive',
      displayName: 'OneDrive',
      accountLabel: 'user@example.com'
    })
    await expect(getProviderConnection('connection-1')).resolves.not.toHaveProperty('accessToken')
    await expect(getProviderConnection('connection-1')).resolves.not.toHaveProperty('deltaLink')
  })

  it('migrates existing provider records unchanged while adding account lookup', async () => {
    await seedLegacyProviderConnections()

    const db = await openSyncDB()

    expect(db.version).toBe(3)
    await expect(getProviderConnection('onedrive:legacy')).resolves.toEqual({
      id: 'onedrive:legacy',
      providerType: 'onedrive',
      displayName: 'Legacy OneDrive',
      accountLabel: 'legacy@example.com',
      createdAt: 1,
      updatedAt: 2
    })
    await expect(getProviderConnection('local:legacy')).resolves.toEqual({
      id: 'local:legacy',
      providerType: 'local-fs',
      displayName: 'Legacy local folder',
      createdAt: 3,
      updatedAt: 4
    })
  })

  it('persists and acknowledges offline shared-folder leaves per recipient', async () => {
    await putPendingShareLeave('recipient-a', 'grant-a')
    await putPendingShareLeave('recipient-b', 'grant-b')
    await expect(listPendingShareLeaves('recipient-a')).resolves.toMatchObject([
      { recipientId: 'recipient-a', grantId: 'grant-a' }
    ])
    await deletePendingShareLeave('recipient-a', 'grant-a')
    await expect(listPendingShareLeaves('recipient-a')).resolves.toEqual([])
  })

  it('requires canonical account identity for HHC LINE provider connections', async () => {
    const accountUserId = 'user-a'
    expect(() => createHhcLineProviderConnectionId('')).toThrow(
      'HHC LINE provider connections require an account user ID'
    )
    const id = createHhcLineProviderConnectionId(accountUserId)

    expect(id).toBe('hhc-line:user-a')
    await expect(
      putProviderConnection({
        id,
        providerType: 'hhc-line',
        displayName: 'HHC LINE'
      })
    ).rejects.toThrow('HHC LINE provider connections require an account user ID')
    await expect(
      putProviderConnection({
        id: 'hhc-line:wrong-user',
        providerType: 'hhc-line',
        displayName: 'HHC LINE',
        accountUserId
      })
    ).rejects.toThrow('HHC LINE provider connection ID does not match its account user ID')

    await expect(
      putProviderConnection({
        id,
        providerType: 'hhc-line',
        displayName: 'HHC LINE',
        accountLabel: 'User A',
        accountUserId
      })
    ).resolves.toMatchObject({ id, accountUserId })
  })

  it('lists only HHC LINE connections for the requested account', async () => {
    await putProviderConnection({
      id: createHhcLineProviderConnectionId('user-a'),
      providerType: 'hhc-line',
      displayName: 'User A',
      accountUserId: 'user-a'
    })
    await putProviderConnection({
      id: createHhcLineProviderConnectionId('user-b'),
      providerType: 'hhc-line',
      displayName: 'User B',
      accountUserId: 'user-b'
    })
    await putProviderConnection({
      id: 'onedrive:user-a',
      providerType: 'onedrive',
      displayName: 'OneDrive',
      accountUserId: 'user-a'
    })

    await expect(listHhcLineProviderConnectionsByAccountUser('user-a')).resolves.toEqual([
      expect.objectContaining({
        id: 'hhc-line:user-a',
        providerType: 'hhc-line',
        accountUserId: 'user-a'
      })
    ])
  })

  it('keeps cursors scoped by provider connection and remote folder', async () => {
    await putSyncCursor({
      providerConnectionId: 'connection-1',
      remoteFolderId: 'folder',
      cursor: 'cursor-a',
      updatedAt: 1
    })
    await putSyncCursor({
      providerConnectionId: 'connection-2',
      remoteFolderId: 'folder',
      cursor: 'cursor-b',
      updatedAt: 1
    })

    await expect(getSyncCursor('connection-1', 'folder')).resolves.toMatchObject({
      cursor: 'cursor-a'
    })
    await expect(getSyncCursor('connection-2', 'folder')).resolves.toMatchObject({
      cursor: 'cursor-b'
    })
  })

  it('upserts sync entries by immutable remote identity', async () => {
    const first = await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: 'remote-folder-1',
      kind: 'file',
      name: 'before.mkv',
      mimeType: 'video/x-matroska',
      size: 10,
      status: 'remote-only'
    })
    const second = await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: 'remote-folder-2',
      kind: 'file',
      name: 'after.mkv',
      mimeType: 'video/x-matroska',
      size: 10,
      status: 'available-offline',
      blobId: 'blob-1'
    })

    expect(second.id).toBe(first.id)
    await expect(getSyncEntryByRemoteItem('connection-1', 'remote-file-1')).resolves.toMatchObject({
      parentRemoteItemId: 'remote-folder-2',
      name: 'after.mkv',
      status: 'available-offline',
      blobId: 'blob-1'
    })
  })

  it('dispatches an event when sync entries change', async () => {
    const listener = vi.fn()
    window.addEventListener(SYNC_ENTRY_CHANGED_EVENT, listener)

    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'one.mp4',
      itemId: 'item-1',
      status: 'downloading'
    })

    window.removeEventListener(SYNC_ENTRY_CHANGED_EVENT, listener)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        providerConnectionId: 'connection-1',
        remoteItemId: 'remote-file-1',
        itemId: 'item-1',
        status: 'downloading'
      }
    })
  })

  it('publishes a semantic recovery change after a failed entry is deleted', async () => {
    const entry = await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'one.mp4',
      status: 'failed'
    })
    let observedDeletion: ReturnType<typeof getSyncEntryByRemoteItem> | undefined
    const listener = vi.fn(() => {
      observedDeletion = getSyncEntryByRemoteItem('connection-1', 'remote-file-1')
    })
    window.addEventListener('hhc:recovery-source-changed', listener)

    await deleteSyncEntries([entry.id])

    window.removeEventListener('hhc:recovery-source-changed', listener)
    expect(listener).toHaveBeenCalledOnce()
    await expect(observedDeletion).resolves.toBeUndefined()
  })

  it('publishes a semantic recovery change after a failed entry commits', async () => {
    let observedEntry: ReturnType<typeof getSyncEntryByRemoteItem> | undefined
    const listener = vi.fn(() => {
      observedEntry = getSyncEntryByRemoteItem('connection-1', 'remote-file-1')
    })
    window.addEventListener('hhc:recovery-source-changed', listener)

    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'one.mp4',
      status: 'failed'
    })

    window.removeEventListener('hhc:recovery-source-changed', listener)
    expect(listener).toHaveBeenCalledOnce()
    await expect(observedEntry).resolves.toMatchObject({ status: 'failed' })
  })

  it('does not publish semantic recovery changes for download progress writes', async () => {
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'one.mp4',
      status: 'downloading'
    })
    const listener = vi.fn()
    window.addEventListener('hhc:recovery-source-changed', listener)

    for (let downloadedBytes = 1; downloadedBytes <= 20; downloadedBytes++) {
      await updateSyncDownloadProgress(
        { providerConnectionId: 'connection-1', remoteItemId: 'remote-file-1' },
        downloadedBytes,
        20
      )
    }

    window.removeEventListener('hhc:recovery-source-changed', listener)
    expect(listener).not.toHaveBeenCalled()
  })

  it('publishes a semantic recovery change when a normal entry attaches a Blob', async () => {
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'one.mp4',
      status: 'remote-only'
    })
    const listener = vi.fn()
    window.addEventListener('hhc:recovery-source-changed', listener)

    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'one.mp4',
      blobId: 'blob-1',
      status: 'available-offline'
    })

    window.removeEventListener('hhc:recovery-source-changed', listener)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('publishes a semantic recovery change when a normal entry detaches a Blob', async () => {
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'one.mp4',
      blobId: 'blob-1',
      status: 'available-offline'
    })
    const listener = vi.fn()
    window.addEventListener('hhc:recovery-source-changed', listener)

    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'one.mp4',
      status: 'remote-only'
    })

    window.removeEventListener('hhc:recovery-source-changed', listener)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('publishes a semantic recovery change when a normal Blob-backed entry is deleted', async () => {
    const entry = await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'one.mp4',
      blobId: 'blob-1',
      status: 'available-offline'
    })
    const listener = vi.fn()
    window.addEventListener('hhc:recovery-source-changed', listener)

    await deleteSyncEntries([entry.id])

    window.removeEventListener('hhc:recovery-source-changed', listener)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('publishes one semantic recovery change for provider-scoped Blob-backed deletion', async () => {
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'one.mp4',
      blobId: 'blob-1',
      status: 'available-offline'
    })
    const listener = vi.fn()
    window.addEventListener('hhc:recovery-source-changed', listener)

    await deleteSyncEntriesByProviderConnection('connection-1')

    window.removeEventListener('hhc:recovery-source-changed', listener)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('publishes a semantic recovery change after a provider is deleted', async () => {
    await putProviderConnection({
      id: 'connection-1',
      providerType: 'onedrive',
      displayName: 'OneDrive'
    })
    let observedDeletion: ReturnType<typeof getProviderConnection> | undefined
    const listener = vi.fn(() => {
      observedDeletion = getProviderConnection('connection-1')
    })
    window.addEventListener('hhc:recovery-source-changed', listener)

    await deleteProviderConnection('connection-1')

    window.removeEventListener('hhc:recovery-source-changed', listener)
    expect(listener).toHaveBeenCalledOnce()
    await expect(observedDeletion).resolves.toBeUndefined()
  })

  it('updates download progress for an existing sync entry', async () => {
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'one.mp4',
      itemId: 'item-1',
      status: 'downloading'
    })

    await updateSyncDownloadProgress(
      { providerConnectionId: 'connection-1', remoteItemId: 'remote-file-1' },
      40,
      100
    )

    await expect(getSyncEntryByRemoteItem('connection-1', 'remote-file-1')).resolves.toMatchObject({
      downloadedBytes: 40,
      downloadTotalBytes: 100
    })
  })

  it('stores per-entry offline policy overrides separately from entries', async () => {
    await putSyncEntryPreference({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      offlinePolicyOverride: 'always-offline'
    })

    await expect(getSyncEntryPreference('connection-1', 'remote-file-1')).resolves.toMatchObject({
      offlinePolicyOverride: 'always-offline'
    })
  })

  it('records tombstones without deleting resources immediately', async () => {
    const tombstone = await putSyncTombstone({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      itemId: 'item-1',
      blobId: 'blob-1',
      reason: 'remote-delete'
    })

    expect(tombstone).toMatchObject({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      itemId: 'item-1',
      blobId: 'blob-1',
      reason: 'remote-delete'
    })
  })

  it('deletes sync metadata scoped to one provider connection', async () => {
    await putSyncCursor({
      providerConnectionId: 'connection-1',
      remoteFolderId: 'folder',
      cursor: 'cursor-a',
      updatedAt: 1
    })
    await putSyncCursor({
      providerConnectionId: 'connection-2',
      remoteFolderId: 'folder',
      cursor: 'cursor-b',
      updatedAt: 1
    })
    await putSyncEntry({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'one.mp4',
      status: 'remote-only'
    })
    await putSyncEntry({
      providerConnectionId: 'connection-2',
      remoteItemId: 'remote-file-2',
      parentRemoteItemId: null,
      kind: 'file',
      name: 'two.mp4',
      status: 'remote-only'
    })
    await putSyncEntryPreference({
      providerConnectionId: 'connection-1',
      remoteItemId: 'remote-file-1',
      offlinePolicyOverride: 'always-offline'
    })

    await deleteSyncEntriesByProviderConnection('connection-1')
    await deleteSyncEntryPreferencesByProviderConnection('connection-1')
    await deleteSyncCursorsByProviderConnection('connection-1')

    await expect(listSyncEntriesByProviderConnection('connection-1')).resolves.toEqual([])
    await expect(getSyncEntryByRemoteItem('connection-2', 'remote-file-2')).resolves.toMatchObject({
      providerConnectionId: 'connection-2'
    })
    await expect(getSyncEntryPreference('connection-1', 'remote-file-1')).resolves.toBeUndefined()
    await expect(getSyncCursor('connection-1', 'folder')).resolves.toBeUndefined()
    await expect(getSyncCursor('connection-2', 'folder')).resolves.toMatchObject({
      cursor: 'cursor-b'
    })
  })
})
