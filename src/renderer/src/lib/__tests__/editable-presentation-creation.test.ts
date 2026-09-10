import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItemRecord } from '@shared/types/folder'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { getDerivedAsset, listDerivedAssets, resetMediaWorkDBForTests } from '../media-work-db'
import {
  persistEditablePresentationCreation,
  type EditablePresentationCreationInput
} from '../editable-presentation-creation'
import { listResourceCleanupRecords } from '../resource-cleanup-journal'
import { resetThumbnailDBForTests } from '../thumbnail-db'

const body = JSON.stringify({ id: 'deck-1', name: 'Sunday', updatedAt: 1 })
const item: FileItemRecord = {
  id: 'deck-1',
  parentId: 'file-root',
  type: 'file',
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null,
  name: 'Sunday',
  url: 'blob:deck-1',
  size: body.length,
  mimeType: 'application/x-hhc-presentation+json'
}
const input: EditablePresentationCreationInput = {
  item,
  blob: new Blob([body], { type: item.mimeType }),
  thumbnail: 'data:image/svg+xml;base64,PHN2Zy8+'
}

beforeEach(async () => {
  await resetFileExplorerDBForTests()
  await resetMediaWorkDBForTests()
  await resetThumbnailDBForTests()
  useFileExplorerStore.setState({
    items: {},
    _itemsArray: [],
    _itemsByParent: {},
    pendingPersistenceCount: 0
  })
})

describe('persistEditablePresentationCreation', () => {
  it('persists one canonical body before publishing the item', async () => {
    await persistEditablePresentationCreation(input)

    const db = await openFileExplorerDB()
    const source = await db.get('file-blobs', item.id)
    const mirror = await getDerivedAsset(
      item.id,
      'editable-presentation-document',
      'document:deck-1'
    )

    expect(source).toMatchObject({ id: item.id, size: input.blob.size, refCount: 1 })
    expect(mirror).toBeUndefined()
    expect(useFileExplorerStore.getState().items[item.id]).toEqual(item)
  })

  it.each([
    ['catalog', { openFileExplorerDB: vi.fn(async () => Promise.reject(new Error('catalog'))) }],
    ['thumbnail', { saveThumbnail: vi.fn(async () => Promise.reject(new Error('thumbnail'))) }],
    [
      'publication',
      {
        publishItem: vi.fn(() => {
          throw new Error('publication')
        })
      }
    ]
  ])('compensates every durable resource after a %s failure', async (_stage, dependencies) => {
    await expect(persistEditablePresentationCreation(input, dependencies)).rejects.toBeInstanceOf(
      Error
    )

    const db = await openFileExplorerDB()
    await expect(db.get('folder-items', item.id)).resolves.toBeUndefined()
    await expect(db.get('file-blobs', item.id)).resolves.toBeUndefined()
    await expect(listDerivedAssets()).resolves.toEqual([])
    expect(useFileExplorerStore.getState().items[item.id]).toBeUndefined()
    await expect(listResourceCleanupRecords()).resolves.toEqual([])
  })

  it('journals a failed external compensation after removing the catalog entry', async () => {
    const changed = vi.fn()
    window.addEventListener('hhc:recovery-source-changed', changed)
    await expect(
      persistEditablePresentationCreation(input, {
        saveThumbnail: vi.fn(async () => Promise.reject(new Error('thumbnail'))),
        deleteDerivedAssetsForSource: vi.fn(async () =>
          Promise.reject(new Error('derived cleanup failed'))
        )
      })
    ).rejects.toThrow('thumbnail')
    window.removeEventListener('hhc:recovery-source-changed', changed)

    const db = await openFileExplorerDB()
    await expect(db.get('folder-items', item.id)).resolves.toBeUndefined()
    await expect(db.get('file-blobs', item.id)).resolves.toBeUndefined()
    await expect(listResourceCleanupRecords()).resolves.toEqual([
      expect.objectContaining({
        blobId: item.id,
        status: 'pending',
        deleteDerivedAssets: true,
        itemThumbnailIds: [item.id]
      })
    ])
    expect(changed).toHaveBeenCalledOnce()
  })
})

it('retains a durable personal creation when thumbnail generation fails', async () => {
  const { usePersonalSyncStore } = await import('../../stores/personal-sync')
  const { ensurePersonalLocalSpace } = await import('../personal-file-actions')
  usePersonalSyncStore.getState().setAccount('authenticated', 'alice', true)
  await ensurePersonalLocalSpace(
    'alice',
    { id: 'space', revision: 0, usedBytes: 0, quotaBytes: 100 * 1024 ** 3 },
    new AbortController().signal
  )
  const personalItem = { ...item, parentId: 'personal:space' }
  await persistEditablePresentationCreation(
    { ...input, item: personalItem },
    {
      saveThumbnail: vi.fn().mockRejectedValue(new Error('Thumbnail quota'))
    }
  )
  const db = await openFileExplorerDB()
  expect(await db.get('folder-items', item.id)).toMatchObject({ personalOwnerId: 'alice' })
  expect(await db.getAll('personal-sync-outbox')).toHaveLength(1)
  expect(await db.get('file-blobs', item.id)).toMatchObject({ refCount: 2 })
  usePersonalSyncStore.getState().setAccount('anonymous')
})
