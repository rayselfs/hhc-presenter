import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderRecord, FileItemRecord, SyncOfflinePolicy } from '@shared/types/folder'
import type { SyncEntryRecord } from '../sync-db'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { getSyncEntryByRemoteItem, putSyncEntry, resetSyncDBForTests } from '../sync-db'
import {
  applySyncRefreshPlan,
  buildSyncDeltaRefreshPlan,
  buildSyncRefreshPlan,
  collectSyncChangePages
} from '../sync-refresh'
import type { ReadOnlySyncProvider } from '../sync-provider'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const rootFolder: FolderRecord = {
  id: 'root-sync-folder',
  name: 'Media',
  parentId: 'file-root',
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null,
  syncLink: {
    providerConnectionId: 'connection-1',
    remoteFolderId: '.',
    providerType: 'local-fs',
    offlinePolicy: 'always-offline'
  }
}

const existingItem: FileItemRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  parentId: rootFolder.id,
  type: 'file',
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null,
  name: 'old.mp4',
  url: 'blob:11111111-1111-4111-8111-111111111111',
  size: 100,
  mimeType: 'video/mp4'
}

const existingEntry: SyncEntryRecord = {
  id: 'entry-1',
  providerConnectionId: 'connection-1',
  remoteItemId: 'old-file',
  parentRemoteItemId: null,
  kind: 'file',
  name: 'old.mp4',
  itemId: existingItem.id,
  blobId: existingItem.id,
  mimeType: 'video/mp4',
  size: 100,
  etag: 'before',
  status: 'available-offline',
  createdAt: 1,
  updatedAt: 1
}

beforeEach(async () => {
  await resetFileExplorerDBForTests()
  await resetSyncDBForTests()
})

describe('buildSyncRefreshPlan', () => {
  it('uses source creation time and preserves existing time when the source omits it', () => {
    const plan = buildSyncRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [existingItem],
      existingEntries: [existingEntry],
      remoteItems: [
        {
          remoteItemId: 'old-file',
          parentRemoteItemId: '.',
          kind: 'file',
          name: 'old.mp4',
          size: 100,
          etag: 'before',
          sourceCreatedAt: 200
        },
        {
          remoteItemId: 'new-file',
          parentRemoteItemId: '.',
          kind: 'file',
          name: 'new.mp4',
          size: 100
        }
      ]
    })

    expect(plan.items.find((item) => item.name === 'old.mp4')?.createdAt).toBe(200)
    expect(plan.items.find((item) => item.name === 'new.mp4')?.createdAt).toBeGreaterThan(200)
  })

  it('updates a downloaded HHC item name without replacing its blob or fetching content', async () => {
    const existingBlob = new Blob(['downloaded'])
    const db = await openFileExplorerDB()
    await db.put('folder-items', existingItem)
    await db.put('file-blobs', {
      id: existingItem.id,
      blob: existingBlob,
      refCount: 1
    })
    const downloadedEntry = {
      ...existingEntry,
      contentHash: 'sha256:content',
      downloadedBytes: existingItem.size,
      downloadTotalBytes: existingItem.size
    }
    await putSyncEntry(downloadedEntry)
    const fetchContent = vi.fn()

    const plan = buildSyncDeltaRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'hhc-line',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'on-demand',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [existingItem],
      existingEntries: [downloadedEntry],
      existingBlobIds: new Set([existingItem.id]),
      remoteItems: [
        {
          remoteItemId: 'old-file',
          parentRemoteItemId: '.',
          kind: 'file',
          name: 'renamed.mp4',
          mimeType: 'video/mp4',
          size: 100,
          etag: 'before',
          contentHash: 'sha256:content'
        }
      ]
    })

    for (const transfer of plan.fileTransfers) await fetchContent(transfer)
    await applySyncRefreshPlan(plan)

    expect(plan.items[0].name).toBe('renamed.mp4')
    expect(plan.items[0].id).toBe(existingItem.id)
    expect(plan.fileTransfers).toEqual([])
    expect(fetchContent).not.toHaveBeenCalled()
    await expect(getSyncEntryByRemoteItem('connection-1', 'old-file')).resolves.toMatchObject({
      name: 'renamed.mp4',
      blobId: existingItem.id,
      status: 'available-offline'
    })
    await expect(db.get('file-blobs', existingItem.id)).resolves.toMatchObject({
      id: existingItem.id,
      refCount: 1
    })
  })

  it('updates synced records, queues changed files, and removes missing files', () => {
    const plan = buildSyncRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [existingItem],
      existingEntries: [existingEntry],
      remoteItems: [
        {
          remoteItemId: 'folder-1',
          parentRemoteItemId: null,
          kind: 'folder',
          name: 'Sunday'
        },
        {
          remoteItemId: 'old-file',
          parentRemoteItemId: 'folder-1',
          kind: 'file',
          name: 'renamed.mp4',
          mimeType: 'video/mp4',
          size: 120,
          etag: 'after'
        },
        {
          remoteItemId: 'bad-file',
          parentRemoteItemId: 'folder-1',
          kind: 'file',
          name: 'legacy.avi',
          size: 20
        },
        {
          remoteItemId: 'system-file',
          parentRemoteItemId: 'folder-1',
          kind: 'file',
          name: '.DS_Store',
          size: 20
        }
      ]
    })

    expect(plan.folders).toEqual([
      expect.objectContaining({
        id: 'local-sync-folder-connection-1-folder-1',
        parentId: rootFolder.id,
        name: 'Sunday'
      })
    ])
    expect(plan.items).toEqual([
      expect.objectContaining({
        id: existingItem.id,
        parentId: 'local-sync-folder-connection-1-folder-1',
        name: 'renamed.mp4',
        size: 120,
        url: `blob:${existingItem.id}`
      }),
      expect.objectContaining({
        name: 'legacy.avi',
        url: expect.stringMatching(/^blob:/)
      })
    ])
    const newItem = plan.items.find((item) => item.name === 'legacy.avi')
    expect(plan.items.find((item) => item.name === '.DS_Store')).toBeUndefined()
    expect(newItem?.id).toMatch(UUID_PATTERN)
    expect(plan.fileTransfers).toEqual([
      { itemId: existingItem.id, remoteItemId: 'old-file', mimeType: 'video/mp4' },
      {
        itemId: newItem?.id,
        remoteItemId: 'bad-file',
        mimeType: 'video/x-msvideo'
      }
    ])
    expect(plan.removedItemIds).toEqual([])
  })

  it('does not let a stale refresh plan downgrade a completed download', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: existingItem.id,
      blob: new Blob(['ready']),
      refCount: 1
    })
    await putSyncEntry({
      ...existingEntry,
      downloadedBytes: existingItem.size,
      downloadTotalBytes: existingItem.size
    })

    await applySyncRefreshPlan({
      folders: [],
      items: [],
      syncEntries: [
        {
          providerConnectionId: existingEntry.providerConnectionId,
          remoteItemId: existingEntry.remoteItemId,
          parentRemoteItemId: existingEntry.parentRemoteItemId,
          kind: 'file',
          name: existingEntry.name,
          itemId: existingEntry.itemId,
          mimeType: existingEntry.mimeType,
          size: existingEntry.size,
          etag: existingEntry.etag,
          contentHash: existingEntry.contentHash,
          status: 'queued'
        }
      ],
      fileTransfers: [
        { itemId: existingItem.id, remoteItemId: existingEntry.remoteItemId, mimeType: 'video/mp4' }
      ],
      removedFolderIds: [],
      removedItemIds: [],
      removedEntries: [],
      disabledCount: 0
    })

    await expect(
      getSyncEntryByRemoteItem(existingEntry.providerConnectionId, existingEntry.remoteItemId)
    ).resolves.toMatchObject({
      status: 'available-offline',
      blobId: existingItem.id,
      downloadedBytes: existingItem.size,
      downloadTotalBytes: existingItem.size
    })
  })

  it('keeps web-unsupported files remote-only and skips app-unsupported files', () => {
    const plan = buildSyncRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'web',
      existingFolders: [rootFolder],
      existingItems: [existingItem],
      existingEntries: [existingEntry],
      remoteItems: [
        {
          remoteItemId: 'bad-file',
          parentRemoteItemId: null,
          kind: 'file',
          name: 'legacy.avi',
          size: 20
        },
        {
          remoteItemId: 'psd-file',
          parentRemoteItemId: null,
          kind: 'file',
          name: 'layout.psd',
          mimeType: 'image/vnd.adobe.photoshop',
          size: 20
        }
      ]
    })

    expect(plan.items).toEqual([
      expect.objectContaining({
        name: 'legacy.avi',
        url: expect.stringMatching(/^unsupported:/)
      })
    ])
    expect(plan.items.find((item) => item.name === 'layout.psd')).toBeUndefined()
    expect(plan.fileTransfers).toEqual([])
    expect(plan.removedItemIds).toEqual([existingItem.id])
    expect(plan.syncEntries).toEqual([
      expect.objectContaining({
        remoteItemId: 'bad-file',
        status: 'remote-only'
      })
    ])
  })

  it('replaces legacy non-native item ids before file transfer', () => {
    const legacyItem = { ...existingItem, id: 'local-sync-item-connection-1-old-file' }
    const plan = buildSyncRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [legacyItem],
      existingEntries: [{ ...existingEntry, itemId: legacyItem.id, blobId: legacyItem.id }],
      remoteItems: [
        {
          remoteItemId: 'old-file',
          parentRemoteItemId: null,
          kind: 'file',
          name: 'old.mp4',
          mimeType: 'video/mp4',
          size: 120,
          etag: 'after'
        }
      ]
    })

    expect(plan.items[0].id).toMatch(UUID_PATTERN)
    expect(plan.items[0].id).not.toBe(legacyItem.id)
    expect(plan.fileTransfers[0].itemId).toBe(plan.items[0].id)
    expect(plan.removedItemIds).toContain(legacyItem.id)
  })

  it('requeues queued files instead of marking them available offline', () => {
    const plan = buildSyncRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [existingItem],
      existingEntries: [{ ...existingEntry, status: 'queued' }],
      remoteItems: [
        {
          remoteItemId: 'old-file',
          parentRemoteItemId: null,
          kind: 'file',
          name: 'old.mp4',
          mimeType: 'video/mp4',
          size: 100,
          etag: 'before'
        }
      ]
    })

    expect(plan.fileTransfers).toEqual([
      { itemId: existingItem.id, remoteItemId: 'old-file', mimeType: 'video/mp4' }
    ])
    expect(plan.syncEntries[0]).toMatchObject({
      remoteItemId: 'old-file',
      status: 'queued'
    })
    expect(plan.syncEntries[0]).not.toHaveProperty('blobId')
  })

  it('requeues available-offline files when the stored blob is missing', () => {
    const plan = buildSyncRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [existingItem],
      existingEntries: [existingEntry],
      existingBlobIds: new Set(),
      remoteItems: [
        {
          remoteItemId: 'old-file',
          parentRemoteItemId: null,
          kind: 'file',
          name: 'old.mp4',
          mimeType: 'video/mp4',
          size: 100,
          etag: 'before'
        }
      ]
    })

    expect(plan.fileTransfers).toEqual([
      { itemId: existingItem.id, remoteItemId: 'old-file', mimeType: 'video/mp4' }
    ])
    expect(plan.syncEntries[0]).toMatchObject({
      remoteItemId: 'old-file',
      status: 'queued'
    })
    expect(plan.syncEntries[0]).not.toHaveProperty('blobId')
  })

  it('does not retry failed files before nextRetryAt unless forced', () => {
    const nextRetryAt = Date.now() + 60_000
    const plan = buildSyncRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [existingItem],
      existingEntries: [
        {
          ...existingEntry,
          status: 'failed',
          blobId: undefined,
          errorKind: 'retryable',
          retryCount: 1,
          nextRetryAt,
          lastError: '429'
        }
      ],
      remoteItems: [
        {
          remoteItemId: 'old-file',
          parentRemoteItemId: null,
          kind: 'file',
          name: 'old.mp4',
          mimeType: 'video/mp4',
          size: 100,
          etag: 'before'
        }
      ]
    })

    expect(plan.fileTransfers).toEqual([])
    expect(plan.syncEntries[0]).toMatchObject({
      remoteItemId: 'old-file',
      status: 'failed',
      errorKind: 'retryable',
      retryCount: 1,
      nextRetryAt,
      lastError: '429'
    })

    const forcedPlan = buildSyncRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [existingItem],
      existingEntries: [
        {
          ...existingEntry,
          status: 'failed',
          blobId: undefined,
          errorKind: 'retryable',
          retryCount: 1,
          nextRetryAt,
          lastError: '429'
        }
      ],
      remoteItems: [
        {
          remoteItemId: 'old-file',
          parentRemoteItemId: null,
          kind: 'file',
          name: 'old.mp4',
          mimeType: 'video/mp4',
          size: 100,
          etag: 'before'
        }
      ],
      forceRetry: true
    })

    expect(forcedPlan.fileTransfers).toEqual([
      { itemId: existingItem.id, remoteItemId: 'old-file', mimeType: 'video/mp4' }
    ])
  })

  it('applies delta changes without deleting entries that are absent from the delta page', () => {
    const plan = buildSyncDeltaRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [existingItem],
      existingEntries: [existingEntry],
      remoteItems: [
        {
          remoteItemId: 'new-file',
          parentRemoteItemId: '.',
          kind: 'file',
          name: 'new.mp4',
          mimeType: 'video/mp4',
          size: 200,
          etag: 'new'
        }
      ]
    })

    expect(plan.needsFullScan).toBe(false)
    expect(plan.items).toEqual([expect.objectContaining({ name: 'new.mp4' })])
    expect(plan.fileTransfers).toEqual([
      {
        itemId: plan.items[0].id,
        remoteItemId: 'new-file',
        mimeType: 'video/mp4'
      }
    ])
    expect(plan.removedItemIds).toEqual([])
  })

  it.each(['manual', 'scheduled'])('removes an explicit %s deletion tombstone', () => {
    const plan = buildSyncDeltaRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [existingItem],
      existingEntries: [existingEntry],
      remoteItems: [
        {
          remoteItemId: 'old-file',
          parentRemoteItemId: null,
          kind: 'file',
          name: 'old.mp4',
          deleted: true
        }
      ]
    })

    expect(plan.needsFullScan).toBe(false)
    expect(plan.removedItemIds).toEqual([existingItem.id])
    expect(plan.removedEntries).toEqual([existingEntry])
  })

  it('removes an item absent from a long-offline reset snapshot', async () => {
    const db = await openFileExplorerDB()
    await db.put('folder-items', existingItem)
    await db.put('file-blobs', {
      id: existingItem.id,
      blob: new Blob(['downloaded']),
      refCount: 1
    })
    await putSyncEntry(existingEntry)

    const plan = buildSyncRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'hhc-line',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'on-demand',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [existingItem],
      existingEntries: [existingEntry],
      existingBlobIds: new Set([existingItem.id]),
      remoteItems: []
    })

    expect(plan.removedItemIds).toEqual([existingItem.id])
    expect(plan.removedEntries).toEqual([existingEntry])
    await applySyncRefreshPlan(plan)
    await expect(db.get('file-blobs', existingItem.id)).resolves.toBeUndefined()
  })

  it('requests full scan fallback when delta parent cannot be mapped locally', () => {
    const plan = buildSyncDeltaRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [existingItem],
      existingEntries: [existingEntry],
      remoteItems: [
        {
          remoteItemId: 'new-file',
          parentRemoteItemId: 'unknown-folder',
          kind: 'file',
          name: 'new.mp4',
          mimeType: 'video/mp4',
          size: 200
        }
      ]
    })

    expect(plan.needsFullScan).toBe(true)
    expect(plan.items).toEqual([])
    expect(plan.fileTransfers).toEqual([])
  })

  it('requests full scan fallback when existing downloads are still pending', () => {
    const plan = buildSyncDeltaRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [existingItem],
      existingEntries: [{ ...existingEntry, status: 'downloading', blobId: undefined }],
      remoteItems: []
    })

    expect(plan.needsFullScan).toBe(true)
    expect(plan.removedItemIds).toEqual([])
  })

  it('requests a full scan to reconcile remote-only files after switching to always-offline', () => {
    const onDemandRoot = {
      ...rootFolder,
      syncLink: { ...rootFolder.syncLink!, offlinePolicy: 'on-demand' as const }
    }
    const remoteOnlyEntry = { ...existingEntry, status: 'remote-only' as const, blobId: undefined }

    const delta = buildSyncDeltaRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder: onDemandRoot,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'web',
      existingFolders: [onDemandRoot],
      existingItems: [existingItem],
      existingEntries: [remoteOnlyEntry],
      remoteItems: []
    })

    expect(delta.needsFullScan).toBe(true)

    const full = buildSyncRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder: onDemandRoot,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'web',
      existingFolders: [onDemandRoot],
      existingItems: [existingItem],
      existingEntries: [
        remoteOnlyEntry,
        {
          ...remoteOnlyEntry,
          id: 'entry-unsupported',
          remoteItemId: 'unsupported-file',
          name: 'legacy.avi',
          itemId: '22222222-2222-4222-8222-222222222222',
          mimeType: 'video/x-msvideo'
        }
      ],
      remoteItems: [
        {
          remoteItemId: 'old-file',
          parentRemoteItemId: '.',
          kind: 'file',
          name: 'old.mp4',
          mimeType: 'video/mp4',
          size: 100,
          etag: 'before'
        },
        {
          remoteItemId: 'unsupported-file',
          parentRemoteItemId: '.',
          kind: 'file',
          name: 'legacy.avi',
          mimeType: 'video/x-msvideo',
          size: 100,
          etag: 'before'
        }
      ]
    })

    expect(full.fileTransfers).toEqual([
      { itemId: existingItem.id, remoteItemId: 'old-file', mimeType: 'video/mp4' }
    ])
    expect(
      full.syncEntries.find((entry) => entry.remoteItemId === 'unsupported-file')
    ).toMatchObject({ status: 'remote-only' })
  })

  it.each(['on-demand', 'online-only'] satisfies SyncOfflinePolicy[])(
    'does not force a full scan for remote-only files under %s policy',
    (offlinePolicy) => {
      const plan = buildSyncDeltaRefreshPlan({
        providerConnectionId: 'connection-1',
        providerType: 'local-fs',
        rootFolder,
        rootRemoteFolderId: '.',
        offlinePolicy,
        platform: 'electron',
        existingFolders: [rootFolder],
        existingItems: [existingItem],
        existingEntries: [{ ...existingEntry, status: 'remote-only' as const, blobId: undefined }],
        remoteItems: []
      })

      expect(plan.needsFullScan).toBe(false)
    }
  )

  it('requests full scan fallback when retryable failures are waiting for retry', () => {
    const plan = buildSyncDeltaRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'always-offline',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [existingItem],
      existingEntries: [
        {
          ...existingEntry,
          status: 'failed',
          blobId: undefined,
          errorKind: 'retryable',
          retryCount: 1,
          nextRetryAt: Date.now() + 60_000
        }
      ],
      remoteItems: []
    })

    expect(plan.needsFullScan).toBe(true)
  })
})

describe('collectSyncChangePages', () => {
  it('collects every reset page before returning a full-scan barrier', async () => {
    const incrementalChanges = vi
      .fn<ReadOnlySyncProvider['incrementalChanges']>()
      .mockResolvedValueOnce({
        items: [
          {
            remoteItemId: 'item-1',
            parentRemoteItemId: 'collection-1',
            kind: 'file',
            name: 'one.mp4'
          }
        ],
        nextCursor: 'reset-page-2',
        hasMore: true,
        reset: true
      })
      .mockResolvedValueOnce({
        items: [
          {
            remoteItemId: 'item-2',
            parentRemoteItemId: 'collection-1',
            kind: 'file',
            name: 'two.mp4'
          }
        ],
        nextCursor: 'reset-barrier',
        hasMore: true,
        reset: true
      })
      .mockResolvedValueOnce({
        items: [],
        nextCursor: 'reset-complete',
        hasMore: false,
        reset: false
      })
    const provider = {
      initialScan: vi.fn(),
      incrementalChanges
    } as unknown as ReadOnlySyncProvider

    await expect(
      collectSyncChangePages(provider, 'hhc-line:user-1', 'collection-1', 'stale-cursor')
    ).resolves.toEqual({
      remoteItems: [
        expect.objectContaining({ remoteItemId: 'item-1' }),
        expect.objectContaining({ remoteItemId: 'item-2' })
      ],
      nextCursor: 'reset-complete',
      usedCursor: false,
      reset: true
    })
    expect(incrementalChanges).toHaveBeenNthCalledWith(2, {
      providerConnectionId: 'hhc-line:user-1',
      remoteFolderId: 'collection-1',
      cursor: 'reset-page-2'
    })
    expect(incrementalChanges).toHaveBeenNthCalledWith(3, {
      providerConnectionId: 'hhc-line:user-1',
      remoteFolderId: 'collection-1',
      cursor: 'reset-barrier'
    })
  })

  it('accepts one bounded reset-to-delta handoff and keeps the last event per remote item', async () => {
    const incrementalChanges = vi
      .fn<ReadOnlySyncProvider['incrementalChanges']>()
      .mockResolvedValueOnce({
        items: [
          {
            remoteItemId: 'item-updated',
            parentRemoteItemId: 'collection-1',
            kind: 'file',
            name: 'old.jpg'
          },
          {
            remoteItemId: 'item-deleted',
            parentRemoteItemId: 'collection-1',
            kind: 'file',
            name: 'delete.jpg'
          }
        ],
        nextCursor: 'reset-barrier',
        hasMore: true,
        reset: true
      })
      .mockResolvedValueOnce({
        items: [
          {
            remoteItemId: 'item-updated',
            parentRemoteItemId: 'collection-1',
            kind: 'file',
            name: 'new.jpg'
          },
          {
            remoteItemId: 'item-deleted',
            parentRemoteItemId: 'collection-1',
            kind: 'file',
            name: 'item-deleted',
            deleted: true
          },
          {
            remoteItemId: 'item-added',
            parentRemoteItemId: 'collection-1',
            kind: 'file',
            name: 'added.jpg'
          }
        ],
        nextCursor: 'delta-complete',
        hasMore: false,
        reset: false
      })
    const provider = {
      initialScan: vi.fn(),
      incrementalChanges
    } as unknown as ReadOnlySyncProvider

    await expect(
      collectSyncChangePages(provider, 'connection-1', 'collection-1', 'stale-cursor')
    ).resolves.toEqual({
      remoteItems: [
        expect.objectContaining({ remoteItemId: 'item-updated', name: 'new.jpg' }),
        expect.objectContaining({ remoteItemId: 'item-deleted', deleted: true }),
        expect.objectContaining({ remoteItemId: 'item-added', name: 'added.jpg' })
      ],
      nextCursor: 'delta-complete',
      usedCursor: false,
      reset: true
    })
  })

  it('accepts an empty reset handoff page', async () => {
    const provider = {
      initialScan: vi.fn(),
      incrementalChanges: vi
        .fn<ReadOnlySyncProvider['incrementalChanges']>()
        .mockResolvedValueOnce({
          items: [],
          nextCursor: 'reset-barrier',
          hasMore: true,
          reset: true
        })
        .mockResolvedValueOnce({
          items: [],
          nextCursor: 'delta-complete',
          hasMore: false,
          reset: false
        })
    } as unknown as ReadOnlySyncProvider

    await expect(
      collectSyncChangePages(provider, 'connection-1', 'collection-1', 'stale-cursor')
    ).resolves.toMatchObject({ reset: true, usedCursor: false, nextCursor: 'delta-complete' })
  })

  it('rejects a 501-item reset handoff delta', async () => {
    const handoffItems = Array.from({ length: 501 }, (_, index) => ({
      remoteItemId: `item-${index}`,
      parentRemoteItemId: 'collection-1',
      kind: 'file' as const,
      name: `${index}.jpg`
    }))
    const provider = {
      initialScan: vi.fn(),
      incrementalChanges: vi
        .fn<ReadOnlySyncProvider['incrementalChanges']>()
        .mockResolvedValueOnce({
          items: [],
          nextCursor: 'reset-barrier',
          hasMore: true,
          reset: true
        })
        .mockResolvedValueOnce({
          items: handoffItems,
          nextCursor: 'delta-complete',
          hasMore: false,
          reset: false
        })
    } as unknown as ReadOnlySyncProvider

    await expect(
      collectSyncChangePages(provider, 'connection-1', 'collection-1', 'stale-cursor')
    ).rejects.toThrow('Invalid sync change pagination')
  })

  it('collects a 500+2 multi-page reset handoff with last-event-wins', async () => {
    const firstDeltaPage = [
      ...Array.from({ length: 498 }, (_, index) => ({
        remoteItemId: `filler-${index}`,
        parentRemoteItemId: 'collection-1',
        kind: 'file' as const,
        name: `${index}.jpg`
      })),
      {
        remoteItemId: 'item-updated',
        parentRemoteItemId: 'collection-1',
        kind: 'file' as const,
        name: 'middle.jpg'
      },
      {
        remoteItemId: 'item-deleted',
        parentRemoteItemId: 'collection-1',
        kind: 'file' as const,
        name: 'still-present.jpg'
      }
    ]
    const incrementalChanges = vi
      .fn<ReadOnlySyncProvider['incrementalChanges']>()
      .mockResolvedValueOnce({
        items: [
          {
            remoteItemId: 'item-updated',
            parentRemoteItemId: 'collection-1',
            kind: 'file',
            name: 'snapshot.jpg'
          },
          {
            remoteItemId: 'item-deleted',
            parentRemoteItemId: 'collection-1',
            kind: 'file',
            name: 'snapshot-delete.jpg'
          }
        ],
        nextCursor: 'reset-barrier',
        hasMore: true,
        reset: true
      })
      .mockResolvedValueOnce({
        items: firstDeltaPage,
        nextCursor: 'delta-page-2',
        hasMore: true,
        reset: false
      })
      .mockResolvedValueOnce({
        items: [
          {
            remoteItemId: 'item-updated',
            parentRemoteItemId: 'collection-1',
            kind: 'file',
            name: 'final.jpg'
          },
          {
            remoteItemId: 'item-deleted',
            parentRemoteItemId: 'collection-1',
            kind: 'file',
            name: 'item-deleted',
            deleted: true
          }
        ],
        nextCursor: 'delta-complete',
        hasMore: false,
        reset: false
      })
    const provider = {
      initialScan: vi.fn(),
      incrementalChanges
    } as unknown as ReadOnlySyncProvider

    const result = await collectSyncChangePages(
      provider,
      'connection-1',
      'collection-1',
      'stale-cursor'
    )

    expect(result.remoteItems).toHaveLength(500)
    expect(result.remoteItems.find((item) => item.remoteItemId === 'item-updated')).toMatchObject({
      name: 'final.jpg'
    })
    expect(result.remoteItems.find((item) => item.remoteItemId === 'item-deleted')).toMatchObject({
      deleted: true
    })
    expect(result).toMatchObject({ nextCursor: 'delta-complete', reset: true, usedCursor: false })
    expect(incrementalChanges).toHaveBeenNthCalledWith(1, {
      providerConnectionId: 'connection-1',
      remoteFolderId: 'collection-1',
      cursor: 'stale-cursor'
    })
    expect(incrementalChanges).toHaveBeenNthCalledWith(2, {
      providerConnectionId: 'connection-1',
      remoteFolderId: 'collection-1',
      cursor: 'reset-barrier'
    })
    expect(incrementalChanges).toHaveBeenNthCalledWith(3, {
      providerConnectionId: 'connection-1',
      remoteFolderId: 'collection-1',
      cursor: 'delta-page-2'
    })
  })

  it('rejects a reset snapshot that ends without a delta barrier', async () => {
    const provider = {
      initialScan: vi.fn(),
      incrementalChanges: vi.fn<ReadOnlySyncProvider['incrementalChanges']>(async () => ({
        items: [],
        nextCursor: 'reset-complete',
        hasMore: false,
        reset: true
      }))
    } as unknown as ReadOnlySyncProvider

    await expect(
      collectSyncChangePages(provider, 'connection-1', 'collection-1', 'stale-cursor')
    ).rejects.toThrow('Invalid sync change pagination')
  })

  it.each([
    ['missing cursor', { items: [], hasMore: true, reset: false }],
    ['repeated cursor', { items: [], nextCursor: 'cursor-1', hasMore: true, reset: false }],
    ['reset mode change', { items: [], nextCursor: 'cursor-2', hasMore: false, reset: true }]
  ])('rejects %s instead of applying a partial collection', async (_name, secondPage) => {
    const provider = {
      initialScan: vi.fn(),
      incrementalChanges: vi
        .fn<ReadOnlySyncProvider['incrementalChanges']>()
        .mockResolvedValueOnce({
          items: [],
          nextCursor: 'cursor-1',
          hasMore: true,
          reset: false
        })
        .mockResolvedValueOnce(secondPage)
    } as unknown as ReadOnlySyncProvider

    await expect(
      collectSyncChangePages(provider, 'connection-1', 'folder-1', 'cursor-0')
    ).rejects.toThrow('Invalid sync change pagination')
  })

  it('bounds unique cursor chains instead of collecting forever', async () => {
    let page = 0
    const incrementalChanges = vi.fn<ReadOnlySyncProvider['incrementalChanges']>(async () => {
      page += 1
      if (page > 1_000) throw new Error('unbounded pagination escaped')
      return {
        items: [],
        nextCursor: `cursor-${page}`,
        hasMore: true
      }
    })
    const provider = {
      initialScan: vi.fn(),
      incrementalChanges
    } as unknown as ReadOnlySyncProvider

    await expect(
      collectSyncChangePages(provider, 'connection-1', 'folder-1', 'cursor-0')
    ).rejects.toThrow('Invalid sync change pagination')
    expect(incrementalChanges).toHaveBeenCalledTimes(1_000)
  })
})

describe('guarded catalog commit', () => {
  it('rechecks the root in the catalog transaction before writing any plan record', async () => {
    const db = await openFileExplorerDB()
    await db.put('folder-records', rootFolder)
    const plan = buildSyncRefreshPlan({
      providerConnectionId: 'connection-1',
      providerType: 'local-fs',
      rootFolder,
      rootRemoteFolderId: '.',
      offlinePolicy: 'on-demand',
      platform: 'electron',
      existingFolders: [rootFolder],
      existingItems: [],
      existingEntries: [],
      remoteItems: [
        {
          remoteItemId: 'new-file',
          parentRemoteItemId: '.',
          kind: 'file',
          name: 'new.jpg',
          mimeType: 'image/jpeg',
          size: 4
        }
      ]
    })
    await db.delete('folder-records', rootFolder.id)
    await expect(applySyncRefreshPlan(plan, [], rootFolder)).rejects.toThrow(
      'Sync refresh root was revoked'
    )
    expect(await db.getAll('folder-records')).toEqual([])
    expect(await db.getAll('folder-items')).toEqual([])
    expect(await getSyncEntryByRemoteItem('connection-1', 'new-file')).toBeUndefined()
  })
})
