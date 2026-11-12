import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { HhcAssetApiError, type HhcAssetApi } from '../hhc-asset-api'
import { HhcLineReadonlyProvider } from '../hhc-line-provider'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { getProviderConnection, getSyncEntryByRemoteItem, resetSyncDBForTests } from '../sync-db'
import { handleHhcLineAccessError } from '../hhc-line-access'
import { projectHhcAssetItem } from '@shared/hhc-assets'

const collection = {
  id: 'collection_1',
  namespace: 'line.group.media-sync',
  name: 'Group media',
  revision: 9,
  createdAt: '2026-08-17T00:00:00Z',
  updatedAt: '2026-08-17T00:00:00Z'
}

const item = {
  id: 'item_1',
  collectionId: collection.id,
  remoteItemId: 'line-source-key',
  displayName: 'photo.jpg',
  sourceRevision: 'sha256:abc',
  createdRevision: 8,
  mimeType: 'image/jpeg',
  sizeBytes: 42,
  etag: '"etag-1"',
  createdAt: '2026-08-17T00:00:00Z'
}

function api(): HhcAssetApi {
  return {
    getCollectionControl: vi.fn(async () => {
      throw new HhcAssetApiError('access-revoked', 404)
    }),
    listCollections: vi.fn(),
    getCollectionChanges: vi.fn(async () => ({
      collection,
      items: [item],
      tombstones: [
        {
          id: 'item_deleted',
          remoteItemId: 'deleted-source',
          deletedRevision: 9,
          deletedAt: '2026-08-17T00:01:00Z'
        }
      ],
      cursor: 'revision_9',
      hasMore: false,
      reset: true
    })),
    getCollectionItem: vi.fn(async () => item),
    issueContentTicket: vi.fn(),
    getRemoteContentSource: vi.fn(async () => ({
      kind: 'ticket' as const,
      url: 'https://www.alive.org.tw/api/assets/content?ticket=secret',
      expiresAt: 9_999_999_999,
      etag: '"etag-1"'
    })),
    downloadContent: vi.fn(async () => new Response('content')),
    recordSyncReceipt: vi.fn(async () => undefined)
  }
}

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

beforeEach(async () => {
  await resetFileExplorerDBForTests()
  await resetSyncDBForTests()
  window.api = {
    nativeFs: { delete: vi.fn(async () => undefined) }
  } as unknown as typeof window.api
})

describe('HHC LINE read-only provider', () => {
  it('preserves item update metadata in the public Asset contract', () => {
    expect(
      projectHhcAssetItem({
        ...item,
        updatedRevision: 9,
        updatedAt: '2026-08-18T00:00:00Z'
      })
    ).toMatchObject({
      updatedRevision: 9,
      updatedAt: '2026-08-18T00:00:00Z'
    })
  })

  it('connects the current HHC account through the deterministic account connection', async () => {
    const provider = new HhcLineReadonlyProvider({
      api: api(),
      getSession: vi.fn(async () => ({
        userId: 'user_1',
        displayName: 'Ada',
        roles: ['media_sync_user']
      }))
    })

    await expect(provider.connect()).resolves.toEqual({
      id: 'hhc-line:user_1',
      providerType: 'hhc-line',
      displayName: 'HHC LINE',
      accountLabel: 'Ada'
    })
    await expect(getProviderConnection('hhc-line:user_1')).resolves.toMatchObject({
      accountUserId: 'user_1'
    })
  })

  it('maps collection items, reset snapshots, tombstones, revisions, and 500-item pages', async () => {
    const client = api()
    const provider = new HhcLineReadonlyProvider({ api: client, getSession: vi.fn() })

    const page = await provider.initialScan('hhc-line:user_1', collection.id)

    expect(client.getCollectionChanges).toHaveBeenCalledWith(collection.id)
    expect(page).toEqual({
      items: [
        {
          remoteItemId: 'item_1',
          parentRemoteItemId: 'collection_1',
          kind: 'file',
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: 42,
          etag: '"etag-1"',
          contentHash: 'sha256:abc',
          sourceCreatedAt: Date.parse(item.createdAt)
        },
        {
          remoteItemId: 'item_deleted',
          parentRemoteItemId: 'collection_1',
          kind: 'file',
          name: 'item_deleted',
          deleted: true
        }
      ],
      nextCursor: 'revision_9',
      hasMore: false,
      reset: true
    })
  })

  it('omits an invalid asset creation time', async () => {
    const client = api()
    vi.mocked(client.getCollectionItem).mockResolvedValueOnce({ ...item, createdAt: 'invalid' })
    const provider = new HhcLineReadonlyProvider({ api: client, getSession: vi.fn() })
    await provider.initialScan('hhc-line:user_1', collection.id)

    await expect(provider.getMetadata('hhc-line:user_1', item.id)).resolves.not.toHaveProperty(
      'sourceCreatedAt'
    )
  })

  it('passes the per-root collection ID through metadata, content, and source requests', async () => {
    const client = api()
    const saveDownloadedContent = vi.fn(async () => ({
      blobId: 'blob_1',
      size: 7,
      mimeType: 'image/jpeg'
    }))
    const provider = new HhcLineReadonlyProvider({
      api: client,
      getSession: vi.fn(),
      saveDownloadedContent
    })

    await provider.initialScan('hhc-line:user_1', collection.id)
    await expect(provider.getMetadata('hhc-line:user_1', item.id)).resolves.toMatchObject({
      remoteItemId: item.id,
      parentRemoteItemId: collection.id,
      contentHash: item.sourceRevision
    })
    await expect(
      provider.getRemoteContentSource('hhc-line:user_1', item.id)
    ).resolves.toMatchObject({
      kind: 'ticket'
    })
    await provider.downloadContent(
      {
        providerConnectionId: 'hhc-line:user_1',
        rootRemoteFolderId: collection.id,
        remoteItemId: item.id,
        targetBlobId: 'blob_1',
        offlinePolicy: 'on-demand'
      },
      new AbortController().signal,
      () => true
    )

    expect(client.getCollectionItem).toHaveBeenCalledWith(collection.id, item.id)
    expect(client.getRemoteContentSource).toHaveBeenCalledWith(collection.id, item.id)
    expect(client.downloadContent).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionId: collection.id,
        itemId: item.id,
        rootRemoteFolderId: collection.id
      }),
      expect.any(AbortSignal)
    )
  })

  it.each(['on-demand', 'online-only'] as const)(
    'does not emit an available-offline receipt for %s downloads',
    async (offlinePolicy) => {
      const client = api()
      const provider = new HhcLineReadonlyProvider({
        api: client,
        getSession: vi.fn(),
        saveDownloadedContent: vi.fn(async () => ({
          blobId: 'blob_1',
          size: 7,
          mimeType: 'image/jpeg'
        }))
      })

      await provider.downloadContent(
        {
          providerConnectionId: 'hhc-line:user_1',
          rootRemoteFolderId: collection.id,
          remoteItemId: item.id,
          targetBlobId: 'blob_1',
          offlinePolicy
        },
        new AbortController().signal,
        () => true
      )

      expect(client.recordSyncReceipt).not.toHaveBeenCalled()
    }
  )

  it.each(['native', 'web'])(
    'persists a failed %s receipt and retries from a new provider without downloading again',
    async (mode) => {
      const client = api()
      if (mode === 'web') Reflect.deleteProperty(window, 'api')
      else
        vi.mocked(client.downloadContent).mockResolvedValue({
          fileId: 'blob_1',
          size: 7,
          mimeType: 'image/jpeg'
        })
      vi.mocked(client.recordSyncReceipt)
        .mockRejectedValueOnce(new TypeError('offline'))
        .mockResolvedValue(undefined)
      const provider = new HhcLineReadonlyProvider({ api: client, getSession: vi.fn() })
      const request = {
        providerConnectionId: 'hhc-line:user_1',
        rootRemoteFolderId: collection.id,
        remoteItemId: item.id,
        targetBlobId: 'blob_1',
        offlinePolicy: 'always-offline' as const
      }
      await expect(
        provider.downloadContent(request, new AbortController().signal, () => true)
      ).resolves.toMatchObject({ blobId: 'blob_1' })
      await vi.waitFor(async () =>
        expect(
          (await getSyncEntryByRemoteItem(request.providerConnectionId, item.id))?.syncReceipt
            ?.attempts
        ).toBe(1)
      )
      const entry = await getSyncEntryByRemoteItem(request.providerConnectionId, item.id)
      expect(entry?.syncReceipt).toMatchObject({ contentVersion: item.etag, state: 'pending' })
      const now = vi.spyOn(Date, 'now').mockReturnValue(entry!.syncReceipt!.nextRetryAt)
      try {
        const next = new HhcLineReadonlyProvider({ api: client, getSession: vi.fn() })
        await next.retryReceipt(request.providerConnectionId, item.id, () => true)
        await next.retryReceipt(request.providerConnectionId, item.id, () => true)
        expect(client.downloadContent).toHaveBeenCalledOnce()
        expect(client.recordSyncReceipt).toHaveBeenCalledTimes(2)
        expect(client.recordSyncReceipt).toHaveBeenLastCalledWith({
          collectionItemId: item.id,
          contentVersion: item.etag,
          state: 'available-offline',
          appVersion: '0.0.0-test'
        })
      } finally {
        now.mockRestore()
      }
    }
  )

  it.each(['changes', 'metadata', 'source'] as const)(
    'reports %s Asset failures with the exact root scope',
    async (operation) => {
      const client = api()
      const error = Object.assign(new Error('forbidden'), {
        classification: 'access-revoked',
        status: 403
      })
      const onAccessError = vi.fn(async () => undefined)
      if (operation === 'changes') vi.mocked(client.getCollectionChanges).mockRejectedValue(error)
      if (operation === 'metadata') vi.mocked(client.getCollectionItem).mockRejectedValue(error)
      if (operation === 'source') vi.mocked(client.getRemoteContentSource).mockRejectedValue(error)
      const provider = new HhcLineReadonlyProvider({
        api: client,
        getSession: vi.fn(),
        onAccessError
      })

      if (operation !== 'changes') await provider.initialScan('hhc-line:user_1', collection.id)
      const request =
        operation === 'changes'
          ? provider.initialScan('hhc-line:user_1', collection.id)
          : operation === 'metadata'
            ? provider.getMetadata('hhc-line:user_1', item.id)
            : provider.getRemoteContentSource('hhc-line:user_1', item.id)

      await expect(request).rejects.toBe(error)
      expect(onAccessError).toHaveBeenCalledWith(
        {
          providerConnectionId: 'hhc-line:user_1',
          rootRemoteFolderId: collection.id,
          ...(operation === 'changes' ? {} : { remoteItemId: item.id })
        },
        error,
        undefined
      )
    }
  )

  it.each([
    ['metadata', 'account switch'],
    ['metadata', 'same-user re-login'],
    ['ticket', 'account switch'],
    ['ticket', 'same-user re-login']
  ] as const)(
    'does not end a newer session for a delayed %s 401 after %s',
    async (operation, transition) => {
      const client = api()
      let rejectRequest!: (error: unknown) => void
      if (operation === 'metadata') {
        vi.mocked(client.getCollectionItem).mockReturnValue(
          new Promise((_, reject) => {
            rejectRequest = reject
          })
        )
      } else {
        vi.mocked(client.getRemoteContentSource).mockReturnValue(
          new Promise((_, reject) => {
            rejectRequest = reject
          })
        )
      }
      const sessionRef = {
        current: { userId: 'user_1', displayName: 'Ada', roles: ['media_sync_user'] }
      }
      const generationRef = { current: 0 }
      const auth = {
        getSession: () => sessionRef.current,
        getAuthGeneration: () => generationRef.current,
        endSession: vi.fn(async () => undefined)
      }
      const provider = new HhcLineReadonlyProvider({
        api: client,
        getSession: auth.getSession,
        getAuthGeneration: auth.getAuthGeneration,
        onAccessError: (scope, error, requestAuth) =>
          handleHhcLineAccessError(auth, { kind: 'root', ...scope }, error, requestAuth)
      })
      await provider.initialScan('hhc-line:user_1', collection.id)
      const pending =
        operation === 'metadata'
          ? provider.getMetadata('hhc-line:user_1', item.id)
          : provider.getRemoteContentSource('hhc-line:user_1', item.id)
      await Promise.resolve()

      generationRef.current = 1
      sessionRef.current =
        transition === 'account switch'
          ? { userId: 'user_2', displayName: 'Grace', roles: ['media_sync_user'] }
          : { userId: 'user_1', displayName: 'Ada', roles: ['media_sync_user', 'reader'] }
      rejectRequest(Object.assign(new Error('expired'), { classification: 'auth-required' }))

      await expect(pending).rejects.toMatchObject({ classification: 'auth-required' })
      expect(auth.endSession).not.toHaveBeenCalled()
    }
  )

  it.each(['metadata', 'ticket'] as const)(
    'ends the current session exactly once for a current %s 401',
    async (operation) => {
      const client = api()
      const error = Object.assign(new Error('expired'), { classification: 'auth-required' })
      if (operation === 'metadata') vi.mocked(client.getCollectionItem).mockRejectedValue(error)
      if (operation === 'ticket') vi.mocked(client.getRemoteContentSource).mockRejectedValue(error)
      const auth = {
        getSession: () => ({
          userId: 'user_1',
          displayName: 'Ada',
          roles: ['media_sync_user']
        }),
        getAuthGeneration: () => 0,
        endSession: vi.fn(async () => undefined)
      }
      const provider = new HhcLineReadonlyProvider({
        api: client,
        getSession: auth.getSession,
        getAuthGeneration: auth.getAuthGeneration,
        onAccessError: (scope, accessError, requestAuth) =>
          handleHhcLineAccessError(auth, { kind: 'root', ...scope }, accessError, requestAuth)
      })
      await provider.initialScan('hhc-line:user_1', collection.id)

      const pending =
        operation === 'metadata'
          ? provider.getMetadata('hhc-line:user_1', item.id)
          : provider.getRemoteContentSource('hhc-line:user_1', item.id)
      await expect(pending).rejects.toBe(error)
      expect(auth.endSession).toHaveBeenCalledOnce()
    }
  )

  it('keeps the provider read-only and maps access failures distinctly', () => {
    const provider = new HhcLineReadonlyProvider({ api: api(), getSession: vi.fn() })
    expect(provider.classifyError({ classification: 'access-revoked' })).toBe('access-revoked')
    expect(provider.classifyError({ classification: 'auth-required' })).toBe('auth-required')
    expect(provider.classifyError({ classification: 'retryable' })).toBe('retryable')
    expect(provider).not.toHaveProperty('upload')
    expect(provider).not.toHaveProperty('delete')
  })

  it('removes the returned native file when cancellation wins before persistence', async () => {
    const client = api()
    vi.mocked(client.downloadContent).mockResolvedValue({
      fileId: 'blob_1',
      size: 42,
      mimeType: 'image/jpeg'
    })
    const provider = new HhcLineReadonlyProvider({ api: client, getSession: vi.fn() })

    await expect(
      provider.downloadContent(
        {
          providerConnectionId: 'hhc-line:user_1',
          rootRemoteFolderId: collection.id,
          remoteItemId: item.id,
          targetBlobId: 'blob_1',
          offlinePolicy: 'on-demand'
        },
        new AbortController().signal,
        () => false
      )
    ).rejects.toThrow('Sync download cancelled')

    expect(window.api.nativeFs.delete).toHaveBeenCalledWith('blob_1')
  })

  it('removes native blob and entry state when cancellation wins during persistence', async () => {
    const client = api()
    vi.mocked(client.downloadContent).mockResolvedValue({
      fileId: 'blob_1',
      size: 42,
      mimeType: 'image/jpeg'
    })
    const provider = new HhcLineReadonlyProvider({ api: client, getSession: vi.fn() })
    let checks = 0

    await expect(
      provider.downloadContent(
        {
          providerConnectionId: 'hhc-line:user_1',
          rootRemoteFolderId: collection.id,
          remoteItemId: item.id,
          targetBlobId: 'blob_1',
          offlinePolicy: 'on-demand'
        },
        new AbortController().signal,
        () => ++checks < 3
      )
    ).rejects.toThrow('Sync download cancelled')

    expect(window.api.nativeFs.delete).toHaveBeenCalledWith('blob_1')
    await expect((await openFileExplorerDB()).get('file-blobs', 'blob_1')).resolves.toBeUndefined()
    await expect(getSyncEntryByRemoteItem('hhc-line:user_1', item.id)).resolves.toBeUndefined()
  })

  it('publishes recovery change only after cancelled HHC LINE cleanup settles', async () => {
    const client = api()
    vi.mocked(client.downloadContent).mockResolvedValue({
      fileId: 'blob_1',
      size: 42,
      mimeType: 'image/jpeg'
    })
    const cleanupStarted = deferred<void>()
    const releaseCleanup = deferred<void>()
    vi.mocked(window.api.nativeFs.delete).mockImplementationOnce(async () => {
      cleanupStarted.resolve()
      await releaseCleanup.promise
    })
    const releaseCancellation = deferred<boolean>()
    let checks = 0
    const canCommit = vi.fn(() => {
      checks += 1
      return checks === 3 ? releaseCancellation.promise : true
    })
    const recoveryScan = vi.fn()
    window.addEventListener('hhc:recovery-source-changed', recoveryScan)
    const provider = new HhcLineReadonlyProvider({ api: client, getSession: vi.fn() })
    const saving = provider.downloadContent(
      {
        providerConnectionId: 'hhc-line:user_1',
        rootRemoteFolderId: collection.id,
        remoteItemId: item.id,
        targetBlobId: 'blob_1',
        offlinePolicy: 'on-demand'
      },
      new AbortController().signal,
      canCommit
    )

    await vi.waitFor(() => expect(canCommit).toHaveBeenCalledTimes(3))
    recoveryScan.mockClear()
    releaseCancellation.resolve(false)
    await cleanupStarted.promise
    await vi.waitFor(async () => {
      expect(await getSyncEntryByRemoteItem('hhc-line:user_1', item.id)).toBeUndefined()
    })
    const scansBeforeCleanup = recoveryScan.mock.calls.length
    releaseCleanup.resolve()
    const failure = await saving.catch((error: unknown) => error)
    window.removeEventListener('hhc:recovery-source-changed', recoveryScan)

    expect(scansBeforeCleanup).toBe(0)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('Sync download cancelled')
    expect(recoveryScan).toHaveBeenCalledOnce()
  })
})

describe('source control fencing', () => {
  const control = {
    version: 1 as const,
    collectionId: collection.id,
    state: 'active' as const,
    policyRevision: 1,
    aclRevision: 1,
    bindingGeneration: 1
  }
  it('preserves a paused collection without reading changes', async () => {
    const client = api()
    vi.mocked(client.getCollectionControl).mockResolvedValue({ ...control, state: 'paused' })
    const provider = new HhcLineReadonlyProvider({ api: client, getSession: vi.fn() })
    await expect(provider.initialScan('hhc-line:user_1', collection.id)).rejects.toMatchObject({
      outcome: 'collection-paused',
      classification: 'retryable'
    })
    expect(client.getCollectionChanges).not.toHaveBeenCalled()
  })
  it('discards a page when its control revision changes during the read', async () => {
    const client = api()
    vi.mocked(client.getCollectionControl)
      .mockResolvedValueOnce(control)
      .mockResolvedValueOnce({ ...control, policyRevision: 2 })
    vi.mocked(client.getCollectionChanges).mockResolvedValue({
      collection: { ...collection, sourcePolicyVersion: 1, aclRevision: 1, bindingGeneration: 1 },
      items: [{ ...item, sourceExpiresAt: '2027-01-01T00:00:00Z' }],
      tombstones: [],
      cursor: 'revision_9',
      hasMore: false,
      reset: false
    })
    const provider = new HhcLineReadonlyProvider({ api: client, getSession: vi.fn() })
    await expect(provider.initialScan('hhc-line:user_1', collection.id)).rejects.toMatchObject({
      classification: 'retryable'
    })
  })
})
