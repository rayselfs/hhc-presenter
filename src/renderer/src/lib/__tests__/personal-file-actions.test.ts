import { beforeEach, expect, it, vi } from 'vitest'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import {
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
      refreshAccessToken: async () => 'token'
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
    refreshAccessToken: async () => 'token'
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
        refreshAccessToken: async () => 'token'
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
