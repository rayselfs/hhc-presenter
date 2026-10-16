import { beforeEach, expect, it, vi } from 'vitest'
import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import { copyExplorerFolder, useFileExplorerStore } from '../../stores/file-explorer'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'

const folder = (id: string, parentId: string, expiresAt: number | null = null): FolderRecord => ({
  id,
  parentId,
  name: id,
  sortIndex: 0,
  createdAt: 1,
  expiresAt
})

beforeEach(async () => {
  await useFileExplorerStore.getState().flushPersistence()
  await resetFileExplorerDBForTests()
  const db = await openFileExplorerDB()
  await db.put('folder-records', folder('A', 'file-root', 1000))
  await db.put('folder-records', folder('B', 'A', 2000))
  await db.put('folder-records', { ...folder('trash', 'A'), deletedAt: 1 })
  const item: FileItemRecord = {
    id: 'source-file',
    parentId: 'B',
    type: 'file',
    name: 'File',
    mimeType: 'text/plain',
    url: 'blob:source-file',
    size: 1,
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null
  }
  await db.put('folder-items', item)
  await db.put('file-blobs', { id: item.id, blob: new Blob(['A']), refCount: 1 })
  useFileExplorerStore.setState({ isInitialized: false })
  await useFileExplorerStore.getState().initialize()
})

it.each(['A', 'B'])('rejects a copy into %s before writing any records', async (target) => {
  const db = await openFileExplorerDB()
  const folders = await db.getAll('folder-records')
  const items = await db.getAll('folder-items')
  await expect(copyExplorerFolder('A', target)).rejects.toThrow('itself')
  await useFileExplorerStore.getState().flushPersistence()
  expect(await db.getAll('folder-records')).toEqual(folders)
  expect(await db.getAll('folder-items')).toEqual(items)
  expect((await db.get('file-blobs', 'source-file'))?.refCount).toBe(1)
})

it('preserves the chosen root name, subtree expiry and lazily loaded files', async () => {
  expect(useFileExplorerStore.getState().loadedParents.has('B')).toBe(false)
  const id = await copyExplorerFolder('A', 'file-root', { name: 'A (2)' })
  const db = await openFileExplorerDB()
  expect(await db.get('folder-records', id)).toMatchObject({ name: 'A (2)', expiresAt: 1000 })
  const copiedChildren = (await db.getAll('folder-records')).filter((node) => node.parentId === id)
  expect(copiedChildren).toHaveLength(1)
  expect(copiedChildren[0]).toMatchObject({ name: 'B', expiresAt: 2000 })
  const copiedItems = (await db.getAll('folder-items')).filter(
    (node) => node.parentId === copiedChildren[0].id
  )
  expect(copiedItems).toHaveLength(1)
  expect(copiedItems[0]).toMatchObject({ url: 'blob:source-file' })
  expect((await db.get('file-blobs', 'source-file'))?.refCount).toBe(2)
})

it('reports a failed file copy instead of reporting the partial folder as complete', async () => {
  const copy = vi.spyOn(useFileExplorerStore.getState(), 'copyItem').mockResolvedValue(null)
  try {
    await expect(copyExplorerFolder('A', 'file-root')).rejects.toThrow('File copy failed')
  } finally {
    copy.mockRestore()
  }
})

it('rejects an empty folder copy when the persistence queue cannot commit', async () => {
  const state = useFileExplorerStore.getState()
  const empty = state.addFolder('Empty', 'file-root')
  await state.flushPersistence()
  await state.ensureItemsLoaded(empty)
  const db = await openFileExplorerDB()
  const transaction = vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
    throw new Error('Disk unavailable')
  })
  try {
    await expect(copyExplorerFolder(empty, 'file-root')).rejects.toThrow('Disk unavailable')
  } finally {
    transaction.mockRestore()
    await useFileExplorerStore.getState().retryPersistence()
  }
})

it('backs up deleted personal subtrees with independent file bytes', async () => {
  const { Blob: NodeBlob, File: NodeFile } = await import('node:buffer')
  const { usePersonalSyncStore } = await import('../../stores/personal-sync')
  const { refreshPersonalCatalog } = await import('../../stores/file-explorer')
  const db = await openFileExplorerDB()
  const bytes = new NodeBlob(['Personal recovery bytes'])
  for (const id of ['A', 'B']) {
    const source = await db.get('folder-records', id)
    await db.put('folder-records', { ...source!, personalOwnerId: 'alice', deletedAt: 1 })
  }
  const source = await db.get('folder-items', 'source-file')
  await db.put('folder-items', { ...source!, personalOwnerId: 'alice', deletedAt: 1 })
  await db.put('file-blobs', { id: 'source-file', blob: bytes as Blob, refCount: 1 })
  usePersonalSyncStore.getState().setAccount('authenticated', 'alice', true)
  await refreshPersonalCatalog('alice')
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(await bytes.arrayBuffer()))
  )
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recovery-source')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  try {
    const id = await copyExplorerFolder('A', 'file-root', { includeDeleted: true })
    const copy = await db.get('folder-records', id)
    expect(copy?.personalOwnerId).toBeUndefined()
    expect(copy?.deletedAt).toBeUndefined()
    const child = (await db.getAll('folder-records')).find(
      (node) => node.parentId === id && node.name === 'B'
    )!
    const file = (await db.getAll('folder-items')).find(
      (node) => node.parentId === child.id
    ) as FileItemRecord
    expect(file.deletedAt).toBeUndefined()
    expect(file.url).not.toBe('blob:source-file')
    expect(await (await db.get('file-blobs', file.url.slice(5)))?.blob?.text()).toBe(
      'Personal recovery bytes'
    )
  } finally {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    usePersonalSyncStore.getState().setAccount('anonymous')
  }
})
