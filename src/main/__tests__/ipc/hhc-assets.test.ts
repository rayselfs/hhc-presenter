import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  mockFetch,
  mockGetAccessToken,
  mockRefreshAfterUnauthorized,
  mockMkdir,
  mockOpen,
  mockRename,
  mockRm,
  mockWrite,
  mockClose,
  mockRegisterLease,
  mockReleaseLease,
  mockClearLeases
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  mockFetch: vi.fn(),
  mockGetAccessToken: vi.fn(),
  mockRefreshAfterUnauthorized: vi.fn(),
  mockMkdir: vi.fn(),
  mockOpen: vi.fn(),
  mockRename: vi.fn(),
  mockRm: vi.fn(),
  mockWrite: vi.fn(),
  mockClose: vi.fn(),
  mockRegisterLease: vi.fn(),
  mockReleaseLease: vi.fn(),
  mockClearLeases: vi.fn()
}))

const mainWindow = { id: 1 }
const projectionWindow = { id: 2 }

vi.mock('../../ipc/video-remux', () => ({
  mutateVideoSource: vi.fn((_sourceFileId: string, mutation: () => Promise<unknown>) => mutation())
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/hhc-user-data') },
  BrowserWindow: { fromWebContents: vi.fn(() => mainWindow) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  },
  net: { fetch: mockFetch }
}))

vi.mock('node:fs', () => {
  const promises = { mkdir: mockMkdir, open: mockOpen, rename: mockRename, rm: mockRm }
  return { default: { promises }, promises }
})

vi.mock('../../ipc/native-fs', () => ({
  getNativeFilePath: (id: string) => `/tmp/hhc-user-data/native-files/${id}`,
  registerNativeMediaLease: mockRegisterLease,
  releaseNativeMediaLease: mockReleaseLease,
  clearNativeMediaLeases: mockClearLeases
}))

import { BrowserWindow } from 'electron'
import type { HhcAuthService } from '../../ipc/hhc-auth'
import { registerHhcAssetHandlers } from '../../ipc/hhc-assets'
import type { WindowManager } from '../../windowManager'

const wm = { getMainWindow: vi.fn(() => mainWindow) } as unknown as WindowManager
const auth = {
  getAccessToken: mockGetAccessToken,
  refreshAfterUnauthorized: mockRefreshAfterUnauthorized
} as unknown as HhcAuthService

function event(): Electron.IpcMainInvokeEvent {
  return { sender: {} } as Electron.IpcMainInvokeEvent
}

function handler(channel: string): (...args: unknown[]) => unknown {
  const registered = handlers.get(channel)
  if (!registered) throw new Error(`Missing handler ${channel}`)
  return registered
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function collection(id = 'collection_1'): object {
  return {
    id,
    namespace: 'line.group.media-sync',
    name: 'Group',
    revision: 1,
    createdAt: '2026-08-17T00:00:00Z',
    updatedAt: '2026-08-17T00:00:00Z'
  }
}

function changeItem(index: number): object {
  return {
    id: `item_${index}`,
    collectionId: 'collection_1',
    remoteItemId: `source_${index}`,
    displayName: `photo-${index}.jpg`,
    sourceRevision: `sha256-${index}`,
    createdRevision: 1,
    createdAt: '2026-08-17T00:00:00Z'
  }
}

function tombstone(index: number): object {
  return {
    id: `deleted_${index}`,
    remoteItemId: `deleted-source_${index}`,
    deletedRevision: 2,
    deletedAt: '2026-08-17T00:01:00Z'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mainWindow as never)
  mockGetAccessToken.mockResolvedValue('token-1')
  mockRefreshAfterUnauthorized.mockResolvedValue('token-2')
  mockMkdir.mockResolvedValue(undefined)
  mockWrite.mockResolvedValue(undefined)
  mockClose.mockResolvedValue(undefined)
  mockRename.mockResolvedValue(undefined)
  mockRm.mockResolvedValue(undefined)
  mockOpen.mockResolvedValue({ writeFile: mockWrite, close: mockClose })
  mockRegisterLease.mockReturnValue({
    kind: 'native-lease',
    url: 'hhc-media://lease/123e4567-e89b-12d3-a456-426614174000?type=video%2Fmp4',
    leaseId: '123e4567-e89b-12d3-a456-426614174000',
    etag: '"etag-1"'
  })
  registerHhcAssetHandlers(wm, auth)
})

describe('HHC Asset IPC', () => {
  it('owns the exact public Gateway URLs and bearer identity in main', async () => {
    mockFetch
      .mockResolvedValueOnce(json({ collections: [], cursor: 'next', hasMore: true }))
      .mockResolvedValueOnce(
        json({
          collection: {
            id: 'collection_1',
            namespace: 'line.group.media-sync',
            name: 'Group',
            revision: 1,
            createdAt: '2026-08-17T00:00:00Z',
            updatedAt: '2026-08-17T00:00:00Z'
          },
          items: [],
          tombstones: [],
          cursor: 'revision_1',
          hasMore: false,
          reset: false
        })
      )

    await handler('hhc-assets:list-collections')(event(), 'cursor / 1')
    await handler('hhc-assets:get-collection-changes')(event(), {
      collectionId: 'collection_1',
      cursor: 'revision / 1'
    })

    expect(mockFetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://www.alive.org.tw/api/assets/collections?limit=100&cursor=cursor+%2F+1',
      'https://www.alive.org.tw/api/assets/collections/collection_1/changes?cursor=revision+%2F+1'
    ])
    for (const [, init] of mockFetch.mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-1')
    }
  })

  it('uses only exact item and ticket routes with encoded query-free opaque IDs', async () => {
    mockFetch
      .mockResolvedValueOnce(
        json({
          id: 'item_1',
          collectionId: 'collection_1',
          remoteItemId: 'source_1',
          displayName: 'photo.jpg',
          sourceRevision: 'sha256',
          createdRevision: 1,
          createdAt: '2026-08-17T00:00:00Z'
        })
      )
      .mockResolvedValueOnce(
        json(
          {
            contentUrl: '/api/assets/content?ticket=opaque-secret',
            expiresAt: '2026-08-17T01:00:00Z',
            etag: '"etag-1"'
          },
          201
        )
      )

    await handler('hhc-assets:get-collection-item')(event(), {
      collectionId: 'collection_1',
      itemId: 'item_1'
    })
    await handler('hhc-assets:issue-content-ticket')(event(), {
      collectionId: 'collection_1',
      itemId: 'item_1'
    })

    expect(mockFetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://www.alive.org.tw/api/assets/collections/collection_1/items/item_1',
      'https://www.alive.org.tw/api/assets/collections/collection_1/items/item_1/content-ticket'
    ])
    expect(mockFetch.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' })
  })

  it('refreshes once in main and maps a second 401 without looping', async () => {
    mockFetch.mockResolvedValue(json({}, 401))

    await expect(handler('hhc-assets:list-collections')(event())).rejects.toThrow(
      'HHC_ASSET_AUTH_REQUIRED'
    )
    expect(mockRefreshAfterUnauthorized).toHaveBeenCalledWith('token-1')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('bounds declared and chunked JSON response bytes before IPC', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ collections: [], hasMore: false }), {
          headers: { 'content-length': String(2 * 1024 * 1024 + 1) }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ collections: [], hasMore: false, padding: 'x'.repeat(2 * 1024 * 1024) })
        )
      )

    await expect(handler('hhc-assets:list-collections')(event())).rejects.toThrow(
      'HHC_ASSET_FATAL:INVALID_BODY'
    )
    await expect(handler('hhc-assets:list-collections')(event())).rejects.toThrow(
      'HHC_ASSET_FATAL:INVALID_BODY'
    )
  })

  it('distinguishes malformed response bodies from invalid response schemas', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('{'))
      .mockResolvedValueOnce(json({ collections: 'invalid', hasMore: false }))

    await expect(handler('hhc-assets:list-collections')(event())).rejects.toThrow(
      'HHC_ASSET_FATAL:INVALID_BODY'
    )
    await expect(handler('hhc-assets:list-collections')(event())).rejects.toThrow(
      'HHC_ASSET_FATAL:INVALID_SCHEMA'
    )
  })

  it('projects exact DTOs and strips unknown upstream fields before IPC', async () => {
    mockFetch.mockResolvedValueOnce(
      json({
        collections: [{ ...collection(), secret: 'must-not-cross' }],
        cursor: 'next',
        hasMore: false,
        secret: 'must-not-cross'
      })
    )

    await expect(handler('hhc-assets:list-collections')(event())).resolves.toEqual({
      collections: [collection()],
      cursor: 'next',
      hasMore: false
    })
  })

  it('projects exact item and change DTOs without upstream-only fields', async () => {
    const assetItem = {
      id: 'item_1',
      collectionId: 'collection_1',
      remoteItemId: 'source_1',
      displayName: 'photo.jpg',
      sourceRevision: 'sha256',
      createdRevision: 1,
      createdAt: '2026-08-17T00:00:00Z'
    }
    const tombstone = {
      id: 'item_2',
      remoteItemId: 'source_2',
      deletedRevision: 2,
      deletedAt: '2026-08-17T00:01:00Z'
    }
    mockFetch
      .mockResolvedValueOnce(json({ ...assetItem, secret: 'must-not-cross' }))
      .mockResolvedValueOnce(
        json({
          collection: { ...collection(), secret: 'must-not-cross' },
          items: [{ ...assetItem, secret: 'must-not-cross' }],
          tombstones: [{ ...tombstone, secret: 'must-not-cross' }],
          cursor: 'revision_2',
          hasMore: false,
          reset: false,
          secret: 'must-not-cross'
        })
      )

    await expect(
      handler('hhc-assets:get-collection-item')(event(), {
        collectionId: 'collection_1',
        itemId: 'item_1'
      })
    ).resolves.toEqual(assetItem)
    await expect(
      handler('hhc-assets:get-collection-changes')(event(), {
        collectionId: 'collection_1'
      })
    ).resolves.toEqual({
      collection: collection(),
      items: [assetItem],
      tombstones: [tombstone],
      cursor: 'revision_2',
      hasMore: false,
      reset: false
    })
  })

  it('posts an exact bounded available-offline receipt with main-owned auth', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }))
    const receipt = {
      collectionItemId: 'item_1',
      contentVersion: '"etag-1"',
      state: 'available-offline' as const,
      appVersion: '2.4.0'
    }

    await expect(
      handler('hhc-assets:record-sync-receipt')(event(), receipt)
    ).resolves.toBeUndefined()
    expect(mockFetch).toHaveBeenCalledWith(
      'https://www.alive.org.tw/api/assets/sync-receipts',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(receipt) })
    )
    expect(new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer token-1'
    )

    await expect(
      handler('hhc-assets:record-sync-receipt')(event(), { ...receipt, userId: 'leak' })
    ).rejects.toThrow('Invalid HHC Asset request')
  })

  it('rejects negative item and tombstone revisions', async () => {
    mockFetch
      .mockResolvedValueOnce(
        json({
          collection: collection(),
          items: [
            {
              id: 'item_1',
              collectionId: 'collection_1',
              remoteItemId: 'source_1',
              displayName: 'photo.jpg',
              sourceRevision: 'sha256',
              createdRevision: -1,
              createdAt: '2026-08-17T00:00:00Z'
            }
          ],
          tombstones: [],
          cursor: 'revision_1',
          hasMore: false,
          reset: false
        })
      )
      .mockResolvedValueOnce(
        json({
          collection: collection(),
          items: [],
          tombstones: [
            {
              id: 'item_1',
              remoteItemId: 'source_1',
              deletedRevision: -1,
              deletedAt: '2026-08-17T00:00:00Z'
            }
          ],
          cursor: 'revision_1',
          hasMore: false,
          reset: false
        })
      )

    for (let index = 0; index < 2; index += 1) {
      await expect(
        handler('hhc-assets:get-collection-changes')(event(), {
          collectionId: 'collection_1'
        })
      ).rejects.toThrow('HHC_ASSET_FATAL')
    }
  })

  it('rejects malformed numeric DTOs and arrays above the 500-item contract', async () => {
    mockFetch
      .mockResolvedValueOnce(
        json({ collections: [{ ...collection(), revision: -1 }], hasMore: false })
      )
      .mockResolvedValueOnce(
        json({
          collections: Array.from({ length: 501 }, (_, index) => collection(`c_${index}`)),
          hasMore: false
        })
      )

    await expect(handler('hhc-assets:list-collections')(event())).rejects.toThrow('HHC_ASSET_FATAL')
    await expect(handler('hhc-assets:list-collections')(event())).rejects.toThrow('HHC_ASSET_FATAL')
  })

  it('accepts and projects the maximum 500-item collection page', async () => {
    mockFetch.mockResolvedValueOnce(
      json({
        collections: Array.from({ length: 500 }, (_, index) => collection(`c_${index}`)),
        hasMore: false
      })
    )

    const result = await handler('hhc-assets:list-collections')(event())
    expect(result).toMatchObject({ hasMore: false })
    expect((result as { collections: unknown[] }).collections).toHaveLength(500)
  })

  it('bounds a mixed change page to 500 items and tombstones combined', async () => {
    const page = (itemCount: number, tombstoneCount: number): object => ({
      collection: collection(),
      items: Array.from({ length: itemCount }, (_, index) => changeItem(index)),
      tombstones: Array.from({ length: tombstoneCount }, (_, index) => tombstone(index)),
      cursor: 'revision_2',
      hasMore: false,
      reset: false
    })
    mockFetch
      .mockResolvedValueOnce(json(page(250, 250)))
      .mockResolvedValueOnce(json(page(251, 250)))

    await expect(
      handler('hhc-assets:get-collection-changes')(event(), { collectionId: 'collection_1' })
    ).resolves.toMatchObject({ items: expect.any(Array), tombstones: expect.any(Array) })
    await expect(
      handler('hhc-assets:get-collection-changes')(event(), { collectionId: 'collection_1' })
    ).rejects.toThrow('HHC_ASSET_FATAL')
  })

  it.each([
    [403, 'HHC_ASSET_ACCESS_REVOKED'],
    [404, 'HHC_ASSET_ACCESS_REVOKED:404'],
    [429, 'HHC_ASSET_RETRYABLE'],
    [503, 'HHC_ASSET_RETRYABLE']
  ] as const)('maps HTTP %s without exposing response bodies', async (status, code) => {
    mockFetch.mockResolvedValue(json({ ticket: 'must-not-leak' }, status))

    await expect(handler('hhc-assets:list-collections')(event())).rejects.toThrow(code)
  })

  it('rejects non-main senders and every renderer-supplied trust-boundary field', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(projectionWindow as never)
    await expect(handler('hhc-assets:list-collections')(event())).rejects.toThrow('Unauthorized')
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mainWindow as never)

    for (const field of ['token', 'userId', 'role', 'url', 'path']) {
      await expect(
        handler('hhc-assets:get-collection-item')(event(), {
          collectionId: 'collection_1',
          itemId: 'item_1',
          [field]: 'attacker-controlled'
        })
      ).rejects.toThrow('Invalid HHC Asset request')
    }
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it.each([
    [{ collectionId: '../escape', itemId: 'item_1' }],
    [{ collectionId: 'collection_1', itemId: '%2F' }],
    [{ collectionId: 'collection_1', itemId: 'item_1', range: 'bytes=0-1,4-5' }]
  ])('rejects invalid opaque IDs and multi-range input', async (request) => {
    await expect(handler('hhc-assets:get-collection-item')(event(), request)).rejects.toThrow(
      'Invalid HHC Asset request'
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('streams authenticated content to an app-owned native file without renderer paths', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'video/mp4', 'content-length': '3', etag: '"etag-1"' }
      })
    )

    await expect(
      handler('hhc-assets:download-file')(event(), {
        collectionId: 'collection_1',
        itemId: 'item_1',
        rootRemoteFolderId: 'collection_1',
        targetFileId: '123e4567-e89b-12d3-a456-426614174000'
      })
    ).resolves.toEqual({
      fileId: '123e4567-e89b-12d3-a456-426614174000',
      size: 3,
      mimeType: 'video/mp4'
    })
    expect(mockWrite).toHaveBeenCalledWith(expect.any(Buffer))
    expect(mockRename).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp$/),
      '/tmp/hhc-user-data/native-files/123e4567-e89b-12d3-a456-426614174000'
    )
  })

  it('cancels an active native download before the final rename', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>
    mockFetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
          }
        }),
        { headers: { 'content-type': 'video/mp4', 'content-length': '3' } }
      )
    )
    const targetFileId = '123e4567-e89b-12d3-a456-426614174000'
    const pending = handler('hhc-assets:download-file')(event(), {
      collectionId: 'collection_1',
      itemId: 'item_1',
      rootRemoteFolderId: 'collection_1',
      targetFileId
    })
    await vi.waitFor(() => expect(mockOpen).toHaveBeenCalledOnce())

    await expect(
      handler('hhc-assets:cancel-download')(event(), targetFileId)
    ).resolves.toBeUndefined()
    stream.enqueue(new Uint8Array([1, 2, 3]))
    stream.close()

    await expect(pending).rejects.toThrow('HHC_ASSET_DOWNLOAD_CANCELLED')
    expect(mockRename).not.toHaveBeenCalled()
    expect(mockRm).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), { force: true })
  })

  it('keeps native download cancellation on the authorized opaque-ID boundary', async () => {
    await expect(handler('hhc-assets:cancel-download')(event(), '../file')).rejects.toThrow(
      'Invalid HHC Asset request'
    )

    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(projectionWindow as never)
    await expect(
      handler('hhc-assets:cancel-download')(event(), '123e4567-e89b-12d3-a456-426614174000')
    ).rejects.toThrow('Unauthorized')
  })

  it('fails closed when an HHC download root does not match its collection', async () => {
    await expect(
      handler('hhc-assets:download-file')(event(), {
        collectionId: 'collection_1',
        itemId: 'item_1',
        rootRemoteFolderId: 'collection_2',
        targetFileId: '123e4567-e89b-12d3-a456-426614174000'
      })
    ).rejects.toThrow('Invalid HHC Asset request')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('removes the temporary file when the final native rename fails', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'video/mp4', 'content-length': '3' }
      })
    )
    mockRename.mockRejectedValueOnce(new Error('disk busy'))

    await expect(
      handler('hhc-assets:download-file')(event(), {
        collectionId: 'collection_1',
        itemId: 'item_1',
        rootRemoteFolderId: 'collection_1',
        targetFileId: '123e4567-e89b-12d3-a456-426614174000'
      })
    ).rejects.toThrow('disk busy')
    expect(mockRm).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), { force: true })
  })

  it('creates and releases an opaque session lease and bounds declared response size', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'video/mp4', 'content-length': '3', etag: '"etag-1"' }
      })
    )
    await expect(
      handler('hhc-assets:create-content-lease')(event(), {
        collectionId: 'collection_1',
        itemId: 'item_1'
      })
    ).resolves.toMatchObject({ kind: 'native-lease', etag: '"etag-1"' })
    expect(mockRegisterLease).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/hhc-user-data/hhc-asset-leases/'),
      'video/mp4',
      '"etag-1"'
    )

    await handler('hhc-assets:release-content-lease')(
      event(),
      '123e4567-e89b-12d3-a456-426614174000'
    )
    expect(mockReleaseLease).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174000')

    mockFetch.mockResolvedValueOnce(
      new Response(null, { headers: { 'content-length': String(209_715_201) } })
    )
    await expect(
      handler('hhc-assets:create-content-lease')(event(), {
        collectionId: 'collection_1',
        itemId: 'item_1'
      })
    ).rejects.toThrow('HHC_ASSET_FATAL')
  })

  it('clears every native lease through the authorized main-window boundary', async () => {
    await handler('hhc-assets:clear-content-leases')(event())

    expect(mockClearLeases).toHaveBeenCalledOnce()

    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(projectionWindow as never)
    await expect(handler('hhc-assets:clear-content-leases')(event())).rejects.toThrow(
      'Unauthorized'
    )
  })
})
