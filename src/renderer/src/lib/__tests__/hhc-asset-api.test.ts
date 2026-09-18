import { describe, expect, it, vi } from 'vitest'
import { createHhcAssetApi, HhcAssetApiError } from '../hhc-asset-api'
import { createBrowserHhcAssetApi } from '../hhc-asset-api-browser'
import { createElectronHhcAssetApi } from '../hhc-asset-api-electron'

const ORIGIN = 'https://www.alive.org.tw'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function collectionPage(): object {
  return {
    collections: [
      {
        id: 'collection_1',
        namespace: 'line.group.media-sync',
        name: 'Group media',
        revision: 7,
        createdAt: '2026-08-17T00:00:00Z',
        updatedAt: '2026-08-17T00:00:00Z'
      }
    ],
    cursor: 'next cursor',
    hasMore: true
  }
}

function changePage(itemCount: number, tombstoneCount: number): object {
  const collection = (collectionPage() as { collections: object[] }).collections[0]
  return {
    collection,
    items: Array.from({ length: itemCount }, (_, index) => ({
      id: `item_${index}`,
      collectionId: 'collection_1',
      remoteItemId: `source_${index}`,
      displayName: `photo-${index}.jpg`,
      sourceRevision: `sha256-${index}`,
      createdRevision: 1,
      createdAt: '2026-08-17T00:00:00Z'
    })),
    tombstones: Array.from({ length: tombstoneCount }, (_, index) => ({
      id: `deleted_${index}`,
      remoteItemId: `deleted-source_${index}`,
      deletedRevision: 2,
      deletedAt: '2026-08-17T00:01:00Z'
    })),
    cursor: 'revision_2',
    hasMore: false,
    reset: false
  }
}

describe('browser HHC Asset API', () => {
  it('uses only context-owned auth callbacks', async () => {
    const getAccessToken = vi.fn(async () => 'context-token')
    const refreshAfterUnauthorized = vi.fn(async () => 'context-refresh')
    const originalFetch = window.fetch
    window.fetch = vi.fn(async () => jsonResponse(collectionPage()))

    try {
      const api = await createHhcAssetApi({ getAccessToken, refreshAfterUnauthorized })
      await api.listCollections()
      expect(getAccessToken).toHaveBeenCalledOnce()
      expect(
        new Headers(vi.mocked(window.fetch).mock.calls[0]?.[1]?.headers).get('authorization')
      ).toBe('Bearer context-token')
    } finally {
      window.fetch = originalFetch
    }
  })

  it.each(['https://asset-api.internal', `${ORIGIN}/path`, `${ORIGIN}/`])(
    'rejects a runtime origin outside the exact configured Gateway: %s',
    (origin) => {
      expect(() =>
        createBrowserHhcAssetApi({
          origin,
          getAccessToken: vi.fn(),
          refreshAfterUnauthorized: vi.fn()
        })
      ).toThrow('Invalid HHC Asset origin')
    }
  )

  it('uses exact public reader routes and URL-encodes opaque IDs and cursors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(collectionPage()))
      .mockResolvedValueOnce(
        jsonResponse({
          collection: (collectionPage() as { collections: object[] }).collections[0],
          items: [],
          tombstones: [],
          cursor: 'revision 7',
          hasMore: false,
          reset: true
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'item_1',
          collectionId: 'collection_1',
          remoteItemId: 'source_1',
          displayName: 'photo.jpg',
          sourceRevision: 'checksum',
          createdRevision: 7,
          mimeType: 'image/jpeg',
          sizeBytes: 12,
          etag: '"etag"',
          createdAt: '2026-08-17T00:00:00Z'
        })
      )
    const api = createBrowserHhcAssetApi({
      origin: ORIGIN,
      getAccessToken: vi.fn(async () => 'token-1'),
      refreshAfterUnauthorized: vi.fn(async () => 'token-2'),
      fetcher
    })

    await api.listCollections('page / one')
    await api.getCollectionChanges('collection / one', 'revision / 7')
    await api.getCollectionItem('collection / one', 'item / one')
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await api.recordSyncReceipt({
      collectionItemId: 'item_1',
      contentVersion: '"etag"',
      state: 'available-offline',
      appVersion: '2.4.0'
    })

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${ORIGIN}/api/assets/collections?limit=500&cursor=page+%2F+one`,
      `${ORIGIN}/api/assets/collections/collection%20%2F%20one/changes?cursor=revision+%2F+7`,
      `${ORIGIN}/api/assets/collections/collection%20%2F%20one/items/item%20%2F%20one`,
      `${ORIGIN}/api/assets/sync-receipts`
    ])
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        collectionItemId: 'item_1',
        contentVersion: '"etag"',
        state: 'available-offline',
        appVersion: '2.4.0'
      })
    })
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-1')
    }
  })

  it('bounds mixed browser change pages to 500 entries combined', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(changePage(250, 250)))
      .mockResolvedValueOnce(jsonResponse(changePage(251, 250)))
    const api = createBrowserHhcAssetApi({
      getAccessToken: vi.fn(async () => 'token-1'),
      refreshAfterUnauthorized: vi.fn(async () => 'token-2'),
      fetcher
    })

    await expect(api.getCollectionChanges('collection_1')).resolves.toMatchObject({
      items: expect.any(Array),
      tombstones: expect.any(Array)
    })
    await expect(api.getCollectionChanges('collection_1')).rejects.toMatchObject({
      classification: 'fatal'
    })
  })

  it('refreshes once on 401, retries once, and never loops on a second 401', async () => {
    const refreshAfterUnauthorized = vi.fn(async () => 'token-2')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 401))
    const api = createBrowserHhcAssetApi({
      origin: ORIGIN,
      getAccessToken: vi.fn(async () => 'token-1'),
      refreshAfterUnauthorized,
      fetcher
    })

    await expect(api.listCollections()).rejects.toMatchObject({ classification: 'auth-required' })
    expect(refreshAfterUnauthorized).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer token-2'
    )
  })

  it.each([
    [403, 'access-revoked'],
    [404, 'access-revoked'],
    [429, 'retryable'],
    [503, 'retryable']
  ] as const)('classifies HTTP %s as %s', async (status, classification) => {
    const api = createBrowserHhcAssetApi({
      origin: ORIGIN,
      getAccessToken: vi.fn(async () => 'token-1'),
      refreshAfterUnauthorized: vi.fn(async () => 'token-2'),
      fetcher: vi.fn(async () => jsonResponse({ secret: 'must-not-leak' }, status))
    })

    await expect(api.listCollections()).rejects.toMatchObject({ classification, status })
  })

  it('classifies network failures as retryable', async () => {
    const api = createBrowserHhcAssetApi({
      origin: ORIGIN,
      getAccessToken: vi.fn(async () => 'token-1'),
      refreshAfterUnauthorized: vi.fn(async () => 'token-2'),
      fetcher: vi.fn(async () => {
        throw new TypeError('offline')
      })
    })

    await expect(api.listCollections()).rejects.toMatchObject({ classification: 'retryable' })
  })

  it('issues memory-only tickets without exposing the ticket URL in errors', async () => {
    const ticketUrl = '/api/assets/content?ticket=super-secret-ticket'
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { contentUrl: ticketUrl, expiresAt: '2026-08-17T01:00:00Z', etag: '"etag"' },
          201
        )
      )
      .mockResolvedValueOnce(new Response('failed with super-secret-ticket', { status: 500 }))
    const api = createBrowserHhcAssetApi({
      origin: ORIGIN,
      getAccessToken: vi.fn(async () => 'token-1'),
      refreshAfterUnauthorized: vi.fn(async () => 'token-2'),
      fetcher
    })

    await expect(api.issueContentTicket('collection_1', 'item_1')).resolves.toMatchObject({
      contentUrl: `${ORIGIN}${ticketUrl}`
    })
    const error = await api
      .issueContentTicket('collection_1', 'item_1')
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HhcAssetApiError)
    expect(String(error)).not.toContain('super-secret-ticket')
    expect(JSON.stringify(error)).not.toContain('super-secret-ticket')
  })

  it('forwards only a single valid Range header to authenticated content', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([1, 2]), {
        status: 206,
        headers: { 'content-type': 'image/jpeg', 'content-range': 'bytes 0-1/2' }
      })
    )
    const api = createBrowserHhcAssetApi({
      origin: ORIGIN,
      getAccessToken: vi.fn(async () => 'token-1'),
      refreshAfterUnauthorized: vi.fn(async () => 'token-2'),
      fetcher
    })

    await api.downloadContent({
      collectionId: 'collection_1',
      itemId: 'item_1',
      rootRemoteFolderId: 'collection_1',
      range: 'bytes=0-1'
    })

    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `${ORIGIN}/api/assets/collections/collection_1/items/item_1/content`
    )
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('range')).toBe('bytes=0-1')
  })
})

describe('Electron HHC Asset API', () => {
  it('exposes only named preload operations and never sends renderer trust headers or URLs', async () => {
    const hhcAssets = {
      listCollections: vi.fn(async () => ({ collections: [], hasMore: false })),
      getCollectionChanges: vi.fn(),
      getCollectionItem: vi.fn(),
      issueContentTicket: vi.fn(),
      recordSyncReceipt: vi.fn(async () => undefined),
      downloadFile: vi.fn(async () => ({ fileId: 'file_1', size: 1, mimeType: 'image/jpeg' })),
      createContentLease: vi.fn(),
      releaseContentLease: vi.fn()
    }
    window.api = { hhcAssets } as unknown as typeof window.api
    const api = createElectronHhcAssetApi()

    await api.listCollections('cursor_1')
    await api.downloadContent({
      collectionId: 'collection_1',
      itemId: 'item_1',
      rootRemoteFolderId: 'collection_1',
      targetFileId: 'file_1'
    })
    await api.recordSyncReceipt({
      collectionItemId: 'item_1',
      contentVersion: '"etag"',
      state: 'available-offline',
      appVersion: '2.4.0'
    })

    expect(hhcAssets.listCollections).toHaveBeenCalledWith('cursor_1')
    expect(hhcAssets.downloadFile).toHaveBeenCalledWith({
      collectionId: 'collection_1',
      itemId: 'item_1',
      rootRemoteFolderId: 'collection_1',
      targetFileId: 'file_1'
    })
    expect(Object.keys(hhcAssets).sort()).toEqual([
      'createContentLease',
      'downloadFile',
      'getCollectionChanges',
      'getCollectionItem',
      'issueContentTicket',
      'listCollections',
      'recordSyncReceipt',
      'releaseContentLease'
    ])
  })

  it.each([
    ['HHC_ASSET_AUTH_REQUIRED', 'auth-required', 401],
    ['HHC_ASSET_ACCESS_REVOKED', 'access-revoked', 403],
    ['HHC_ASSET_ACCESS_REVOKED:404', 'access-revoked', 404],
    ['HHC_ASSET_RETRYABLE', 'retryable', undefined],
    ['HHC_ASSET_FATAL:INVALID_BODY', 'fatal', undefined],
    ['HHC_ASSET_FATAL:INVALID_SCHEMA', 'fatal', undefined]
  ] as const)('maps main error %s as %s', async (message, classification, status) => {
    window.api = {
      hhcAssets: {
        listCollections: vi.fn(async () => {
          throw new Error(message)
        })
      }
    } as unknown as typeof window.api

    await expect(createElectronHhcAssetApi().listCollections()).rejects.toMatchObject({
      classification,
      status
    })
  })
})
