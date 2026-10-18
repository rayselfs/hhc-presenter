import { beforeEach, expect, it, vi } from 'vitest'
import { openBibleDB } from '../bible-db'
import { createBibleFolderDB } from '../folder-db'
import { createFolderStore } from '../../stores/folder'
import type { FolderRecord } from '@shared/types/folder'

const folder = (id: string, parentId: string | null, expiresAt: number | null): FolderRecord => ({
  id,
  parentId,
  expiresAt,
  name: id,
  sortIndex: 0,
  createdAt: 1
})

beforeEach(async () => {
  vi.restoreAllMocks()
  const db = await openBibleDB()
  await db.clear('folder-records')
  await db.clear('folder-items')
  await db.put('folder-records', folder('bible-root', null, null))
  await db.put('folder-records', folder('expired-parent', 'bible-root', 1))
  await db.put('folder-records', folder('permanent-child', 'expired-parent', null))
  await db.put('folder-items', {
    id: 'verse',
    parentId: 'permanent-child',
    type: 'verse',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    versionId: 1,
    bookNumber: 1,
    chapter: 1,
    verse: 1,
    text: 'Synthetic verse'
  })
})

it('rolls back the entire expired subtree when an item deletion aborts, then retries after restart', async () => {
  const db = await openBibleDB()
  const store = createFolderStore({
    rootId: 'bible-root',
    rootName: 'Bible',
    persistence: createBibleFolderDB()
  })
  await store.getState().initialize()
  const originalDelete = IDBObjectStore.prototype.delete
  const deletion = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (
    this: IDBObjectStore,
    key: IDBValidKey | IDBKeyRange
  ): IDBRequest<undefined> {
    const request = originalDelete.call(this, key)
    if (this.name === 'folder-items')
      request.addEventListener('success', () => this.transaction.abort(), { once: true })
    return request
  })
  await expect(store.getState().cleanupExpired()).rejects.toThrow()
  deletion.mockRestore()
  expect(await db.get('folder-records', 'expired-parent')).toBeDefined()
  expect(await db.get('folder-records', 'permanent-child')).toBeDefined()
  expect(await db.get('folder-items', 'verse')).toBeDefined()
  expect(store.getState().folders['expired-parent']).toBeDefined()
  const restarted = createFolderStore({
    rootId: 'bible-root',
    rootName: 'Bible',
    persistence: createBibleFolderDB()
  })
  await restarted.getState().initialize()
  await restarted.getState().cleanupExpired()
  expect((await db.getAll('folder-records')).map((entry) => entry.id)).toEqual(['bible-root'])
  expect(await db.getAll('folder-items')).toEqual([])
  expect(restarted.getState().getChildFolders('bible-root')).toEqual([])
})

it('uses persisted descendants even if they are absent from the in-memory folder map', async () => {
  const db = await openBibleDB()
  const store = createFolderStore({
    rootId: 'bible-root',
    rootName: 'Bible',
    persistence: createBibleFolderDB()
  })
  await store.getState().initialize()
  store.setState({ folders: { 'bible-root': store.getState().folders['bible-root'] } })
  await store.getState().cleanupExpired()
  expect((await db.getAll('folder-records')).map((entry) => entry.id)).toEqual(['bible-root'])
  expect(await db.getAll('folder-items')).toEqual([])
})

it('does not delete data before initialization succeeds', async () => {
  const db = await openBibleDB()
  const ops = createBibleFolderDB()
  vi.spyOn(ops, 'loadItemsByParent').mockRejectedValueOnce(new Error('Read unavailable'))
  const store = createFolderStore({ rootId: 'bible-root', rootName: 'Bible', persistence: ops })
  await store.getState().initialize()
  expect(store.getState().isInitialized).toBe(false)
  await store.getState().cleanupExpired()
  expect(await db.get('folder-records', 'expired-parent')).toBeDefined()
  expect(await db.get('folder-items', 'verse')).toBeDefined()
})

it('observes previously queued retention edits before deciding which subtree expires', async () => {
  const db = await openBibleDB()
  const store = createFolderStore({
    rootId: 'bible-root',
    rootName: 'Bible',
    persistence: createBibleFolderDB()
  })
  await store.getState().initialize()
  store.getState().updateFolder('expired-parent', { expiresAt: null })
  await store.getState().cleanupExpired()
  expect(await db.get('folder-records', 'expired-parent')).toMatchObject({ expiresAt: null })
  expect(await db.get('folder-items', 'verse')).toBeDefined()
})
