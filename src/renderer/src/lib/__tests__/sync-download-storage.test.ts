import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockToast = vi.hoisted(() => ({ danger: vi.fn() }))
vi.mock('@heroui/react/toast', () => ({ toast: mockToast }))
vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

import {
  saveElectronOneDriveDownloadedContent,
  saveWebHhcDownloadedContent,
  saveWebOneDriveDownloadedContent
} from '../sync-download-storage'
import { MAX_FILE_SIZE_WEB } from '../media-limits'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import {
  deleteSyncEntries,
  getSyncEntryByRemoteItem,
  putSyncEntry,
  resetSyncDBForTests
} from '../sync-db'

vi.mock('../env', () => ({
  isElectron: vi.fn(() => false),
  isWeb: vi.fn(() => true)
}))

import { isElectron } from '../env'

const request = {
  providerConnectionId: 'onedrive:account-1',
  rootRemoteFolderId: 'remote-root-1',
  remoteItemId: 'remote-file-1',
  targetBlobId: 'blob-1',
  offlinePolicy: 'on-demand' as const
}

const metadata = {
  remoteItemId: 'remote-file-1',
  parentRemoteItemId: 'remote-folder-1',
  kind: 'file' as const,
  name: 'clip.mp4',
  mimeType: 'video/mp4',
  size: 10,
  etag: 'etag-1',
  contentHash: 'hash-1'
}

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

beforeEach(async () => {
  await resetFileExplorerDBForTests()
  await resetSyncDBForTests()
  mockToast.danger.mockClear()
  vi.mocked(isElectron).mockReturnValue(false)
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      estimate: vi.fn(async () => ({ quota: 1024 * 1024, usage: 0 }))
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      oneDrive: {
        getAccessToken: vi.fn(async () => ({
          accessToken: 'access-token',
          expiresAt: Date.now() + 3600_000,
          scope: 'offline_access User.Read Files.Read',
          tokenType: 'Bearer'
        })),
        downloadFile: vi.fn(async () => ({
          fileId: request.targetBlobId,
          size: 10,
          mimeType: 'video/mp4'
        })),
        onDownloadProgress: vi.fn(() => () => undefined)
      },
      nativeFs: {
        delete: vi.fn(async () => undefined)
      }
    }
  })
})

it('caps HHC browser downloads at 256 MiB without weakening OneDrive 2 GiB', async () => {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { estimate: vi.fn(async () => ({ quota: 4 * 1024 ** 3, usage: 0 })) }
  })
  const overHhcLimit = 256 * 1024 * 1024 + 1

  await expect(
    saveWebHhcDownloadedContent(
      request,
      new Response(new Uint8Array([1]), {
        headers: { 'Content-Length': String(overHhcLimit), 'Content-Type': 'video/mp4' }
      }),
      metadata
    )
  ).rejects.toThrow('HHC file exceeds the Web 256MiB limit')

  await expect(
    saveWebOneDriveDownloadedContent(
      request,
      new Response(new Uint8Array([1]), {
        headers: { 'Content-Length': String(overHhcLimit), 'Content-Type': 'video/mp4' }
      }),
      metadata
    )
  ).resolves.toMatchObject({ size: 1 })
})

describe('saveWebOneDriveDownloadedContent', () => {
  it('stores downloaded content in IndexedDB and marks the sync entry available offline', async () => {
    const response = new Response(new Uint8Array(13), {
      headers: { 'Content-Length': '13' }
    })

    await expect(saveWebOneDriveDownloadedContent(request, response, metadata)).resolves.toEqual({
      blobId: 'blob-1',
      size: 13,
      mimeType: 'video/mp4'
    })

    const db = await openFileExplorerDB()
    await expect(db.get('file-blobs', 'blob-1')).resolves.toMatchObject({
      id: 'blob-1',
      storage: 'indexed-db',
      size: 13,
      refCount: 1
    })
    await expect(
      getSyncEntryByRemoteItem('onedrive:account-1', 'remote-file-1')
    ).resolves.toMatchObject({
      blobId: 'blob-1',
      status: 'available-offline',
      etag: 'etag-1',
      contentHash: 'hash-1'
    })
  })

  it('records Web download progress while streaming content', async () => {
    const response = new Response(new Uint8Array(13), {
      headers: { 'Content-Length': '13' }
    })

    await saveWebOneDriveDownloadedContent(request, response, metadata)

    await expect(
      getSyncEntryByRemoteItem('onedrive:account-1', 'remote-file-1')
    ).resolves.toMatchObject({
      downloadedBytes: 13,
      downloadTotalBytes: 13
    })
  })

  it('does not recreate a sync entry when Web progress is cancelled during persistence', async () => {
    const entry = await putSyncEntry({
      providerConnectionId: request.providerConnectionId,
      remoteItemId: request.remoteItemId,
      parentRemoteItemId: metadata.parentRemoteItemId,
      kind: 'file',
      name: metadata.name,
      itemId: request.targetBlobId,
      status: 'downloading'
    })
    const progressRead = deferred<void>()
    const releaseProgress = deferred<boolean>()
    let checks = 0
    const canCommit = vi.fn(() => {
      checks += 1
      if (checks === 2) {
        progressRead.resolve()
        return releaseProgress.promise
      }
      return checks < 2
    })
    const saving = saveWebOneDriveDownloadedContent(
      request,
      new Response(new Uint8Array(13), { headers: { 'Content-Length': '13' } }),
      metadata,
      canCommit
    )

    await vi.waitFor(() => expect(canCommit).toHaveBeenCalledTimes(2), { timeout: 100 })
    await progressRead.promise
    await deleteSyncEntries([entry.id])
    releaseProgress.resolve(false)

    await expect(saving).rejects.toThrow('Sync download cancelled')
    await expect(
      getSyncEntryByRemoteItem('onedrive:account-1', 'remote-file-1')
    ).resolves.toBeUndefined()
  })

  it('removes a Web blob when cancellation wins during durable storage', async () => {
    const db = await openFileExplorerDB()
    const originalPut = db.put.bind(db)
    const storageStarted = deferred<void>()
    const releaseStorage = deferred<void>()
    const putSpy = vi.spyOn(db, 'put').mockImplementationOnce(async (...args) => {
      storageStarted.resolve()
      await releaseStorage.promise
      return originalPut(...args)
    })
    let canCommit = true
    const saving = saveWebOneDriveDownloadedContent(
      request,
      new Response(new Uint8Array(13), { headers: { 'Content-Length': '13' } }),
      metadata,
      () => canCommit
    )
    await storageStarted.promise
    canCommit = false
    releaseStorage.resolve()

    try {
      await expect(saving).rejects.toThrow('Sync download cancelled')
    } finally {
      putSpy.mockRestore()
    }
    await expect(db.get('file-blobs', 'blob-1')).resolves.toBeUndefined()
    await expect(
      getSyncEntryByRemoteItem('onedrive:account-1', 'remote-file-1')
    ).resolves.toBeUndefined()
  })

  it('publishes recovery change only after cancelled Web Blob cleanup settles', async () => {
    const db = await openFileExplorerDB()
    const originalDelete = db.delete.bind(db)
    const cleanupStarted = deferred<void>()
    const releaseCleanup = deferred<void>()
    const deleteSpy = vi.spyOn(db, 'delete').mockImplementationOnce(async (...args) => {
      cleanupStarted.resolve()
      await releaseCleanup.promise
      return originalDelete(...args)
    })
    const cancellationCheckStarted = deferred<void>()
    const releaseCancellation = deferred<boolean>()
    const canCommit = vi.fn(async () => {
      const entry = await getSyncEntryByRemoteItem(
        request.providerConnectionId,
        request.remoteItemId
      )
      if (!entry?.blobId) return true
      cancellationCheckStarted.resolve()
      return releaseCancellation.promise
    })
    const recoveryScan = vi.fn()
    window.addEventListener('hhc:recovery-source-changed', recoveryScan)
    const saving = saveWebOneDriveDownloadedContent(
      request,
      new Response(new Uint8Array(13), { headers: { 'Content-Length': '13' } }),
      metadata,
      canCommit
    )

    await cancellationCheckStarted.promise
    recoveryScan.mockClear()
    releaseCancellation.resolve(false)
    await cleanupStarted.promise
    await vi.waitFor(async () => {
      expect(
        await getSyncEntryByRemoteItem(request.providerConnectionId, request.remoteItemId)
      ).toBeUndefined()
    })
    const scansBeforeCleanup = recoveryScan.mock.calls.length
    releaseCleanup.resolve()
    const failure = await saving.catch((error: unknown) => error)
    window.removeEventListener('hhc:recovery-source-changed', recoveryScan)
    deleteSpy.mockRestore()

    expect(scansBeforeCleanup).toBe(0)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('Sync download cancelled')
    expect(recoveryScan).toHaveBeenCalledOnce()
  })

  it('rejects downloads above the Web 2GB product limit', async () => {
    const response = new Response('', {
      headers: { 'Content-Length': String(MAX_FILE_SIZE_WEB + 1) }
    })

    await expect(saveWebOneDriveDownloadedContent(request, response, metadata)).rejects.toThrow(
      'OneDrive file exceeds the Web 2GB limit'
    )
  })

  it('rejects downloads when browser quota is insufficient', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: vi.fn(async () => ({ quota: 10, usage: 9 }))
      }
    })
    const response = new Response(new Uint8Array(13), {
      headers: { 'Content-Length': '13' }
    })

    await expect(saveWebOneDriveDownloadedContent(request, response, metadata)).rejects.toThrow(
      'OneDrive sync storage has reached 80% usage'
    )
    expect(mockToast.danger).toHaveBeenCalledWith('toast.syncStorageLimitReached')
    await expect(
      getSyncEntryByRemoteItem('onedrive:account-1', 'remote-file-1')
    ).resolves.toMatchObject({
      status: 'insufficient-storage'
    })
  })

  it('does not restore Web insufficient-storage state after cancellation cleanup', async () => {
    const entry = await putSyncEntry({
      providerConnectionId: request.providerConnectionId,
      remoteItemId: request.remoteItemId,
      parentRemoteItemId: metadata.parentRemoteItemId,
      kind: 'file',
      name: metadata.name,
      itemId: request.targetBlobId,
      status: 'downloading'
    })
    const estimateStarted = deferred<void>()
    const releaseEstimate = deferred<{ quota: number; usage: number }>()
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: vi.fn(async () => {
          estimateStarted.resolve()
          return releaseEstimate.promise
        })
      }
    })
    let canCommit = true
    const saving = saveWebOneDriveDownloadedContent(
      request,
      new Response(new Uint8Array(13), { headers: { 'Content-Length': '13' } }),
      metadata,
      () => canCommit
    )

    await estimateStarted.promise
    canCommit = false
    await deleteSyncEntries([entry.id])
    releaseEstimate.resolve({ quota: 10, usage: 9 })

    await expect(saving).rejects.toThrow('OneDrive sync storage has reached 80% usage')
    await expect(
      getSyncEntryByRemoteItem('onedrive:account-1', 'remote-file-1')
    ).resolves.toBeUndefined()
    expect(mockToast.danger).not.toHaveBeenCalled()
  })

  it('rejects downloads that would push browser storage above 80 percent', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: vi.fn(async () => ({ quota: 100, usage: 75 }))
      }
    })
    const response = new Response(new Uint8Array(10), {
      headers: { 'Content-Length': '10' }
    })

    await expect(saveWebOneDriveDownloadedContent(request, response, metadata)).rejects.toThrow(
      'OneDrive sync storage has reached 80% usage'
    )
  })

  it('does not allow Electron to use the Web Blob download path', async () => {
    vi.mocked(isElectron).mockReturnValue(true)

    await expect(
      saveWebOneDriveDownloadedContent(request, new Response(''), metadata)
    ).rejects.toThrow('Electron OneDrive downloads must use native streaming storage')
  })

  it('stores Electron native download metadata without reading the file into renderer memory', async () => {
    vi.mocked(isElectron).mockReturnValue(true)

    await expect(
      saveElectronOneDriveDownloadedContent(
        request,
        '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02',
        metadata
      )
    ).resolves.toEqual({
      blobId: 'blob-1',
      size: 10,
      mimeType: 'video/mp4'
    })

    expect(window.api.oneDrive.getAccessToken).toHaveBeenCalledWith({
      connectionId: 'onedrive:account-1',
      clientId: '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02'
    })
    expect(window.api.oneDrive.downloadFile).toHaveBeenCalledWith({
      remoteItemId: 'remote-file-1',
      targetFileId: 'blob-1',
      accessToken: 'access-token',
      expectedSize: 10,
      mimeType: 'video/mp4'
    })
    const db = await openFileExplorerDB()
    await expect(db.get('file-blobs', 'blob-1')).resolves.toMatchObject({
      id: 'blob-1',
      storage: 'native-fs',
      size: 10,
      refCount: 1
    })
    await expect(
      getSyncEntryByRemoteItem('onedrive:account-1', 'remote-file-1')
    ).resolves.toMatchObject({
      blobId: 'blob-1',
      status: 'available-offline'
    })
  })

  it('removes a native file when cancellation wins during storage', async () => {
    vi.mocked(isElectron).mockReturnValue(true)
    const downloadStarted = deferred<void>()
    const releaseDownload = deferred<{
      fileId: string
      size: number
      mimeType: string
    }>()
    vi.mocked(window.api.oneDrive.downloadFile).mockImplementationOnce(async () => {
      downloadStarted.resolve()
      return releaseDownload.promise
    })
    let canCommit = true
    const saving = saveElectronOneDriveDownloadedContent(
      request,
      '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02',
      metadata,
      () => canCommit
    )
    await downloadStarted.promise
    canCommit = false
    releaseDownload.resolve({ fileId: 'blob-1', size: 10, mimeType: 'video/mp4' })

    await expect(saving).rejects.toThrow('Sync download cancelled')
    expect(window.api.nativeFs.delete).toHaveBeenCalledWith('blob-1')
    const db = await openFileExplorerDB()
    await expect(db.get('file-blobs', 'blob-1')).resolves.toBeUndefined()
    await expect(
      getSyncEntryByRemoteItem('onedrive:account-1', 'remote-file-1')
    ).resolves.toBeUndefined()
  })

  it('waits for cancelled Electron cleanup and surfaces its failure before recovery refresh', async () => {
    vi.mocked(isElectron).mockReturnValue(true)
    const cleanupStarted = deferred<void>()
    const releaseCleanup = deferred<void>()
    const cleanupFailure = new Error('native cleanup failed')
    vi.mocked(window.api.nativeFs.delete).mockImplementationOnce(async () => {
      cleanupStarted.resolve()
      await releaseCleanup.promise
      throw cleanupFailure
    })
    const releaseCancellation = deferred<boolean>()
    let checks = 0
    const canCommit = vi.fn(() => {
      checks += 1
      return checks === 3 ? releaseCancellation.promise : true
    })
    const recoveryScan = vi.fn()
    window.addEventListener('hhc:recovery-source-changed', recoveryScan)
    const saving = saveElectronOneDriveDownloadedContent(
      request,
      '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02',
      metadata,
      canCommit
    )

    await vi.waitFor(() => expect(canCommit).toHaveBeenCalledTimes(3))
    recoveryScan.mockClear()
    releaseCancellation.resolve(false)
    await cleanupStarted.promise
    const scansBeforeCleanup = recoveryScan.mock.calls.length
    releaseCleanup.resolve()
    const failure = await saving.catch((error: unknown) => error)
    window.removeEventListener('hhc:recovery-source-changed', recoveryScan)

    expect(scansBeforeCleanup).toBe(0)
    expect(failure).toBe(cleanupFailure)
    expect(recoveryScan).toHaveBeenCalledOnce()
  })

  it('does not recreate a sync entry when native progress is cancelled during persistence', async () => {
    vi.mocked(isElectron).mockReturnValue(true)
    const entry = await putSyncEntry({
      providerConnectionId: request.providerConnectionId,
      remoteItemId: request.remoteItemId,
      parentRemoteItemId: metadata.parentRemoteItemId,
      kind: 'file',
      name: metadata.name,
      itemId: request.targetBlobId,
      status: 'downloading'
    })
    const progressRead = deferred<void>()
    const releaseProgress = deferred<boolean>()
    const releaseDownload = deferred<{ fileId: string; size: number; mimeType: string }>()
    let checks = 0
    const canCommit = vi.fn(() => {
      checks += 1
      if (checks === 2) {
        progressRead.resolve()
        return releaseProgress.promise
      }
      return checks < 2
    })
    let reportProgress:
      | ((progress: {
          targetFileId: string
          downloadedBytes: number
          downloadTotalBytes: number
        }) => void)
      | undefined
    vi.mocked(window.api.oneDrive.onDownloadProgress).mockImplementation((listener) => {
      reportProgress = listener
      return () => undefined
    })
    vi.mocked(window.api.oneDrive.downloadFile).mockImplementationOnce(async () => {
      reportProgress?.({
        targetFileId: request.targetBlobId,
        downloadedBytes: 5,
        downloadTotalBytes: 10
      })
      return releaseDownload.promise
    })
    const saving = saveElectronOneDriveDownloadedContent(
      request,
      '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02',
      metadata,
      canCommit
    )

    await vi.waitFor(() => expect(canCommit).toHaveBeenCalledTimes(2), { timeout: 100 })
    await progressRead.promise
    await deleteSyncEntries([entry.id])
    releaseProgress.resolve(false)
    releaseDownload.resolve({ fileId: 'blob-1', size: 10, mimeType: 'video/mp4' })

    await expect(saving).rejects.toThrow('Sync download cancelled')
    await expect(
      getSyncEntryByRemoteItem('onedrive:account-1', 'remote-file-1')
    ).resolves.toBeUndefined()
  })

  it('removes the native file if metadata persistence fails', async () => {
    vi.mocked(isElectron).mockReturnValue(true)
    const db = await openFileExplorerDB()
    const putSpy = vi.spyOn(db, 'put').mockRejectedValueOnce(new Error('db failed'))

    await expect(
      saveElectronOneDriveDownloadedContent(
        request,
        '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02',
        metadata
      )
    ).rejects.toThrow('db failed')

    expect(window.api.nativeFs.delete).toHaveBeenCalledWith('blob-1')
    putSpy.mockRestore()
  })

  it('marks Electron native downloads insufficient when storage limit is reached', async () => {
    vi.mocked(isElectron).mockReturnValue(true)
    vi.mocked(window.api.oneDrive.downloadFile).mockRejectedValueOnce(
      new Error('OneDrive sync storage has reached 80% usage')
    )

    await expect(
      saveElectronOneDriveDownloadedContent(
        request,
        '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02',
        metadata
      )
    ).rejects.toThrow('OneDrive sync storage has reached 80% usage')

    expect(mockToast.danger).toHaveBeenCalledWith('toast.syncStorageLimitReached')
    await expect(
      getSyncEntryByRemoteItem('onedrive:account-1', 'remote-file-1')
    ).resolves.toMatchObject({
      status: 'insufficient-storage'
    })
  })

  it('does not restore Electron insufficient-storage state after cancellation cleanup', async () => {
    vi.mocked(isElectron).mockReturnValue(true)
    const entry = await putSyncEntry({
      providerConnectionId: request.providerConnectionId,
      remoteItemId: request.remoteItemId,
      parentRemoteItemId: metadata.parentRemoteItemId,
      kind: 'file',
      name: metadata.name,
      itemId: request.targetBlobId,
      status: 'downloading'
    })
    const downloadStarted = deferred<void>()
    const releaseDownload = deferred<never>()
    vi.mocked(window.api.oneDrive.downloadFile).mockImplementationOnce(async () => {
      downloadStarted.resolve()
      return releaseDownload.promise
    })
    let canCommit = true
    const saving = saveElectronOneDriveDownloadedContent(
      request,
      '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02',
      metadata,
      () => canCommit
    )

    await downloadStarted.promise
    canCommit = false
    await deleteSyncEntries([entry.id])
    releaseDownload.reject(new Error('OneDrive sync storage has reached 80% usage'))

    await expect(saving).rejects.toThrow('OneDrive sync storage has reached 80% usage')
    await expect(
      getSyncEntryByRemoteItem('onedrive:account-1', 'remote-file-1')
    ).resolves.toBeUndefined()
    expect(mockToast.danger).not.toHaveBeenCalled()
  })

  it('does not allow Web mode to use native download storage', async () => {
    await expect(
      saveElectronOneDriveDownloadedContent(
        request,
        '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02',
        metadata
      )
    ).rejects.toThrow('Native OneDrive downloads are only available in Electron')
  })
})

it.each([false, true])(
  'protects an incomplete download commit from repair (native=%s)',
  async (native) => {
    vi.mocked(isElectron).mockReturnValue(native)
    const { repairMediaStorageIntegrity } = await import('../media-storage-integrity')
    const { retryPendingResourceCleanups } = await import('../resource-cleanup-journal')
    const { isMediaResourceLocked } = await import('../media-resource-locks')
    const db = await openFileExplorerDB()
    const written = deferred<void>()
    const resume = deferred<void>()
    let blocked = false
    const canCommit = async (): Promise<boolean> => {
      if (!blocked && (await db.get('file-blobs', request.targetBlobId))) {
        blocked = true
        written.resolve()
        await resume.promise
      }
      return true
    }
    const pending = native
      ? saveElectronOneDriveDownloadedContent(request, 'client-id', metadata, canCommit)
      : saveWebOneDriveDownloadedContent(
          request,
          new Response(new Uint8Array([1])),
          metadata,
          canCommit
        )
    await written.promise
    expect(isMediaResourceLocked(request.targetBlobId)).toBe(true)
    await repairMediaStorageIntegrity()
    expect(await db.get('file-blobs', request.targetBlobId)).toBeDefined()
    expect(window.api.nativeFs.delete).not.toHaveBeenCalled()
    resume.resolve()
    await pending
    await retryPendingResourceCleanups()
    expect(await db.get('file-blobs', request.targetBlobId)).toBeDefined()
    expect(
      (await getSyncEntryByRemoteItem(request.providerConnectionId, request.remoteItemId))?.blobId
    ).toBe(request.targetBlobId)
    expect(isMediaResourceLocked(request.targetBlobId)).toBe(false)
  }
)
