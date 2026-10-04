import { beforeEach, expect, it, vi } from 'vitest'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import {
  createPersonalFile,
  createPersonalFolder,
  ensurePersonalLocalSpace,
  mutatePersonalNode,
  purgePersonalTrash,
  togglePersonalFolderFavorite
} from '../personal-file-actions'
import { usePersonalSyncStore } from '../../stores/personal-sync'
import { createExplorerFolder, useFileExplorerStore } from '../../stores/file-explorer'
import { listPersonalOutbox } from '../personal-sync-db'

const cloud = vi.hoisted(() => ({ purgeTrash: vi.fn(), getUsage: vi.fn() }))
vi.mock('../personal-cloud-provider', () => ({
  createPersonalCloudProvider: () => ({
    purgeTrash: cloud.purgeTrash,
    getUsage: cloud.getUsage
  })
}))

beforeEach(async () => {
  cloud.purgeTrash.mockReset().mockResolvedValue({ purgedItemIds: [] })
  cloud.getUsage.mockReset().mockResolvedValue({
    activeBytes: 0,
    trashBytes: 0,
    protectedBytes: 0,
    usedBytes: 0,
    quotaBytes: 100 * 1024 ** 3,
    overrideBytes: null
  })
  usePersonalSyncStore.getState().setAccount('anonymous')
  await resetFileExplorerDBForTests()
  usePersonalSyncStore.getState().setAccount('authenticated', 'alice', true)
  await ensurePersonalLocalSpace(
    'alice',
    { id: 'space', revision: 100, usedBytes: 0, quotaBytes: 100 * 1024 ** 3 },
    new AbortController().signal
  )
})

it('maps local trash IDs and refreshes usage after an idempotent purge', async () => {
  const folder = await createPersonalFolder('Old', 'personal:space')
  const node = await (await openFileExplorerDB()).get('personal-sync-nodes', folder)
  await purgePersonalTrash(
    { key: folder, itemIds: [folder] },
    {
      getSession: async () => ({ userId: 'alice', displayName: 'Alice', roles: [] }),
      getAccessToken: async () => 'token',
      refreshAfterUnauthorized: async () => 'token'
    }
  )
  expect(cloud.purgeTrash).toHaveBeenCalledWith({
    operationId: expect.any(String),
    itemIds: [node?.remoteId]
  })
  expect(usePersonalSyncStore.getState().usage?.quotaBytes).toBe(100 * 1024 ** 3)
})

it('reuses the purge operation ID after an uncertain failure', async () => {
  const folder = await createPersonalFolder('Old', 'personal:space')
  cloud.purgeTrash.mockRejectedValueOnce(new TypeError('Response lost'))
  const auth = {
    getSession: async () => ({ userId: 'alice', displayName: 'Alice', roles: [] }),
    getAccessToken: async () => 'token',
    refreshAfterUnauthorized: async () => 'token'
  }
  await expect(purgePersonalTrash({ key: folder, itemIds: [folder] }, auth)).rejects.toThrow()
  await purgePersonalTrash({ key: folder, itemIds: [folder] }, auth)
  expect(cloud.purgeTrash.mock.calls[1][0].operationId).toBe(
    cloud.purgeTrash.mock.calls[0][0].operationId
  )
})

it('schedules reconciliation when purge succeeds but usage refresh fails', async () => {
  const folder = await createPersonalFolder('Old', 'personal:space')
  const sync = vi.fn()
  window.addEventListener('hhc:personal-sync', sync)
  cloud.getUsage.mockRejectedValueOnce(new TypeError('Usage unavailable'))

  await expect(
    purgePersonalTrash(
      { key: folder, itemIds: [folder] },
      {
        getSession: async () => ({ userId: 'alice', displayName: 'Alice', roles: [] }),
        getAccessToken: async () => 'token',
        refreshAfterUnauthorized: async () => 'token'
      }
    )
  ).resolves.toBeUndefined()
  expect(sync).toHaveBeenCalledOnce()

  window.removeEventListener('hhc:personal-sync', sync)
})

it('keeps local favorites separate from queued cloud metadata', async () => {
  const folder = await createPersonalFolder('Original', 'personal:space')
  await mutatePersonalNode(folder, { type: 'rename', name: 'Updated' })
  await togglePersonalFolderFavorite(folder)
  expect(await (await openFileExplorerDB()).get('folder-records', folder)).toMatchObject({
    name: 'Updated',
    isFavorited: true
  })
  expect(await listPersonalOutbox('alice')).toHaveLength(2)
})

it('creates nested folders durably and maps a local parent to its remote ID', async () => {
  const parent = await createPersonalFolder('Parent', 'personal:space')
  const child = await createPersonalFolder('Child', parent)
  const pending = await listPersonalOutbox('alice')
  expect(pending.map((entry) => entry.mutation)).toEqual([
    { type: 'create-folder', name: 'Parent', parentId: '' },
    { type: 'create-folder', name: 'Child', parentId: parent }
  ])
  await expect(mutatePersonalNode(parent, { type: 'move', parentId: child })).rejects.toThrow(
    'cycle'
  )
  expect(await listPersonalOutbox('alice')).toHaveLength(2)
})

it('retains offline edits and refuses another account mutation of the same local ID', async () => {
  const folder = await createPersonalFolder('Draft', 'personal:space')
  usePersonalSyncStore.getState().setAccount('unavailable')
  await mutatePersonalNode(folder, { type: 'rename', name: 'Offline' })
  usePersonalSyncStore.getState().setAccount('authenticated', 'bob', true)
  await expect(mutatePersonalNode(folder, { type: 'delete' })).rejects.toThrow('unavailable')
  expect(await (await openFileExplorerDB()).get('folder-records', folder)).toMatchObject({
    name: 'Offline'
  })
  expect(await listPersonalOutbox('alice')).toHaveLength(2)
})

it('routes public rename and delete actions through the outbox and blocks the legacy synchronous writer', async () => {
  const folder = await createExplorerFolder('Routed', 'personal:space')
  expect(useFileExplorerStore.getState().addFolder('Unsafe', 'personal:space')).toBe('')
  useFileExplorerStore.getState().updateFolder(folder, { name: 'Renamed' })
  await vi.waitFor(async () => expect(await listPersonalOutbox('alice')).toHaveLength(2))
  useFileExplorerStore.getState().softDeleteFolder(folder)
  await vi.waitFor(async () => expect(await listPersonalOutbox('alice')).toHaveLength(3))
  expect(await (await openFileExplorerDB()).get('folder-records', folder)).toMatchObject({
    name: 'Renamed',
    deletedAt: expect.any(Number)
  })
})

it('queues a chosen restore name in the same operation as restoring the folder', async () => {
  const folder = await createPersonalFolder('Sunday', 'personal:space')
  await mutatePersonalNode(folder, { type: 'delete' })
  await createPersonalFolder('Sunday', 'personal:space')
  await mutatePersonalNode(folder, { type: 'restore', name: 'Sunday restored' })
  expect((await listPersonalOutbox('alice')).at(-1)?.mutation).toEqual({
    type: 'restore',
    name: 'Sunday restored'
  })
  expect(await (await openFileExplorerDB()).get('folder-records', folder)).toMatchObject({
    name: 'Sunday restored',
    deletedAt: undefined
  })
})

it.each([
  ['vector.svg', 'image/svg+xml', 3],
  ['empty.png', 'image/png', 0],
  ['large.png', 'image/png', 200 * 1024 * 1024 + 1]
])(
  'rejects invalid personal imports through the non-picker entry point: %s',
  async (name, type, size) => {
    const file = new File(['one'], name, { type })
    Object.defineProperty(file, 'size', { value: size })
    await expect(createPersonalFile(file, 'personal:space')).rejects.toThrow()
    expect(await listPersonalOutbox('alice')).toEqual([])
    expect(await (await openFileExplorerDB()).getAll('file-blobs')).toEqual([])
  }
)

it('preserves the source bytes under a different immutable blob ID', async () => {
  const id = await createPersonalFile(
    new File(['one'], 'image.png', { type: 'image/png' }),
    'personal:space'
  )
  const db = await openFileExplorerDB()
  const item = await db.get('folder-items', id)
  if (item?.type !== 'file') throw new Error('Missing file')
  const blobId = item.url.slice(5)
  expect(blobId).not.toBe(id)
  expect((await listPersonalOutbox('alice'))[0].snapshotBlobId).toBe(blobId)
  expect(await db.get('file-blobs', blobId)).toMatchObject({ refCount: 2, size: 3 })
})
