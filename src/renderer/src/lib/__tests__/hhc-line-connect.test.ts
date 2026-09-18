import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import type { HhcAssetApi } from '../hhc-asset-api'
import type { HhcSession } from '@shared/hhc-auth'
import type {
  HhcAssetCollection,
  HhcAssetCollectionChangePage,
  HhcAssetCollectionItem
} from '@shared/hhc-assets'
import type { FolderRecord, SyncOfflinePolicy } from '@shared/types/folder'
import type { HhcLineCloudAuth } from '../cloud-provider'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import {
  getSyncEntryByRemoteItem,
  putProviderConnection,
  putSyncEntry,
  resetSyncDBForTests
} from '../sync-db'
import * as syncDB from '../sync-db'
import * as syncRefresh from '../sync-refresh'
import * as syncDownloadQueue from '../sync-download-queue'
import * as localSyncImport from '../local-sync-import'
import { isHhcLineRootAuthorized } from '../hhc-line-access'
import {
  importHhcLineCollection,
  ensureHhcLineDesktopItemAvailableForPresentation,
  listHhcLineCollections,
  prepareHhcLinePresentationSource,
  refreshHhcLineFolder
} from '../hhc-line-connect'
import { resetSyncDownloadQueueForTests } from '../sync-download-queue'

const mocks = vi.hoisted(() => ({
  electron: false,
  offlinePolicy: 'online-only' as SyncOfflinePolicy,
  api: null as HhcAssetApi | null,
  state: {
    folders: {} as Record<string, FolderRecord>,
    items: {},
    _foldersArray: [] as FolderRecord[],
    _itemsArray: [],
    _childFoldersByParent: {} as Record<string, FolderRecord[]>,
    _itemsByParent: {},
    loadedParents: new Set<string>(['file-root']),
    initialize: vi.fn(async () => undefined),
    getChildFolders(parentId: string) {
      return this._childFoldersByParent[parentId] ?? []
    }
  },
  handleAccessError: vi.fn()
}))

vi.mock('../env', () => ({
  isElectron: () => mocks.electron,
  isWeb: () => !mocks.electron
}))

vi.mock('../hhc-asset-api', () => ({
  createHhcAssetApi: vi.fn(async () => mocks.api)
}))

vi.mock('../hhc-line-access', () => ({
  handleHhcLineAccessError: mocks.handleAccessError,
  isHhcLineRootAuthorized: vi.fn(async () => true)
}))

vi.mock('@renderer/stores/file-explorer', () => ({
  FILE_EXPLORER_ROOT_ID: 'file-root',
  removeCleanedEntriesFromStore: vi.fn(),
  useFileExplorerStore: {
    getState: () => mocks.state,
    setState: (update: (state: typeof mocks.state) => Partial<typeof mocks.state>) => {
      Object.assign(mocks.state, update(mocks.state))
    }
  }
}))

vi.mock('@renderer/stores/settings', () => ({
  useSettingsStore: {
    getState: () => ({ defaultSyncOfflinePolicy: mocks.offlinePolicy })
  }
}))

const collection = (id: string, name: string): HhcAssetCollection => ({
  id,
  namespace: 'line.group.media-sync',
  name,
  revision: 1,
  createdAt: '2026-08-17T00:00:00Z',
  updatedAt: '2026-08-17T00:00:00Z'
})

function auth(
  sessionRef: { current: HhcSession | null },
  generationRef: { current: number } = { current: 0 }
): HhcLineCloudAuth {
  return {
    getSession: () => sessionRef.current,
    getAuthGeneration: () => generationRef.current,
    getAccessToken: vi.fn(async () => 'access-token'),
    refreshAfterUnauthorized: vi.fn(async () => 'refresh-token'),
    endSession: vi.fn(async () => undefined)
  }
}

function resetChanges(items: HhcAssetCollectionItem[] = []): HhcAssetApi['getCollectionChanges'] {
  return vi.fn(async (collectionId: string, cursor?: string) => ({
    collection: collection(collectionId, collectionId),
    items: cursor ? [] : items,
    tombstones: [],
    cursor: cursor ? `${collectionId}-revision-1` : `${collectionId}-reset-barrier`,
    hasMore: !cursor,
    reset: !cursor
  }))
}

function api(overrides: Partial<HhcAssetApi> = {}): HhcAssetApi {
  return {
    listCollections: vi.fn(async () => ({ collections: [], hasMore: false })),
    getCollectionChanges: resetChanges(),
    getCollectionItem: vi.fn(),
    issueContentTicket: vi.fn(),
    recordSyncReceipt: vi.fn(async () => undefined),
    getRemoteContentSource: vi.fn(),
    downloadContent: vi.fn(),
    ...overrides
  }
}

beforeEach(async () => {
  await resetFileExplorerDBForTests()
  await resetSyncDBForTests()
  mocks.electron = false
  mocks.offlinePolicy = 'online-only'
  mocks.api = api()
  Object.assign(mocks.state, {
    folders: {},
    items: {},
    _foldersArray: [],
    _itemsArray: [],
    _childFoldersByParent: {},
    _itemsByParent: {},
    loadedParents: new Set(['file-root'])
  })
  mocks.state.initialize.mockClear()
  mocks.handleAccessError.mockReset()
  mocks.handleAccessError.mockResolvedValue(undefined)
  resetSyncDownloadQueueForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('HHC LINE collection connection', () => {
  it('routes a list 403 through the current account access owner', async () => {
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }
    const currentAuth = auth(sessionRef)
    const error = Object.assign(new Error('forbidden'), {
      classification: 'access-revoked',
      status: 403
    })
    mocks.api = api({
      listCollections: vi.fn(async () => {
        throw error
      })
    })

    await expect(listHhcLineCollections(currentAuth)).rejects.toBe(error)
    expect(mocks.handleAccessError).toHaveBeenCalledWith(
      currentAuth,
      { kind: 'account', accountUserId: 'user-1' },
      error,
      { accountUserId: 'user-1', authGeneration: 0 }
    )
  })

  it.each(['account switch', 'same-user re-login'] as const)(
    'does not end the current session for a delayed list 401 after %s',
    async (transition) => {
      const actualAccess =
        await vi.importActual<typeof import('../hhc-line-access')>('../hhc-line-access')
      mocks.handleAccessError.mockImplementation(actualAccess.handleHhcLineAccessError)
      let rejectList!: (error: unknown) => void
      mocks.api = api({
        listCollections: vi.fn(
          () =>
            new Promise<Awaited<ReturnType<HhcAssetApi['listCollections']>>>((_, reject) => {
              rejectList = reject
            })
        )
      })
      const sessionRef: { current: HhcSession | null } = {
        current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
      }
      const generationRef = { current: 0 }
      const currentAuth = auth(sessionRef, generationRef)
      const pending = listHhcLineCollections(currentAuth)
      await vi.waitFor(() => expect(mocks.api?.listCollections).toHaveBeenCalledOnce())

      generationRef.current += 1
      sessionRef.current =
        transition === 'account switch'
          ? { userId: 'user-2', displayName: 'Grace', roles: ['media_sync_user'] }
          : { ...sessionRef.current!, roles: ['media_sync_user', 'reader'] }
      rejectList(Object.assign(new Error('expired'), { classification: 'auth-required' }))

      await expect(pending).rejects.toMatchObject({ classification: 'auth-required' })
      expect(currentAuth.endSession).not.toHaveBeenCalled()
    }
  )

  it('ends the current session exactly once for a current list 401', async () => {
    const actualAccess =
      await vi.importActual<typeof import('../hhc-line-access')>('../hhc-line-access')
    mocks.handleAccessError.mockImplementation(actualAccess.handleHhcLineAccessError)
    const currentAuth = auth({
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    })
    mocks.api = api({
      listCollections: vi.fn(async () => {
        throw Object.assign(new Error('expired'), { classification: 'auth-required' })
      })
    })

    await expect(listHhcLineCollections(currentAuth)).rejects.toMatchObject({
      classification: 'auth-required'
    })
    expect(currentAuth.endSession).toHaveBeenCalledOnce()
  })

  it('leaves local media inert when there is no HHC session', async () => {
    await expect(
      prepareHhcLinePresentationSource(auth({ current: null }), {
        id: 'local-only',
        parentId: 'root',
        type: 'file',
        sortIndex: 0,
        createdAt: 1,
        expiresAt: null,
        name: 'local.png',
        mimeType: 'image/png',
        size: 1,
        url: 'blob:local-only'
      })
    ).resolves.toBeNull()
  })

  it('classifies a connection account mismatch as auth-required rather than access-revoked', async () => {
    await putProviderConnection({
      id: 'hhc-line:user-1',
      providerType: 'hhc-line',
      displayName: 'HHC LINE',
      accountUserId: 'user-1'
    })
    await putSyncEntry({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'asset-1',
      parentRemoteItemId: 'collection-1',
      kind: 'file',
      name: 'photo.png',
      itemId: 'local-1',
      mimeType: 'image/png',
      status: 'remote-only'
    })

    await expect(
      prepareHhcLinePresentationSource(
        auth({ current: { userId: 'user-2', displayName: 'Grace', roles: [] } }),
        {
          id: 'local-1',
          parentId: 'root',
          type: 'file',
          sortIndex: 0,
          createdAt: 1,
          expiresAt: null,
          name: 'photo.png',
          mimeType: 'image/png',
          size: 1,
          url: 'hhc-line:asset-1'
        }
      )
    ).rejects.toMatchObject({ classification: 'auth-required' })
    expect(mocks.api?.getRemoteContentSource).not.toHaveBeenCalled()
  })

  it('propagates an Asset API 403 as access-revoked for the exact remote item', async () => {
    await putProviderConnection({
      id: 'hhc-line:user-1',
      providerType: 'hhc-line',
      displayName: 'HHC LINE',
      accountUserId: 'user-1'
    })
    await putSyncEntry({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'asset-1',
      parentRemoteItemId: 'collection-1',
      kind: 'file',
      name: 'photo.png',
      itemId: 'local-1',
      mimeType: 'image/png',
      status: 'remote-only'
    })
    mocks.api = api({
      getRemoteContentSource: vi.fn(async () => {
        throw Object.assign(new Error('HHC Asset request failed'), {
          classification: 'access-revoked',
          status: 403
        })
      })
    })

    const currentAuth = auth({
      current: { userId: 'user-1', displayName: 'Ada', roles: [] }
    })
    await expect(
      prepareHhcLinePresentationSource(currentAuth, {
        id: 'local-1',
        parentId: 'root',
        type: 'file',
        sortIndex: 0,
        createdAt: 1,
        expiresAt: null,
        name: 'photo.png',
        mimeType: 'image/png',
        size: 1,
        url: 'hhc-line:asset-1'
      })
    ).rejects.toMatchObject({
      classification: 'access-revoked',
      status: 403,
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'asset-1'
    })
    expect(mocks.handleAccessError).toHaveBeenCalledWith(
      currentAuth,
      {
        kind: 'root',
        providerConnectionId: 'hhc-line:user-1',
        rootRemoteFolderId: 'collection-1',
        remoteItemId: 'asset-1'
      },
      expect.objectContaining({ classification: 'access-revoked', status: 403 }),
      { accountUserId: 'user-1', authGeneration: 0 }
    )
  })

  it('prepares an ephemeral source from the exact imported collection without persisting it', async () => {
    await putProviderConnection({
      id: 'hhc-line:user-1',
      providerType: 'hhc-line',
      displayName: 'HHC LINE',
      accountUserId: 'user-1'
    })
    await putSyncEntry({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'asset-1',
      parentRemoteItemId: 'collection-1',
      kind: 'file',
      name: 'photo.png',
      itemId: 'local-1',
      mimeType: 'image/png',
      status: 'remote-only'
    })
    mocks.api = api({
      getRemoteContentSource: vi.fn(async () => ({
        kind: 'ticket' as const,
        url: 'https://www.alive.org.tw/api/assets/content?ticket=secret',
        expiresAt: 123,
        etag: 'etag-1'
      }))
    })

    await expect(
      prepareHhcLinePresentationSource(
        auth({
          current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
        }),
        {
          id: 'local-1',
          parentId: 'root',
          type: 'file',
          sortIndex: 0,
          createdAt: 1,
          expiresAt: null,
          name: 'photo.png',
          mimeType: 'image/png',
          size: 1,
          url: 'hhc-line:asset-1'
        }
      )
    ).resolves.toMatchObject({
      providerConnectionId: 'hhc-line:user-1',
      rootRemoteFolderId: 'collection-1',
      source: { kind: 'ticket', url: expect.stringContaining('ticket=secret') }
    })
    expect(mocks.api.getRemoteContentSource).toHaveBeenCalledWith('collection-1', 'asset-1')
    expect((await getSyncEntryByRemoteItem('hhc-line:user-1', 'asset-1'))?.status).toBe(
      'remote-only'
    )
  })

  it.each(['logout', 'account switch'] as const)(
    'releases a native lease returned after %s before rejecting the stale source',
    async (transition) => {
      mocks.electron = true
      let resolveSource!: (source: {
        kind: 'native-lease'
        url: string
        leaseId: string
        etag: string
      }) => void
      const releaseContentLease = vi.fn(async () => undefined)
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { hhcAssets: { releaseContentLease } }
      })
      await putProviderConnection({
        id: 'hhc-line:user-1',
        providerType: 'hhc-line',
        displayName: 'HHC LINE',
        accountUserId: 'user-1'
      })
      await putSyncEntry({
        providerConnectionId: 'hhc-line:user-1',
        remoteItemId: 'asset-1',
        parentRemoteItemId: 'collection-1',
        kind: 'file',
        name: 'photo.png',
        itemId: 'local-1',
        mimeType: 'image/png',
        status: 'remote-only'
      })
      mocks.api = api({
        getRemoteContentSource: vi.fn(
          () =>
            new Promise<Awaited<ReturnType<HhcAssetApi['getRemoteContentSource']>>>((resolve) => {
              resolveSource = resolve
            })
        )
      })
      const sessionRef: { current: HhcSession | null } = {
        current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
      }
      const pending = prepareHhcLinePresentationSource(auth(sessionRef), {
        id: 'local-1',
        parentId: 'root',
        type: 'file',
        sortIndex: 0,
        createdAt: 1,
        expiresAt: null,
        name: 'photo.png',
        mimeType: 'image/png',
        size: 1,
        url: 'hhc-line:asset-1'
      })
      await vi.waitFor(() => expect(mocks.api?.getRemoteContentSource).toHaveBeenCalledOnce())

      sessionRef.current =
        transition === 'logout'
          ? null
          : { userId: 'user-2', displayName: 'Grace', roles: ['media_sync_user'] }
      resolveSource({
        kind: 'native-lease',
        url: 'hhc-media://lease/123e4567-e89b-12d3-a456-426614174000?type=image%2Fpng',
        leaseId: '123e4567-e89b-12d3-a456-426614174000',
        etag: 'etag-1'
      })

      await expect(pending).rejects.toMatchObject({ classification: 'auth-required' })
      expect(releaseContentLease).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174000')
      expect(releaseContentLease).toHaveBeenCalledOnce()
    }
  )

  it('downloads desktop-engine content into persistent native storage before presentation', async () => {
    mocks.electron = true
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { nativeFs: { delete: vi.fn(async () => undefined) } }
    })
    await putProviderConnection({
      id: 'hhc-line:user-1',
      providerType: 'hhc-line',
      displayName: 'HHC LINE',
      accountUserId: 'user-1'
    })
    await putSyncEntry({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'asset-1',
      parentRemoteItemId: 'collection-1',
      kind: 'file',
      name: 'movie.mkv',
      itemId: 'local-1',
      mimeType: 'video/x-matroska',
      status: 'remote-only'
    })
    mocks.api = api({
      getCollectionItem: vi.fn(async () => ({
        id: 'asset-1',
        collectionId: 'collection-1',
        remoteItemId: 'source-1',
        displayName: 'movie.mkv',
        sourceRevision: 'hash-1',
        createdRevision: 1,
        mimeType: 'video/x-matroska',
        sizeBytes: 10,
        etag: 'etag-1',
        createdAt: '2026-08-17T00:00:00Z'
      })),
      downloadContent: vi.fn(async () => ({
        fileId: 'local-1',
        size: 10,
        mimeType: 'video/x-matroska'
      }))
    })
    const item = {
      id: 'local-1',
      parentId: 'root',
      type: 'file' as const,
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      name: 'movie.mkv',
      mimeType: 'video/x-matroska',
      size: 10,
      url: 'blob:local-1'
    }

    await expect(
      ensureHhcLineDesktopItemAvailableForPresentation(
        auth({
          current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
        }),
        item
      )
    ).resolves.toBe(true)

    expect(mocks.api.downloadContent).toHaveBeenCalledWith(
      {
        collectionId: 'collection-1',
        itemId: 'asset-1',
        rootRemoteFolderId: 'collection-1',
        targetFileId: 'local-1'
      },
      expect.any(AbortSignal)
    )
    expect((await getSyncEntryByRemoteItem('hhc-line:user-1', 'asset-1'))?.status).toBe(
      'available-offline'
    )
  })

  it('preserves status 403 when a queued desktop presentation download is access-revoked', async () => {
    mocks.electron = true
    await putProviderConnection({
      id: 'hhc-line:user-1',
      providerType: 'hhc-line',
      displayName: 'HHC LINE',
      accountUserId: 'user-1'
    })
    await putSyncEntry({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'asset-1',
      parentRemoteItemId: 'collection-1',
      kind: 'file',
      name: 'movie.mkv',
      itemId: 'local-1',
      mimeType: 'video/x-matroska',
      status: 'remote-only'
    })
    mocks.api = api({
      getCollectionItem: vi.fn(async () => ({
        id: 'asset-1',
        collectionId: 'collection-1',
        remoteItemId: 'source-1',
        displayName: 'movie.mkv',
        sourceRevision: 'hash-1',
        createdRevision: 1,
        mimeType: 'video/x-matroska',
        sizeBytes: 10,
        etag: 'etag-1',
        createdAt: '2026-08-17T00:00:00Z'
      })),
      downloadContent: vi.fn(async () => {
        throw Object.assign(new Error('forbidden'), {
          classification: 'access-revoked',
          status: 403
        })
      })
    })

    await expect(
      ensureHhcLineDesktopItemAvailableForPresentation(
        auth({
          current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
        }),
        {
          id: 'local-1',
          parentId: 'root',
          type: 'file',
          sortIndex: 0,
          createdAt: 1,
          expiresAt: null,
          name: 'movie.mkv',
          mimeType: 'video/x-matroska',
          size: 10,
          url: 'blob:local-1'
        }
      )
    ).rejects.toMatchObject({ classification: 'access-revoked', status: 403 })
    expect(mocks.handleAccessError).toHaveBeenCalledWith(
      expect.anything(),
      {
        kind: 'root',
        providerConnectionId: 'hhc-line:user-1',
        rootRemoteFolderId: 'collection-1',
        remoteItemId: 'asset-1'
      },
      expect.objectContaining({ classification: 'access-revoked', status: 403 }),
      { accountUserId: 'user-1', authGeneration: 0 }
    )
  })
  it('collects every authorized page and excludes only roots imported by the current account', async () => {
    const currentRoot: FolderRecord = {
      id: 'root-current',
      name: 'Already imported',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerType: 'hhc-line',
        providerConnectionId: 'hhc-line:user-1',
        remoteFolderId: 'collection-1',
        offlinePolicy: 'online-only',
        status: 'active'
      }
    }
    const otherAccountRoot: FolderRecord = {
      ...currentRoot,
      id: 'root-other',
      name: 'Other account root',
      sortIndex: 1,
      syncLink: {
        ...currentRoot.syncLink!,
        providerConnectionId: 'hhc-line:user-2',
        remoteFolderId: 'collection-2'
      }
    }
    Object.assign(mocks.state, {
      folders: { [currentRoot.id]: currentRoot, [otherAccountRoot.id]: otherAccountRoot },
      _foldersArray: [currentRoot, otherAccountRoot],
      _childFoldersByParent: { 'file-root': [currentRoot, otherAccountRoot] }
    })
    mocks.api = api({
      listCollections: vi
        .fn()
        .mockResolvedValueOnce({
          collections: [collection('collection-1', 'Imported')],
          cursor: 'page-2',
          hasMore: true
        })
        .mockResolvedValueOnce({
          collections: [collection('collection-2', 'Available')],
          hasMore: false
        })
    })
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }

    await expect(listHhcLineCollections(auth(sessionRef))).resolves.toEqual([
      {
        remoteItemId: 'collection-2',
        name: 'Available',
        parentRemoteItemId: null
      }
    ])
    expect(mocks.api.listCollections).toHaveBeenNthCalledWith(2, 'page-2')
  })

  it('deduplicates concurrent imports and persists an active browser online-only root', async () => {
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }
    const target = { remoteItemId: 'collection-1', name: 'Sunday', parentRemoteItemId: null }

    const [first, second] = await Promise.all([
      importHhcLineCollection(auth(sessionRef), target),
      importHhcLineCollection(auth(sessionRef), target)
    ])

    expect(first).toEqual(second)
    expect(mocks.api!.getCollectionChanges).toHaveBeenCalledTimes(2)
    const roots = await (await openFileExplorerDB()).getAll('folder-records')
    expect(roots).toEqual([
      expect.objectContaining({
        name: 'Sunday',
        syncLink: {
          providerConnectionId: 'hhc-line:user-1',
          providerType: 'hhc-line',
          remoteFolderId: 'collection-1',
          offlinePolicy: 'online-only',
          status: 'active'
        }
      })
    ])
  })

  it('uses the selected always-offline policy in Electron imports', async () => {
    mocks.electron = true
    mocks.offlinePolicy = 'always-offline'
    mocks.api = api({
      getCollectionChanges: resetChanges([
        {
          id: 'item-1',
          collectionId: 'collection-1',
          remoteItemId: 'source-1',
          displayName: 'photo.jpg',
          sourceRevision: 'sha256:one',
          createdRevision: 1,
          mimeType: 'image/jpeg',
          sizeBytes: 42,
          etag: 'etag-1',
          createdAt: '2026-08-17T00:00:00Z'
        }
      ])
    })
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }

    await importHhcLineCollection(auth(sessionRef), {
      remoteItemId: 'collection-1',
      name: 'Sunday',
      parentRemoteItemId: null
    })

    const roots = await (await openFileExplorerDB()).getAll('folder-records')
    expect(roots[0].syncLink?.offlinePolicy).toBe('always-offline')
    const fileEntry = await getSyncEntryByRemoteItem('hhc-line:user-1', 'item-1')
    expect(fileEntry?.status).toBe('queued')
  })

  it('queues always-offline HHC imports in the background and refreshes downloaded media', async () => {
    mocks.electron = true
    mocks.offlinePolicy = 'always-offline'
    mocks.api = api({
      getCollectionChanges: resetChanges([
        {
          id: 'jpg-1',
          collectionId: 'collection-1',
          remoteItemId: 'source-jpg',
          displayName: 'photo.jpg',
          sourceRevision: 'sha256:jpg',
          createdRevision: 1,
          mimeType: 'image/jpeg',
          sizeBytes: 42,
          etag: 'etag-jpg',
          createdAt: '2026-08-17T00:00:00Z'
        },
        {
          id: 'pptx-1',
          collectionId: 'collection-1',
          remoteItemId: 'source-pptx',
          displayName: 'slides.pptx',
          sourceRevision: 'sha256:pptx',
          createdRevision: 1,
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          sizeBytes: 84,
          etag: 'etag-pptx',
          createdAt: '2026-08-17T00:00:00Z'
        }
      ])
    })
    const enqueue = vi.spyOn(syncDownloadQueue, 'enqueueSyncDownload').mockResolvedValue(null)
    const refreshAssets = vi
      .spyOn(localSyncImport, 'refreshImportedMediaAssets')
      .mockResolvedValue(undefined)

    await importHhcLineCollection(
      auth({
        current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
      }),
      { remoteItemId: 'collection-1', name: 'Sunday', parentRemoteItemId: null }
    )

    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ offlinePolicy: 'always-offline' }),
        priority: 'background',
        canCommit: expect.any(Function),
        onFailed: expect.any(Function),
        onDownloaded: expect.any(Function)
      })
    )
    const assetCommitGuards: Array<() => boolean | Promise<boolean>> = []
    for (const [queued] of enqueue.mock.calls) {
      const canCommit = vi.fn(async () => true)
      assetCommitGuards.push(canCommit)
      await queued.onDownloaded?.(
        {
          blobId: queued.entry.itemId,
          size: queued.entry.size ?? 0,
          mimeType: queued.entry.mimeType!
        },
        canCommit
      )
    }
    expect(refreshAssets.mock.calls.map(([items]) => items.map((item) => item.name))).toEqual([
      ['photo.jpg'],
      ['slides.pptx']
    ])
    expect(refreshAssets.mock.calls.map(([, canCommit]) => canCommit)).toEqual(assetCommitGuards)
  })

  it('guards HHC background commits by account generation and active root access', async () => {
    mocks.offlinePolicy = 'always-offline'
    mocks.api = api({
      getCollectionChanges: resetChanges([
        {
          id: 'item-1',
          collectionId: 'collection-1',
          remoteItemId: 'source-1',
          displayName: 'photo.jpg',
          sourceRevision: 'sha256:one',
          createdRevision: 1,
          mimeType: 'image/jpeg',
          sizeBytes: 42,
          etag: 'etag-1',
          createdAt: '2026-08-17T00:00:00Z'
        }
      ])
    })
    const enqueue = vi.spyOn(syncDownloadQueue, 'enqueueSyncDownload').mockResolvedValue(null)
    const sessionRef: { current: HhcSession | null } = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }
    const generationRef = { current: 7 }
    const currentAuth = auth(sessionRef, generationRef)

    await importHhcLineCollection(currentAuth, {
      remoteItemId: 'collection-1',
      name: 'Sunday',
      parentRemoteItemId: null
    })

    const queued = enqueue.mock.calls[0]![0]
    expect(await queued.canCommit?.()).toBe(true)

    generationRef.current = 8
    expect(await queued.canCommit?.()).toBe(false)

    generationRef.current = 7
    sessionRef.current = { userId: 'user-2', displayName: 'Grace', roles: ['media_sync_user'] }
    expect(await queued.canCommit?.()).toBe(false)

    sessionRef.current = { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    vi.mocked(isHhcLineRootAuthorized).mockResolvedValueOnce(false)
    expect(await queued.canCommit?.()).toBe(false)

    for (const status of [403, 404]) {
      await queued.onFailed?.(
        Object.assign(new Error('access revoked'), { classification: 'access-revoked', status })
      )
    }
    expect(mocks.handleAccessError).toHaveBeenNthCalledWith(
      1,
      currentAuth,
      {
        kind: 'root',
        providerConnectionId: 'hhc-line:user-1',
        rootRemoteFolderId: 'collection-1',
        remoteItemId: 'item-1'
      },
      expect.objectContaining({ classification: 'access-revoked', status: 403 }),
      { accountUserId: 'user-1', authGeneration: 7 }
    )
    expect(mocks.handleAccessError).toHaveBeenNthCalledWith(
      2,
      currentAuth,
      expect.objectContaining({ kind: 'root', remoteItemId: 'item-1' }),
      expect.objectContaining({ classification: 'access-revoked', status: 404 }),
      { accountUserId: 'user-1', authGeneration: 7 }
    )
  })

  it('queues only new and changed HHC files during always-offline refresh', async () => {
    const original = [
      {
        id: 'updated-1',
        collectionId: 'collection-1',
        remoteItemId: 'source-updated',
        displayName: 'updated.jpg',
        sourceRevision: 'sha256:old',
        createdRevision: 1,
        mimeType: 'image/jpeg',
        sizeBytes: 42,
        etag: 'etag-old',
        createdAt: '2026-08-17T00:00:00Z'
      },
      {
        id: 'unchanged-1',
        collectionId: 'collection-1',
        remoteItemId: 'source-unchanged',
        displayName: 'unchanged.jpg',
        sourceRevision: 'sha256:same',
        createdRevision: 1,
        mimeType: 'image/jpeg',
        sizeBytes: 42,
        etag: 'etag-same',
        createdAt: '2026-08-17T00:00:00Z'
      }
    ]
    const getCollectionChanges = vi
      .fn()
      .mockResolvedValueOnce({
        collection: collection('collection-1', 'Sunday'),
        items: original,
        tombstones: [],
        cursor: 'reset-barrier',
        hasMore: true,
        reset: true
      })
      .mockResolvedValueOnce({
        collection: collection('collection-1', 'Sunday'),
        items: [],
        tombstones: [],
        cursor: 'revision-1',
        hasMore: false,
        reset: false
      })
      .mockResolvedValueOnce({
        collection: collection('collection-1', 'Sunday'),
        items: [
          { ...original[0], sourceRevision: 'sha256:new', etag: 'etag-new', updatedRevision: 2 },
          original[1],
          {
            id: 'new-1',
            collectionId: 'collection-1',
            remoteItemId: 'source-new',
            displayName: 'new.jpg',
            sourceRevision: 'sha256:new-file',
            createdRevision: 2,
            mimeType: 'image/jpeg',
            sizeBytes: 42,
            etag: 'etag-new-file',
            createdAt: '2026-08-17T00:00:00Z'
          }
        ],
        tombstones: [],
        cursor: 'revision-2',
        hasMore: false,
        reset: false
      })
    mocks.api = api({ getCollectionChanges })
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }

    mocks.offlinePolicy = 'on-demand'
    await importHhcLineCollection(auth(sessionRef), {
      remoteItemId: 'collection-1',
      name: 'Sunday',
      parentRemoteItemId: null
    })
    const db = await openFileExplorerDB()
    const [root] = await db.getAll('folder-records')
    for (const remoteItemId of ['updated-1', 'unchanged-1']) {
      const entry = await getSyncEntryByRemoteItem('hhc-line:user-1', remoteItemId)
      await putSyncEntry({ ...entry!, blobId: entry!.itemId, status: 'available-offline' })
      await db.put('file-blobs', { id: entry!.itemId!, blob: new Blob([remoteItemId]) })
    }
    const enqueue = vi.spyOn(syncDownloadQueue, 'enqueueSyncDownload').mockResolvedValue(null)

    mocks.offlinePolicy = 'always-offline'
    await refreshHhcLineFolder(auth(sessionRef), root.id)

    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(enqueue.mock.calls.map(([queued]) => queued.request.remoteItemId).sort()).toEqual([
      'new-1',
      'updated-1'
    ])
    expect(enqueue.mock.calls.map(([queued]) => queued.request.remoteItemId)).not.toContain(
      'unchanged-1'
    )
  })

  it('refreshes a persisted HHC root with the selected offline policy', async () => {
    mocks.electron = true
    const remoteItem = {
      id: 'item-1',
      collectionId: 'collection-1',
      remoteItemId: 'source-1',
      displayName: 'photo.jpg',
      sourceRevision: 'sha256:one',
      createdRevision: 1,
      mimeType: 'image/jpeg',
      sizeBytes: 42,
      etag: 'etag-1',
      createdAt: '2026-08-17T00:00:00Z'
    }
    mocks.api = api({
      getCollectionChanges: vi
        .fn()
        .mockResolvedValueOnce({
          collection: collection('collection-1', 'Sunday'),
          items: [remoteItem],
          tombstones: [],
          cursor: 'reset-barrier',
          hasMore: true,
          reset: true
        })
        .mockResolvedValueOnce({
          collection: collection('collection-1', 'Sunday'),
          items: [],
          tombstones: [],
          cursor: 'revision-1',
          hasMore: false,
          reset: false
        })
        .mockResolvedValueOnce({
          collection: collection('collection-1', 'Sunday'),
          items: [{ ...remoteItem, updatedRevision: 2 }],
          tombstones: [],
          cursor: 'revision-2',
          hasMore: false,
          reset: false
        })
        .mockResolvedValueOnce({
          collection: collection('collection-1', 'Sunday'),
          items: [remoteItem],
          tombstones: [],
          cursor: 'reset-barrier-2',
          hasMore: true,
          reset: true
        })
        .mockResolvedValueOnce({
          collection: collection('collection-1', 'Sunday'),
          items: [],
          tombstones: [],
          cursor: 'revision-3',
          hasMore: false,
          reset: false
        })
    })
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }

    mocks.offlinePolicy = 'on-demand'
    await importHhcLineCollection(auth(sessionRef), {
      remoteItemId: 'collection-1',
      name: 'Sunday',
      parentRemoteItemId: null
    })
    const [root] = await (await openFileExplorerDB()).getAll('folder-records')

    mocks.offlinePolicy = 'always-offline'
    await refreshHhcLineFolder(auth(sessionRef), root.id)

    const [refreshedRoot] = await (await openFileExplorerDB()).getAll('folder-records')
    const fileEntry = await getSyncEntryByRemoteItem('hhc-line:user-1', 'item-1')
    expect(refreshedRoot).toMatchObject({
      id: root.id,
      syncLink: { offlinePolicy: 'always-offline' }
    })
    expect(mocks.state.folders[root.id]).toMatchObject({
      id: root.id,
      syncLink: { offlinePolicy: 'always-offline' }
    })
    expect(fileEntry?.status).toBe('queued')
  })

  it('full-scans an empty delta to reconcile existing remote-only files as always-offline', async () => {
    mocks.electron = true
    const remoteItem = {
      id: 'policy-item',
      collectionId: 'policy-collection',
      remoteItemId: 'policy-source',
      displayName: 'photo.jpg',
      sourceRevision: 'sha256:one',
      createdRevision: 1,
      mimeType: 'image/jpeg',
      sizeBytes: 42,
      etag: 'etag-1',
      createdAt: '2026-08-17T00:00:00Z'
    }
    mocks.api = api({ getCollectionChanges: resetChanges([remoteItem]) })
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }
    const enqueue = vi.spyOn(syncDownloadQueue, 'enqueueSyncDownload').mockResolvedValue(null)

    mocks.offlinePolicy = 'on-demand'
    await importHhcLineCollection(auth(sessionRef), {
      remoteItemId: 'policy-collection',
      name: 'Sunday',
      parentRemoteItemId: null
    })
    const [root] = await (await openFileExplorerDB()).getAll('folder-records')
    await expect(getSyncEntryByRemoteItem('hhc-line:user-1', 'policy-item')).resolves.toMatchObject(
      { status: 'remote-only' }
    )

    mocks.offlinePolicy = 'always-offline'
    const summary = await refreshHhcLineFolder(auth(sessionRef), root.id)

    expect(summary.fullScanFallback).toBe(true)
    expect(enqueue.mock.calls.map(([job]) => job.request.remoteItemId)).toContain('policy-item')
  })

  it('keeps multiple imported collections independent', async () => {
    mocks.api = api({
      getCollectionChanges: resetChanges()
    })
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }

    await importHhcLineCollection(auth(sessionRef), {
      remoteItemId: 'collection-1',
      name: 'Sunday',
      parentRemoteItemId: null
    })
    await importHhcLineCollection(auth(sessionRef), {
      remoteItemId: 'collection-2',
      name: 'Youth',
      parentRemoteItemId: null
    })

    const roots = await (await openFileExplorerDB()).getAll('folder-records')
    expect(roots.map((root) => root.syncLink?.remoteFolderId).sort()).toEqual([
      'collection-1',
      'collection-2'
    ])
  })

  it('serializes distinct imports when resolving root names and positions', async () => {
    mocks.api = api({
      getCollectionChanges: resetChanges()
    })
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }

    await Promise.all([
      importHhcLineCollection(auth(sessionRef), {
        remoteItemId: 'collection-1',
        name: 'Sunday',
        parentRemoteItemId: null
      }),
      importHhcLineCollection(auth(sessionRef), {
        remoteItemId: 'collection-2',
        name: 'Sunday',
        parentRemoteItemId: null
      })
    ])

    const roots = (await (await openFileExplorerDB()).getAll('folder-records')).sort(
      (left, right) => left.sortIndex - right.sortIndex
    )
    expect(roots.map(({ name, sortIndex }) => ({ name, sortIndex }))).toEqual([
      { name: 'Sunday', sortIndex: 0 },
      { name: 'Sunday 2', sortIndex: 1 }
    ])
  })

  it('retries an active-looking root that has no completed cursor', async () => {
    const partialRoot: FolderRecord = {
      id: 'hhc-line:user-1:collection:collection-1',
      name: 'Sunday',
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'hhc-line:user-1',
        providerType: 'hhc-line',
        remoteFolderId: 'collection-1',
        offlinePolicy: 'online-only',
        status: 'active'
      }
    }
    Object.assign(mocks.state, {
      folders: { [partialRoot.id]: partialRoot },
      _foldersArray: [partialRoot],
      _childFoldersByParent: { 'file-root': [partialRoot] }
    })
    await (await openFileExplorerDB()).put('folder-records', partialRoot)
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }

    await importHhcLineCollection(auth(sessionRef), {
      remoteItemId: 'collection-1',
      name: 'Sunday',
      parentRemoteItemId: null
    })

    expect(mocks.api!.getCollectionChanges).toHaveBeenCalledTimes(2)
  })

  it.each(['plan', 'cursor'] as const)(
    'removes a partial import after a %s write failure so retry starts cleanly',
    async (failure) => {
      const remoteItem = {
        id: 'item-1',
        collectionId: 'collection-1',
        remoteItemId: 'source-1',
        displayName: 'photo.jpg',
        sourceRevision: 'sha256:one',
        createdRevision: 1,
        mimeType: 'image/jpeg',
        sizeBytes: 42,
        etag: '"etag-1"',
        createdAt: '2026-08-17T00:00:00Z'
      }
      mocks.api = api({
        getCollectionChanges: resetChanges([remoteItem])
      })
      const sessionRef = {
        current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
      }
      const target = {
        remoteItemId: 'collection-1',
        name: 'Sunday',
        parentRemoteItemId: null
      }
      const failureSpy =
        failure === 'plan'
          ? vi.spyOn(syncRefresh, 'applySyncRefreshPlan').mockRejectedValueOnce(new Error('write'))
          : vi.spyOn(syncDB, 'putSyncCursor').mockRejectedValueOnce(new Error('write'))

      await expect(importHhcLineCollection(auth(sessionRef), target)).rejects.toThrow('write')
      const db = await openFileExplorerDB()
      await expect(db.getAll('folder-records')).resolves.toEqual([])
      await expect(db.getAll('folder-items')).resolves.toEqual([])
      await expect(getSyncEntryByRemoteItem('hhc-line:user-1', 'item-1')).resolves.toBeUndefined()

      failureSpy.mockRestore()
      await importHhcLineCollection(auth(sessionRef), target)

      await expect(db.getAll('folder-records')).resolves.toHaveLength(1)
      await expect(db.getAll('folder-items')).resolves.toHaveLength(1)
    }
  )

  it('rejects a response completed after the account changes', async () => {
    let resolvePage!: (value: Awaited<ReturnType<HhcAssetApi['listCollections']>>) => void
    mocks.api = api({
      listCollections: vi.fn(
        () =>
          new Promise<Awaited<ReturnType<HhcAssetApi['listCollections']>>>((resolve) => {
            resolvePage = resolve
          })
      )
    })
    const sessionRef: { current: HhcSession | null } = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }
    const pending = listHhcLineCollections(auth(sessionRef))
    await Promise.resolve()
    await Promise.resolve()
    sessionRef.current = { userId: 'user-2', displayName: 'Grace', roles: ['media_sync_user'] }
    resolvePage({ collections: [collection('collection-1', 'Sunday')], hasMore: false })

    await expect(pending).rejects.toThrow('HHC account changed')
  })

  it('rolls back the imported root when the account changes during its final commit', async () => {
    const remoteItem = {
      id: 'item-1',
      collectionId: 'collection-1',
      remoteItemId: 'source-1',
      displayName: 'photo.jpg',
      sourceRevision: 'sha256:one',
      createdRevision: 1,
      mimeType: 'image/jpeg',
      sizeBytes: 42,
      etag: '"etag-1"',
      createdAt: '2026-08-17T00:00:00Z'
    }
    mocks.api = api({
      getCollectionChanges: resetChanges([remoteItem])
    })
    const sessionRef: { current: HhcSession | null } = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }
    const db = await openFileExplorerDB()
    const put = db.put.bind(db)
    vi.spyOn(db, 'put').mockImplementation(async (storeName, value) => {
      const result = await put(storeName, value)
      if (storeName === 'folder-records' && 'id' in value && value.id.includes(':collection:')) {
        sessionRef.current = {
          userId: 'user-2',
          displayName: 'Grace',
          roles: ['media_sync_user']
        }
      }
      return result
    })

    await expect(
      importHhcLineCollection(auth(sessionRef), {
        remoteItemId: 'collection-1',
        name: 'Sunday',
        parentRemoteItemId: null
      })
    ).rejects.toThrow('HHC account changed')

    await expect(db.getAll('folder-records')).resolves.toEqual([])
    await expect(db.getAll('folder-items')).resolves.toEqual([])
    await expect(getSyncEntryByRemoteItem('hhc-line:user-1', 'item-1')).resolves.toBeUndefined()
  })

  it('rejects repeated collection cursors', async () => {
    mocks.api = api({
      listCollections: vi.fn(async () => ({
        collections: [],
        cursor: 'same-cursor',
        hasMore: true
      }))
    })
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }

    await expect(listHhcLineCollections(auth(sessionRef))).rejects.toThrow(
      'Invalid HHC collection pagination'
    )
    expect(mocks.api.listCollections).toHaveBeenCalledTimes(2)
  })

  it('bounds unique collection cursor chains', async () => {
    let page = 0
    mocks.api = api({
      listCollections: vi.fn(async () => {
        page += 1
        if (page > 1_000) throw new Error('unbounded collection pagination escaped')
        return {
          collections: [],
          cursor: `page-${page}`,
          hasMore: true
        }
      })
    })
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }

    await expect(listHhcLineCollections(auth(sessionRef))).rejects.toThrow(
      'Invalid HHC collection pagination'
    )
    expect(mocks.api!.listCollections).toHaveBeenCalledTimes(1_000)
  })

  it('waits for a full snapshot when a delta cannot safely update pending entries', async () => {
    const remoteItem = {
      id: 'item-1',
      collectionId: 'collection-1',
      remoteItemId: 'source-1',
      displayName: 'photo.jpg',
      sourceRevision: 'sha256:one',
      createdRevision: 1,
      mimeType: 'image/jpeg',
      sizeBytes: 42,
      etag: '"etag-1"',
      createdAt: '2026-08-17T00:00:00Z'
    }
    const getCollectionChanges = vi
      .fn()
      .mockResolvedValueOnce({
        collection: collection('collection-1', 'Sunday'),
        items: [remoteItem],
        tombstones: [],
        cursor: 'reset-barrier-1',
        hasMore: true,
        reset: true
      })
      .mockResolvedValueOnce({
        collection: collection('collection-1', 'Sunday'),
        items: [],
        tombstones: [],
        cursor: 'revision-1',
        hasMore: false,
        reset: false
      })
      .mockResolvedValueOnce({
        collection: collection('collection-1', 'Sunday'),
        items: [],
        tombstones: [],
        cursor: 'revision-2',
        hasMore: false,
        reset: false
      })
      .mockResolvedValueOnce({
        collection: collection('collection-1', 'Sunday'),
        items: [remoteItem],
        tombstones: [],
        cursor: 'reset-barrier-2',
        hasMore: true,
        reset: true
      })
      .mockResolvedValueOnce({
        collection: collection('collection-1', 'Sunday'),
        items: [],
        tombstones: [],
        cursor: 'revision-3',
        hasMore: false,
        reset: false
      })
    mocks.api = api({ getCollectionChanges })
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }
    await importHhcLineCollection(auth(sessionRef), {
      remoteItemId: 'collection-1',
      name: 'Sunday',
      parentRemoteItemId: null
    })
    const entry = await getSyncEntryByRemoteItem('hhc-line:user-1', 'item-1')
    await putSyncEntry({ ...entry!, status: 'queued' })
    const [root] = await (await openFileExplorerDB()).getAll('folder-records')

    await refreshHhcLineFolder(auth(sessionRef), root.id)

    expect(getCollectionChanges).toHaveBeenNthCalledWith(3, 'collection-1', 'revision-1')
    expect(getCollectionChanges).toHaveBeenNthCalledWith(4, 'collection-1')
  })

  it('does not preserve downloaded metadata when the HHC blob is missing', async () => {
    mocks.electron = true
    const originalItem = {
      id: 'item-1',
      collectionId: 'collection-1',
      remoteItemId: 'source-1',
      displayName: 'photo.jpg',
      sourceRevision: 'sha256:one',
      createdRevision: 1,
      mimeType: 'image/jpeg',
      sizeBytes: 42,
      etag: '"etag-1"',
      createdAt: '2026-08-17T00:00:00Z'
    }
    const getCollectionChanges = vi
      .fn()
      .mockResolvedValueOnce({
        collection: collection('collection-1', 'Sunday'),
        items: [originalItem],
        tombstones: [],
        cursor: 'reset-barrier',
        hasMore: true,
        reset: true
      })
      .mockResolvedValueOnce({
        collection: collection('collection-1', 'Sunday'),
        items: [],
        tombstones: [],
        cursor: 'revision-1',
        hasMore: false,
        reset: false
      })
      .mockResolvedValueOnce({
        collection: collection('collection-1', 'Sunday'),
        items: [{ ...originalItem, displayName: 'renamed.jpg', updatedRevision: 2 }],
        tombstones: [],
        cursor: 'revision-2',
        hasMore: false,
        reset: false
      })
    mocks.api = api({ getCollectionChanges })
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }
    await importHhcLineCollection(auth(sessionRef), {
      remoteItemId: 'collection-1',
      name: 'Sunday',
      parentRemoteItemId: null
    })
    const entry = await getSyncEntryByRemoteItem('hhc-line:user-1', 'item-1')
    await putSyncEntry({ ...entry!, blobId: entry!.itemId, status: 'available-offline' })
    const [root] = await (await openFileExplorerDB()).getAll('folder-records')

    await refreshHhcLineFolder(auth(sessionRef), root.id)

    const refreshed = await getSyncEntryByRemoteItem('hhc-line:user-1', 'item-1')
    expect(refreshed).toMatchObject({
      name: 'renamed.jpg',
      status: 'remote-only'
    })
    expect(refreshed?.blobId).toBeUndefined()
  })

  it('removes an account-scoped root when the account changes after refresh writes', async () => {
    const sessionRef: { current: HhcSession | null } = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }
    await importHhcLineCollection(auth(sessionRef), {
      remoteItemId: 'collection-1',
      name: 'Sunday',
      parentRemoteItemId: null
    })
    const [root] = await (await openFileExplorerDB()).getAll('folder-records')
    const apply = syncRefresh.applySyncRefreshPlan
    vi.spyOn(syncRefresh, 'applySyncRefreshPlan').mockImplementationOnce(async (plan) => {
      await apply(plan)
      sessionRef.current = {
        userId: 'user-2',
        displayName: 'Grace',
        roles: ['media_sync_user']
      }
    })

    await expect(refreshHhcLineFolder(auth(sessionRef), root.id)).rejects.toThrow(
      'HHC account changed'
    )
    await expect((await openFileExplorerDB()).getAll('folder-records')).resolves.toEqual([])
  })

  it('coalesces refreshes by root while allowing different roots to proceed', async () => {
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: ['media_sync_user'] }
    }
    await importHhcLineCollection(auth(sessionRef), {
      remoteItemId: 'collection-1',
      name: 'Sunday',
      parentRemoteItemId: null
    })
    await importHhcLineCollection(auth(sessionRef), {
      remoteItemId: 'collection-2',
      name: 'Youth',
      parentRemoteItemId: null
    })
    const roots = await (await openFileExplorerDB()).getAll('folder-records')
    const rootByCollection = new Map(roots.map((root) => [root.syncLink!.remoteFolderId, root]))
    const resolvers = new Map<string, (value: HhcAssetCollectionChangePage) => void>()
    const getCollectionChanges = vi.fn(
      (collectionId: string) =>
        new Promise<HhcAssetCollectionChangePage>((resolve) => {
          resolvers.set(collectionId, resolve)
        })
    )
    mocks.api!.getCollectionChanges = getCollectionChanges

    const first = refreshHhcLineFolder(auth(sessionRef), rootByCollection.get('collection-1')!.id)
    const duplicate = refreshHhcLineFolder(
      auth(sessionRef),
      rootByCollection.get('collection-1')!.id
    )
    const independent = refreshHhcLineFolder(
      auth(sessionRef),
      rootByCollection.get('collection-2')!.id
    )
    await vi.waitFor(() => expect(getCollectionChanges).toHaveBeenCalledTimes(2))

    expect(first).toBe(duplicate)
    for (const collectionId of ['collection-1', 'collection-2']) {
      resolvers.get(collectionId)!({
        collection: collection(collectionId, collectionId),
        items: [],
        tombstones: [],
        cursor: `${collectionId}-revision-2`,
        hasMore: false,
        reset: false
      })
    }
    await Promise.all([first, duplicate, independent])
  })
})
