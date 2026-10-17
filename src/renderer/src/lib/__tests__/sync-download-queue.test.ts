import * as syncDb from '../sync-db'
import type { SyncEntryRecord } from '../sync-db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ReadOnlySyncProvider,
  SyncDownloadCommitGuard,
  SyncDownloadResult
} from '../sync-provider'
import {
  cancelSyncDownloads,
  cancelSyncDownloadsAndWait,
  enqueueSyncDownload,
  resetSyncDownloadQueueForTests,
  SYNC_DOWNLOAD_CONCURRENCY
} from '../sync-download-queue'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { getSyncEntryByRemoteItem, putSyncEntry, resetSyncDBForTests } from '../sync-db'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'

const accessMocks = vi.hoisted(() => ({
  unlinkRoot: vi.fn<() => Promise<void>>(async () => undefined)
}))

vi.mock('../sync-unlink', () => ({
  unlinkHhcLineAccountFromApp: vi.fn(async () => undefined),
  unlinkSyncRootFolderFromApp: accessMocks.unlinkRoot
}))

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function makeEntry(
  remoteItemId: string,
  itemId = remoteItemId
): {
  providerConnectionId: string
  remoteItemId: string
  parentRemoteItemId: string
  kind: 'file'
  name: string
  itemId: string
  mimeType: string
  size: number
} {
  return {
    providerConnectionId: 'connection-1',
    remoteItemId,
    parentRemoteItemId: 'folder-1',
    kind: 'file' as const,
    name: `${remoteItemId}.png`,
    itemId,
    mimeType: 'image/png',
    size: 100
  }
}

function makeProvider(
  downloadContent: ReadOnlySyncProvider['downloadContent'],
  classifyError: ReadOnlySyncProvider['classifyError'] = () => 'fatal'
): ReadOnlySyncProvider {
  return {
    providerType: 'onedrive',
    connect: vi.fn(),
    disconnect: vi.fn(),
    initialScan: vi.fn(),
    incrementalChanges: vi.fn(),
    getMetadata: vi.fn(),
    downloadContent,
    classifyError
  }
}

describe('sync download queue', () => {
  beforeEach(async () => {
    resetSyncDownloadQueueForTests()
    await resetFileExplorerDBForTests()
    await resetSyncDBForTests()
    vi.clearAllMocks()
    accessMocks.unlinkRoot.mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        nativeFs: {
          exists: vi.fn(async () => true)
        },
        hhcAssets: {
          cancelDownload: vi.fn(async () => undefined)
        }
      }
    })
  })

  it('uses one concurrent download', () => {
    expect(SYNC_DOWNLOAD_CONCURRENCY).toBe(1)
  })

  it('runs presentation priority before background work that has not started', async () => {
    const first = deferred<SyncDownloadResult>()
    const second = deferred<SyncDownloadResult>()
    const third = deferred<SyncDownloadResult>()
    const started: string[] = []
    const pending = new Map([
      ['background-1', first],
      ['background-2', second],
      ['presentation-1', third]
    ])
    const provider = makeProvider(
      vi.fn(async (request) => {
        started.push(request.remoteItemId)
        return pending.get(request.remoteItemId)!.promise
      })
    )

    const firstDownload = enqueueSyncDownload({
      provider,
      request: {
        providerConnectionId: 'connection-1',
        rootRemoteFolderId: 'folder-1',
        remoteItemId: 'background-1',
        targetBlobId: 'background-1',
        offlinePolicy: 'always-offline'
      },
      entry: makeEntry('background-1'),
      priority: 'background'
    })

    await vi.waitFor(() => expect(started).toEqual(['background-1']))

    const background = enqueueSyncDownload({
      provider,
      request: {
        providerConnectionId: 'connection-1',
        rootRemoteFolderId: 'folder-1',
        remoteItemId: 'background-2',
        targetBlobId: 'background-2',
        offlinePolicy: 'always-offline'
      },
      entry: makeEntry('background-2'),
      priority: 'background'
    })
    const presentation = enqueueSyncDownload({
      provider,
      request: {
        providerConnectionId: 'connection-1',
        rootRemoteFolderId: 'folder-1',
        remoteItemId: 'presentation-1',
        targetBlobId: 'presentation-1',
        offlinePolicy: 'always-offline'
      },
      entry: makeEntry('presentation-1'),
      priority: 'presentation'
    })

    first.resolve({ blobId: 'background-1', size: 100, mimeType: 'image/png' })
    await firstDownload
    await vi.waitFor(() => expect(started).toEqual(['background-1', 'presentation-1']))

    third.resolve({ blobId: 'presentation-1', size: 100, mimeType: 'image/png' })
    await presentation
    await vi.waitFor(() =>
      expect(started).toEqual(['background-1', 'presentation-1', 'background-2'])
    )
    second.resolve({ blobId: 'background-2', size: 100, mimeType: 'image/png' })
    await background
  })

  it('coalesces duplicate downloads for the same provider remote item', async () => {
    const done = deferred<SyncDownloadResult>()
    const provider = makeProvider(vi.fn(async () => done.promise))

    const first = enqueueSyncDownload({
      provider,
      request: {
        providerConnectionId: 'connection-1',
        rootRemoteFolderId: 'folder-1',
        remoteItemId: 'remote-1',
        targetBlobId: 'item-1',
        offlinePolicy: 'always-offline'
      },
      entry: makeEntry('remote-1', 'item-1'),
      priority: 'background'
    })
    const second = enqueueSyncDownload({
      provider,
      request: {
        providerConnectionId: 'connection-1',
        rootRemoteFolderId: 'folder-1',
        remoteItemId: 'remote-1',
        targetBlobId: 'item-1',
        offlinePolicy: 'always-offline'
      },
      entry: makeEntry('remote-1', 'item-1'),
      priority: 'presentation'
    })

    done.resolve({ blobId: 'item-1', size: 100, mimeType: 'image/png' })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { blobId: 'item-1', size: 100, mimeType: 'image/png' },
      { blobId: 'item-1', size: 100, mimeType: 'image/png' }
    ])
    expect(provider.downloadContent).toHaveBeenCalledTimes(1)
  })

  it('cancels active and queued downloads without committing a late response', async () => {
    const activeDownload = deferred<SyncDownloadResult>()
    const onDownloaded = vi.fn()
    let activeSignal: AbortSignal | undefined
    let canCommit: SyncDownloadCommitGuard | undefined
    const provider = makeProvider(
      vi.fn(async (_request, signal, guard) => {
        activeSignal = signal
        canCommit = guard
        return activeDownload.promise
      })
    )

    const active = enqueueSyncDownload({
      provider,
      request: {
        providerConnectionId: 'connection-a',
        rootRemoteFolderId: 'folder-1',
        remoteItemId: 'remote-a',
        targetBlobId: 'item-a',
        offlinePolicy: 'always-offline'
      },
      entry: { ...makeEntry('remote-a', 'item-a'), providerConnectionId: 'connection-a' },
      onDownloaded
    })
    await vi.waitFor(() => expect(activeSignal).toBeDefined())

    const queued = enqueueSyncDownload({
      provider,
      request: {
        providerConnectionId: 'connection-a',
        rootRemoteFolderId: 'folder-1',
        remoteItemId: 'remote-b',
        targetBlobId: 'item-b',
        offlinePolicy: 'always-offline'
      },
      entry: { ...makeEntry('remote-b', 'item-b'), providerConnectionId: 'connection-a' },
      onDownloaded
    })

    expect(cancelSyncDownloads({ providerConnectionId: 'connection-a' })).toBe(2)
    expect(activeSignal?.aborted).toBe(true)
    await expect(queued).resolves.toBeNull()
    let activeSettled = false
    void active.then(() => {
      activeSettled = true
    })
    await Promise.resolve()
    expect(activeSettled).toBe(false)
    expect(await canCommit!()).toBe(false)

    const followUp = enqueueSyncDownload({
      provider,
      request: {
        providerConnectionId: 'connection-a',
        rootRemoteFolderId: 'folder-1',
        remoteItemId: 'remote-c',
        targetBlobId: 'item-c',
        offlinePolicy: 'always-offline'
      },
      entry: { ...makeEntry('remote-c', 'item-c'), providerConnectionId: 'connection-a' }
    })
    activeDownload.resolve({ blobId: 'item-a', size: 100, mimeType: 'image/png' })
    await expect(active).resolves.toBeNull()
    await expect(followUp).resolves.toEqual({ blobId: 'item-a', size: 100, mimeType: 'image/png' })
    expect(onDownloaded).not.toHaveBeenCalled()
    await expect(getSyncEntryByRemoteItem('connection-a', 'remote-a')).resolves.not.toMatchObject({
      status: 'failed'
    })
  })

  it('cancels the main-process native download for an active HHC job', async () => {
    const activeDownload = deferred<SyncDownloadResult>()
    const provider = {
      ...makeProvider(vi.fn(async () => activeDownload.promise)),
      providerType: 'hhc-line' as const
    }
    const pending = enqueueSyncDownload({
      provider,
      request: {
        providerConnectionId: 'connection-a',
        rootRemoteFolderId: 'collection-a',
        remoteItemId: 'remote-a',
        targetBlobId: 'item-a',
        offlinePolicy: 'always-offline'
      },
      entry: { ...makeEntry('remote-a', 'item-a'), providerConnectionId: 'connection-a' }
    })
    await vi.waitFor(() => expect(provider.downloadContent).toHaveBeenCalledOnce())

    expect(cancelSyncDownloads({ providerConnectionId: 'connection-a' })).toBe(1)

    expect(window.api.hhcAssets.cancelDownload).toHaveBeenCalledWith('item-a')
    activeDownload.resolve({ blobId: 'item-a', size: 100, mimeType: 'image/png' })
    await expect(pending).resolves.toBeNull()
  })

  it('settles a failed job before awaiting its scoped access cleanup', async () => {
    const { handleHhcLineAccessError } = await import('../hhc-line-access')
    const forbidden = Object.assign(new Error('forbidden'), {
      classification: 'access-revoked',
      status: 403
    })
    const provider = {
      ...makeProvider(
        vi.fn(async () => Promise.reject(forbidden)),
        () => 'access-revoked'
      ),
      providerType: 'hhc-line' as const
    }
    useFileExplorerStore.setState({
      folders: {
        'root-a': {
          id: 'root-a',
          name: 'Root A',
          parentId: 'file-root',
          sortIndex: 0,
          createdAt: 1,
          expiresAt: null,
          syncLink: {
            providerType: 'hhc-line',
            providerConnectionId: 'connection-a',
            remoteFolderId: 'collection-a',
            offlinePolicy: 'online-only',
            status: 'active'
          }
        }
      }
    })
    let finishPurge!: () => void
    accessMocks.unlinkRoot.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPurge = resolve
        })
    )
    const cleanup = vi.fn((_error: unknown) =>
      handleHhcLineAccessError(
        { getSession: () => null, endSession: vi.fn(async () => undefined) },
        {
          kind: 'root',
          providerConnectionId: 'connection-a',
          rootRemoteFolderId: 'collection-a',
          remoteItemId: 'remote-a'
        },
        forbidden
      )
    )

    const result = enqueueSyncDownload({
      provider,
      request: {
        providerConnectionId: 'connection-a',
        rootRemoteFolderId: 'collection-a',
        remoteItemId: 'remote-a',
        targetBlobId: 'item-a',
        offlinePolicy: 'on-demand'
      },
      entry: {
        ...makeEntry('remote-a', 'item-a'),
        providerConnectionId: 'connection-a',
        parentRemoteItemId: 'collection-a'
      },
      onFailed: cleanup
    })

    await vi.waitFor(() => expect(accessMocks.unlinkRoot).toHaveBeenCalledOnce())
    let settled = false
    void result.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    finishPurge()
    await expect(result).resolves.toBeNull()
    expect(cleanup).toHaveBeenCalledWith(forbidden)
  })

  it('checks an authorization guard before using cached state or starting a download', async () => {
    const provider = makeProvider(vi.fn())
    const guard = vi.fn(async () => false)

    await expect(
      enqueueSyncDownload({
        provider,
        request: {
          providerConnectionId: 'connection-1',
          rootRemoteFolderId: 'folder-1',
          remoteItemId: 'remote-1',
          targetBlobId: 'item-1',
          offlinePolicy: 'always-offline'
        },
        entry: makeEntry('remote-1', 'item-1'),
        canCommit: guard
      })
    ).resolves.toBeNull()

    expect(guard).toHaveBeenCalled()
    expect(provider.downloadContent).not.toHaveBeenCalled()
    await expect(getSyncEntryByRemoteItem('connection-1', 'remote-1')).resolves.toBeUndefined()
  })

  it('drops a completed response before onDownloaded when authorization is revoked', async () => {
    const done = deferred<SyncDownloadResult>()
    let authorized = true
    const onDownloaded = vi.fn()
    const provider = makeProvider(vi.fn(async () => done.promise))
    const pending = enqueueSyncDownload({
      provider,
      request: {
        providerConnectionId: 'connection-1',
        rootRemoteFolderId: 'folder-1',
        remoteItemId: 'remote-1',
        targetBlobId: 'item-1',
        offlinePolicy: 'always-offline'
      },
      entry: makeEntry('remote-1', 'item-1'),
      canCommit: () => authorized,
      onDownloaded
    })
    await vi.waitFor(() => expect(provider.downloadContent).toHaveBeenCalledOnce())

    authorized = false
    done.resolve({ blobId: 'item-1', size: 100, mimeType: 'image/png' })

    await expect(pending).resolves.toBeNull()
    expect(onDownloaded).not.toHaveBeenCalled()
  })

  it('does not recreate failure metadata after another renderer revokes and deletes the source', async () => {
    const done = deferred<SyncDownloadResult>()
    let authorized = true
    const provider = makeProvider(vi.fn(async () => done.promise))
    const onFailed = vi.fn()
    const pending = enqueueSyncDownload({
      provider,
      request: {
        providerConnectionId: 'connection-1',
        rootRemoteFolderId: 'folder-1',
        remoteItemId: 'remote-1',
        targetBlobId: 'item-1',
        offlinePolicy: 'always-offline'
      },
      entry: makeEntry('remote-1', 'item-1'),
      canCommit: () => authorized,
      onFailed
    })
    await vi.waitFor(() => expect(provider.downloadContent).toHaveBeenCalledOnce())
    authorized = false
    await syncDb.deleteSyncEntriesByProviderConnection('connection-1')
    done.reject(new Error('late network error'))
    await expect(pending).resolves.toBeNull()
    expect(await getSyncEntryByRemoteItem('connection-1', 'remote-1')).toBeUndefined()
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('settles cancellation even if persisting a download failure rejects', async () => {
    const done = deferred<SyncDownloadResult>()
    const failedWrite = deferred<SyncEntryRecord>()
    const provider = makeProvider(vi.fn(async () => done.promise))
    const pending = enqueueSyncDownload({
      provider,
      request: {
        providerConnectionId: 'connection-1',
        rootRemoteFolderId: 'folder-1',
        remoteItemId: 'remote-1',
        targetBlobId: 'item-1',
        offlinePolicy: 'always-offline'
      },
      entry: makeEntry('remote-1', 'item-1')
    })
    await vi.waitFor(() => expect(provider.downloadContent).toHaveBeenCalledOnce())
    const write = vi.spyOn(syncDb, 'putSyncEntry').mockReturnValueOnce(failedWrite.promise)
    done.reject(new Error('network error'))
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    const cancelling = cancelSyncDownloadsAndWait({ providerConnectionId: 'connection-1' })
    failedWrite.reject(new Error('storage unavailable'))
    await expect(pending).resolves.toBeNull()
    await expect(cancelling).resolves.toBe(1)
    write.mockRestore()
  })

  it('skips a stale queued job when the file is already available offline', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'item-1',
      storage: 'native-fs',
      size: 100,
      refCount: 1
    })
    await putSyncEntry({
      ...makeEntry('remote-1', 'item-1'),
      blobId: 'item-1',
      etag: 'etag-1',
      contentHash: 'hash-1',
      status: 'available-offline',
      downloadedBytes: 100,
      downloadTotalBytes: 100
    })
    const provider = makeProvider(vi.fn())

    await expect(
      enqueueSyncDownload({
        provider,
        request: {
          providerConnectionId: 'connection-1',
          rootRemoteFolderId: 'folder-1',
          remoteItemId: 'remote-1',
          targetBlobId: 'item-1',
          offlinePolicy: 'always-offline'
        },
        entry: {
          ...makeEntry('remote-1', 'item-1'),
          etag: 'etag-1',
          contentHash: 'hash-1'
        },
        priority: 'background'
      })
    ).resolves.toEqual({ blobId: 'item-1', size: 100, mimeType: 'image/png' })

    expect(provider.downloadContent).not.toHaveBeenCalled()
    await expect(getSyncEntryByRemoteItem('connection-1', 'remote-1')).resolves.toMatchObject({
      status: 'available-offline',
      blobId: 'item-1'
    })
  })

  it('does not skip a stale queued job when the native file is missing', async () => {
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'item-1',
      storage: 'native-fs',
      size: 100,
      refCount: 1
    })
    await putSyncEntry({
      ...makeEntry('remote-1', 'item-1'),
      blobId: 'item-1',
      etag: 'etag-1',
      status: 'available-offline'
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        nativeFs: {
          exists: vi.fn(async () => false)
        }
      }
    })
    const provider = makeProvider(
      vi.fn(async () => ({ blobId: 'item-1', size: 100, mimeType: 'image/png' }))
    )

    await enqueueSyncDownload({
      provider,
      request: {
        providerConnectionId: 'connection-1',
        rootRemoteFolderId: 'folder-1',
        remoteItemId: 'remote-1',
        targetBlobId: 'item-1',
        offlinePolicy: 'always-offline'
      },
      entry: {
        ...makeEntry('remote-1', 'item-1'),
        etag: 'etag-1'
      },
      priority: 'background'
    })

    expect(provider.downloadContent).toHaveBeenCalledTimes(1)
  })

  it('writes retry metadata when a download fails', async () => {
    const provider = makeProvider(
      vi.fn(async () => {
        throw new Error('network down')
      }),
      () => 'retryable'
    )

    await expect(
      enqueueSyncDownload({
        provider,
        request: {
          providerConnectionId: 'connection-1',
          rootRemoteFolderId: 'folder-1',
          remoteItemId: 'remote-1',
          targetBlobId: 'item-1',
          offlinePolicy: 'always-offline'
        },
        entry: makeEntry('remote-1', 'item-1'),
        priority: 'background'
      })
    ).resolves.toBeNull()

    const entry = await getSyncEntryByRemoteItem('connection-1', 'remote-1')
    expect(entry).toMatchObject({
      status: 'failed',
      errorKind: 'retryable',
      retryCount: 1,
      lastError: 'network down'
    })
    expect(entry?.nextRetryAt).toEqual(expect.any(Number))
  })
})
