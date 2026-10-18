import { beforeEach, describe, it, expect, vi } from 'vitest'
import { createBibleFolderDB, createFileExplorerFolderDB } from '@renderer/lib/folder-db'
import type { AnyItemRecord, FolderRecord, FolderPersistence } from '@shared/types/folder'

const ROOT_ID = 'test-root'

function makeItem(overrides: Partial<AnyItemRecord> = {}): AnyItemRecord {
  return {
    id: crypto.randomUUID(),
    type: 'verse',
    parentId: ROOT_ID,
    sortIndex: 0,
    createdAt: Date.now(),
    expiresAt: null,
    versionId: 1,
    bookNumber: 1,
    chapter: 1,
    verse: 1,
    text: 'test verse',
    ...overrides
  } as AnyItemRecord
}

function makeFolder(overrides: Partial<FolderRecord> = {}): FolderRecord {
  return {
    id: crypto.randomUUID(),
    name: 'Test folder',
    parentId: ROOT_ID,
    sortIndex: 0,
    createdAt: Date.now(),
    expiresAt: null,
    ...overrides
  }
}

import { openBibleDB } from '../bible-db'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'

beforeEach(async () => {
  vi.restoreAllMocks()
  const db = await openBibleDB()
  await db.clear('folder-records')
  await db.clear('folder-items')
  await resetFileExplorerDBForTests()
})

describe('persistence failure propagation', () => {
  const publicOperations: Array<{
    name: string
    run: (ops: FolderPersistence) => Promise<unknown>
  }> = [
    { name: 'loadAllFolders', run: (ops) => ops.loadAllFolders() },
    { name: 'saveFolder', run: (ops) => ops.saveFolder(makeFolder()) },
    { name: 'saveFolders', run: (ops) => ops.saveFolders([makeFolder()]) },
    { name: 'deleteFolders', run: (ops) => ops.deleteFolders(['folder']) },
    { name: 'loadItemsByParent', run: (ops) => ops.loadItemsByParent(ROOT_ID) },
    { name: 'saveItem', run: (ops) => ops.saveItem(makeItem()) },
    { name: 'saveItems', run: (ops) => ops.saveItems([makeItem()]) },
    { name: 'deleteItem', run: (ops) => ops.deleteItem('item') },
    { name: 'deleteItems', run: (ops) => ops.deleteItems(['item']) },
    { name: 'deleteItemsByParent', run: (ops) => ops.deleteItemsByParent(ROOT_ID) },
    { name: 'deleteExpired', run: (ops) => ops.deleteExpired!(Date.now()) },
    { name: 'purgeTrashOlderThan', run: (ops) => ops.purgeTrashOlderThan(Date.now(), 1_000) }
  ]

  it.each(publicOperations)('propagates $name database failures', async ({ run }) => {
    const failure = new Error('indexeddb unavailable')
    const ops = createBibleFolderDB(vi.fn().mockRejectedValue(failure), ROOT_ID)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(run(ops)).rejects.toBe(failure)

    consoleError.mockRestore()
  })

  it('propagates real database write failure', async () => {
    const db = await openBibleDB()
    const failure = new Error('quota exceeded')
    vi.spyOn(db, 'put').mockRejectedValueOnce(failure)
    await expect(createBibleFolderDB(openBibleDB, ROOT_ID).saveItem(makeItem())).rejects.toBe(
      failure
    )
  })

  it('uses a full scan for Bible trash without a deleted-at index', async () => {
    const db = await openBibleDB()
    await db.put('folder-items', makeItem({ id: 'expired', deletedAt: 1 }))
    await db.put('folder-items', makeItem({ id: 'alive' }))
    const ops = createBibleFolderDB(openBibleDB, ROOT_ID)
    await expect(ops.purgeTrashOlderThan(10_000, 1_000)).resolves.toEqual({
      folderIds: [],
      itemIds: ['expired']
    })
    expect(await db.get('folder-items', 'expired')).toBeUndefined()
    expect(await db.get('folder-items', 'alive')).toBeDefined()
  })

  it('propagates full-scan failure', async () => {
    const db = await openBibleDB()
    const failure = new Error('full scan failed')
    vi.spyOn(db, 'getAll').mockResolvedValueOnce([]).mockRejectedValueOnce(failure)
    await expect(
      createBibleFolderDB(openBibleDB, ROOT_ID).purgeTrashOlderThan(10_000, 1_000)
    ).rejects.toBe(failure)
  })
})

describe('concrete folder persistence adapters', () => {
  it('expires standalone items only at the root', async () => {
    const db = await openBibleDB()
    const ops = createBibleFolderDB(openBibleDB, ROOT_ID)
    await ops.saveItems([
      makeItem({ id: 'expired', expiresAt: 1 }),
      makeItem({ id: 'valid', expiresAt: 20_000 }),
      makeItem({ id: 'nested', parentId: 'child', expiresAt: 1 })
    ])
    expect((await ops.deleteExpired!(10_000)).itemIds).toEqual(['expired'])
    expect(await db.get('folder-items', 'nested')).toBeDefined()
    expect((await ops.deleteExpired!(10_000)).itemIds).toEqual([])
  })

  it('rejects an aborted batch transaction without partial commits', async () => {
    const db = await openBibleDB()
    const transaction = IDBDatabase.prototype.transaction
    const abort = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase['transaction']>
    ) {
      const tx = transaction.apply(this, args)
      queueMicrotask(() => tx.abort())
      return tx
    })
    try {
      await expect(
        createBibleFolderDB().saveFolders([makeFolder({ id: 'one' }), makeFolder({ id: 'two' })])
      ).rejects.toThrow()
    } finally {
      abort.mockRestore()
    }
    expect(await db.getAll('folder-records')).toEqual([])
  })

  it('keeps Bible writes in Bible DB and Explorer writes in its catalog', async () => {
    const bible = createBibleFolderDB()
    const explorer = createFileExplorerFolderDB()
    await bible.saveFolder(makeFolder({ id: 'bible-only', parentId: 'bible-root' }))
    await explorer.saveFolder(makeFolder({ id: 'file-only', parentId: 'file-root' }))
    const bibleDB = await openBibleDB()
    const fileDB = await openFileExplorerDB()
    expect(await bibleDB.get('folder-records', 'bible-only')).toBeDefined()
    expect(await bibleDB.get('folder-records', 'file-only')).toBeUndefined()
    expect(await fileDB.get('folder-records', 'file-only')).toBeDefined()
    expect(await fileDB.get('folder-records', 'bible-only')).toBeUndefined()
  })

  it('retains Explorer tombstone-aware writes across single and batch saves', async () => {
    const db = await openFileExplorerDB()
    const ops = createFileExplorerFolderDB()
    await db.put('catalog-deletions', { id: 'deleted', deletedAt: 1 })
    await ops.saveFolder(makeFolder({ id: 'deleted', parentId: 'file-root' }))
    await ops.saveItems([makeItem({ id: 'child', parentId: 'deleted' })])
    expect(await db.get('folder-records', 'deleted')).toBeUndefined()
    expect(await db.get('folder-items', 'child')).toBeUndefined()
  })

  it('retains Explorer trash index boundary and child cleanup', async () => {
    const db = await openFileExplorerDB()
    const ops = createFileExplorerFolderDB()
    await db.put('folder-records', makeFolder({ id: 'trash', deletedAt: 1 }))
    await db.put('folder-items', makeItem({ id: 'child', parentId: 'trash' }))
    await db.put('folder-items', makeItem({ id: 'boundary', deletedAt: 9_000 }))
    expect(await ops.purgeTrashOlderThan(10_000, 1_000)).toEqual({
      folderIds: ['trash'],
      itemIds: ['boundary']
    })
    expect(await db.getAll('folder-items')).toEqual([])
    expect(await db.get('folder-records', 'trash')).toBeUndefined()
  })

  it('falls back to Explorer full scan if the trash index read fails', async () => {
    const db = await openFileExplorerDB()
    await db.put('folder-items', makeItem({ id: 'expired', deletedAt: 1 }))
    vi.spyOn(db, 'getAllFromIndex').mockRejectedValueOnce(new Error('index unavailable'))
    expect(await createFileExplorerFolderDB().purgeTrashOlderThan(10_000, 1_000)).toEqual({
      folderIds: [],
      itemIds: ['expired']
    })
  })
})
