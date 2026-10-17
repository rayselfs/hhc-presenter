import { beforeEach, expect, it, vi } from 'vitest'
import type { PersonalChangePage, PersonalRemoteNode } from '@shared/personal-cloud'
import type { PersonalCloudProvider } from '../personal-cloud-provider'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { acquirePersonalSyncLease, commitPersonalLocalMutation } from '../personal-sync-db'
import {
  acceptPersonalCloudVersion,
  getPersonalConflictScope,
  preservePersonalContentConflict
} from '../personal-sync-conflicts'
import {
  commitPersonalChangePage,
  personalLocalNodeId,
  pullPersonalChanges
} from '../personal-sync-pull'

vi.mock('../sync-media-preparation', () => ({ refreshImportedMediaAssets: vi.fn() }))

const signal = (): AbortSignal => new AbortController().signal
const localId = (id: string): string => personalLocalNodeId('space', id)
const remote = (
  id: string,
  kind: 'file' | 'folder' = 'file',
  parentId?: string
): PersonalRemoteNode => ({
  id,
  collectionId: 'space',
  kind,
  name: `${id}.png`,
  revision: 1,
  parentId,
  ...(kind === 'file' ? { assetId: `asset-${id}` } : {})
})
const purge = (node: PersonalRemoteNode): PersonalRemoteNode => ({
  ...node,
  revision: 2,
  assetId: undefined,
  deletedAt: '2026-10-16T00:00:00Z',
  purged: true
})
const page = (items: PersonalRemoteNode[], nextCursor = 'next'): PersonalChangePage => ({
  collection: { id: 'space', revision: 10 },
  items,
  nextCursor,
  hasMore: false,
  reset: false
})

async function seed(items: PersonalRemoteNode[]): Promise<void> {
  await commitPersonalChangePage(
    'alice',
    'worker',
    undefined,
    page(items),
    new Map(
      items
        .filter((node) => node.kind === 'file')
        .map((node) => [
          node.id,
          {
            id: `blob-${node.id}`,
            blob: new Blob([node.id]),
            size: node.id.length,
            mimeType: 'image/png'
          }
        ])
    ),
    signal()
  )
}

async function rename(id: string): Promise<void> {
  const db = await openFileExplorerDB()
  const catalog =
    (await db.get('folder-items', localId(id))) ?? (await db.get('folder-records', localId(id)))
  if (!catalog) throw new Error('Missing test catalog')
  await commitPersonalLocalMutation({
    ownerId: 'alice',
    nodeId: catalog.id,
    remoteId: id,
    operationId: `rename-${id}`,
    localRevision: 1,
    catalog: { ...catalog, name: `edited-${id}.png` },
    mutation: { type: 'rename', name: `edited-${id}.png` }
  })
}

beforeEach(async () => {
  await resetFileExplorerDBForTests()
  Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  const db = await openFileExplorerDB()
  await db.put('personal-sync-state', {
    ownerId: 'alice',
    collectionId: 'space',
    rootId: 'root',
    collectionRevision: 0,
    sequence: 0
  })
  await acquirePersonalSyncLease('alice', 'worker')
})

it('preserves a dirty file, bytes and outbox as a recoverable purge conflict', async () => {
  const file = remote('file')
  await seed([file])
  await rename('file')
  const db = await openFileExplorerDB()
  const before = await db.get('file-blobs', 'blob-file')
  await commitPersonalChangePage(
    'alice',
    'worker',
    'next',
    page([purge(file)], 'purged'),
    new Map(),
    signal()
  )
  expect(await db.get('folder-items', localId('file'))).toMatchObject({
    name: 'edited-file.png',
    url: 'blob:blob-file'
  })
  expect(await db.get('file-blobs', 'blob-file')).toEqual(before)
  expect(await db.get('personal-sync-nodes', localId('file'))).toMatchObject({
    localRevision: 1,
    syncedLocalRevision: 0,
    remoteRevision: 1,
    remoteHead: purge(file)
  })
  expect(await db.get('personal-sync-outbox', 'rename-file')).toMatchObject({ failure: 'conflict' })
  expect(await db.get('personal-sync-state', 'alice')).toMatchObject({ cursor: 'purged' })
  const scope = await getPersonalConflictScope('alice')
  expect(scope?.nodes.map((node) => node.id)).toEqual([localId('file')])
  if (!scope) throw new Error('Missing purge conflict')
  await acceptPersonalCloudVersion('alice', 'worker', scope, signal())
  await commitPersonalChangePage(
    'alice',
    'worker',
    undefined,
    page([purge(file)]),
    new Map(),
    signal()
  )
  expect(await db.get('folder-items', localId('file'))).toBeUndefined()
  expect(await db.get('personal-sync-nodes', localId('file'))).toBeUndefined()
  expect(await db.getAll('personal-sync-outbox')).toEqual([])
  expect(await db.get('file-blobs', 'blob-file')).toMatchObject({ refCount: 0 })
})

it('keeps a later dirty file when an unrelated outbox head is blocked', async () => {
  const files = [remote('blocked'), remote('later')]
  await seed(files)
  await rename('blocked')
  await rename('later')
  const db = await openFileExplorerDB()
  const first = await db.get('personal-sync-outbox', 'rename-blocked')
  if (!first) throw new Error('Missing operation')
  await db.put('personal-sync-outbox', { ...first, failure: 'quota-exceeded' })
  await commitPersonalChangePage(
    'alice',
    'worker',
    'next',
    page([purge(files[1])]),
    new Map(),
    signal()
  )
  expect(await db.get('folder-items', localId('later'))).toBeDefined()
  expect(await db.get('personal-sync-outbox', 'rename-later')).toMatchObject({
    failure: 'conflict'
  })
  expect(await db.get('personal-sync-outbox', first.id)).toEqual({
    ...first,
    failure: 'quota-exceeded'
  })
  expect(await db.get('file-blobs', 'blob-later')).toMatchObject({ refCount: 1 })
})

it.each([false, true])(
  'retains an entire purged folder containing a dirty descendant (children first: %s)',
  async (childrenFirst) => {
    const folder = remote('folder', 'folder')
    const nested = remote('nested', 'folder', 'folder')
    const dirty = remote('dirty', 'file', 'nested')
    const clean = remote('clean', 'file', 'nested')
    const unrelated = remote('unrelated')
    await seed([folder, nested, dirty, clean, unrelated])
    await rename('dirty')
    const purges = [folder, nested, dirty, clean].map(purge)
    await commitPersonalChangePage(
      'alice',
      'worker',
      'next',
      page([...(childrenFirst ? purges.reverse() : purges), purge(unrelated)]),
      new Map(),
      signal()
    )
    const db = await openFileExplorerDB()
    for (const id of ['folder', 'nested'])
      expect(await db.get('folder-records', localId(id))).toBeDefined()
    for (const id of ['dirty', 'clean']) {
      expect(await db.get('folder-items', localId(id))).toBeDefined()
      expect(await db.get('file-blobs', `blob-${id}`)).toMatchObject({ refCount: 1 })
    }
    expect(await db.get('folder-items', localId('unrelated'))).toBeUndefined()
    expect(await db.get('personal-sync-outbox', 'rename-dirty')).toMatchObject({
      failure: 'conflict'
    })
  }
)

it('retains children on later pages while a purged ancestor has unresolved work', async () => {
  const folder = remote('folder', 'folder')
  const child = remote('child', 'file', 'folder')
  await seed([folder, child])
  await rename('folder')
  await commitPersonalChangePage(
    'alice',
    'worker',
    'next',
    page([purge(folder)], 'folder-purge'),
    new Map(),
    signal()
  )
  await commitPersonalChangePage(
    'alice',
    'worker',
    'folder-purge',
    page([purge(child)]),
    new Map(),
    signal()
  )
  const db = await openFileExplorerDB()
  expect(await db.get('folder-items', localId('child'))).toBeDefined()
  expect(await db.get('file-blobs', 'blob-child')).toMatchObject({ refCount: 1 })
})

it.each(['node', 'subtree', 'parent'] as const)(
  'protects pending %s dependencies even when revisions match',
  async (dependency) => {
    const folder = remote('folder', 'folder')
    const child = remote('child', 'file', 'folder')
    await seed([folder, child, remote('outside')])
    const db = await openFileExplorerDB()
    await db.add('personal-sync-outbox', {
      id: 'pending',
      ownerId: 'alice',
      nodeId: localId(dependency === 'node' ? 'folder' : 'outside'),
      remoteId: dependency === 'node' ? 'folder' : 'outside',
      sequence: 1,
      localRevision: 0,
      expectedRevision: 1,
      expectedCollectionRevision: 1,
      createdAt: 1,
      mutation:
        dependency === 'parent'
          ? { type: 'move', parentId: 'folder' }
          : { type: 'rename', name: 'pending.png' },
      ...(dependency === 'subtree'
        ? { subtree: [{ nodeId: localId('folder'), localRevision: 0 }] }
        : {})
    })
    await commitPersonalChangePage(
      'alice',
      'worker',
      'next',
      page([purge(folder), purge(child)]),
      new Map(),
      signal()
    )
    expect(await db.get('folder-records', localId('folder'))).toBeDefined()
    expect(await db.get('folder-items', localId('child'))).toBeDefined()
    expect(await db.get('personal-sync-outbox', 'pending')).toMatchObject({ failure: 'conflict' })
  }
)

it('rechecks local revisions after a delayed getChanges response', async () => {
  const file = remote('file')
  await seed([file])
  let resolvePage!: (value: PersonalChangePage) => void
  const response = new Promise<PersonalChangePage>((resolve) => {
    resolvePage = resolve
  })
  const api = {
    getChanges: vi.fn(() => response),
    downloadSnapshot: vi.fn(),
    ensureSpace: vi.fn(),
    getUsage: vi.fn(),
    createUpload: vi.fn(),
    getUpload: vi.fn(),
    completeUpload: vi.fn(),
    mutate: vi.fn(),
    purgeTrash: vi.fn(),
    uploadSnapshot: vi.fn()
  } satisfies PersonalCloudProvider
  const pending = pullPersonalChanges('alice', 'worker', api, signal())
  await vi.waitFor(() => expect(api.getChanges).toHaveBeenCalled())
  await rename('file')
  resolvePage(page([purge(file)]))
  await pending
  const db = await openFileExplorerDB()
  expect(await db.get('folder-items', localId('file'))).toMatchObject({ name: 'edited-file.png' })
  expect(await db.get('personal-sync-outbox', 'rename-file')).toMatchObject({ failure: 'conflict' })
  expect(api.downloadSnapshot).not.toHaveBeenCalled()
})

it('preserves replacement snapshots through the existing automatic conflict-copy flow', async () => {
  const file = remote('file')
  await seed([file])
  const db = await openFileExplorerDB()
  const item = await db.get('folder-items', localId('file'))
  if (item?.type !== 'file') throw new Error('Missing test file')
  await commitPersonalLocalMutation({
    ownerId: 'alice',
    nodeId: item.id,
    remoteId: 'file',
    operationId: 'replace',
    localRevision: 1,
    catalog: { ...item, url: 'blob:replacement', size: 3 },
    mutation: { type: 'replace-content' },
    snapshot: { id: 'replacement', blob: new Blob(['new']), size: 3 }
  })
  await commitPersonalChangePage(
    'alice',
    'worker',
    'next',
    page([purge(file)]),
    new Map(),
    signal()
  )
  expect(await db.get('file-blobs', 'replacement')).toMatchObject({ refCount: 2 })
  expect(await preservePersonalContentConflict('alice', 'worker', signal())).toBe(true)
  expect(await db.get('folder-items', item.id)).toMatchObject({
    url: 'blob:replacement',
    name: expect.stringContaining('conflict')
  })
  expect(await db.get('file-blobs', 'replacement')).toMatchObject({ refCount: 2 })
  expect(await db.getAll('personal-sync-outbox')).toEqual([
    expect.objectContaining({
      nodeId: item.id,
      snapshotBlobId: 'replacement',
      mutation: expect.objectContaining({ type: 'create-file' })
    })
  ])
})

it('ignores a purge older than the acknowledged remote revision', async () => {
  const file = { ...remote('file'), revision: 5 }
  await seed([file])
  await commitPersonalChangePage(
    'alice',
    'worker',
    'next',
    page([purge(file)]),
    new Map(),
    signal()
  )
  const db = await openFileExplorerDB()
  expect(await db.get('folder-items', localId('file'))).toBeDefined()
  expect(await db.get('personal-sync-nodes', localId('file'))).toMatchObject({ remoteRevision: 5 })
  expect(await db.get('file-blobs', 'blob-file')).toMatchObject({ refCount: 1 })
})

it('does not create a conflict copy under a purged parent without deletedAt', async () => {
  const folder = remote('folder', 'folder')
  const file = remote('file', 'file', 'folder')
  await seed([folder, file])
  const db = await openFileExplorerDB()
  const item = await db.get('folder-items', localId('file'))
  if (item?.type !== 'file') throw new Error('Missing test file')
  await commitPersonalLocalMutation({
    ownerId: 'alice',
    nodeId: item.id,
    remoteId: 'file',
    operationId: 'replace',
    localRevision: 1,
    catalog: { ...item, url: 'blob:replacement', size: 3 },
    mutation: { type: 'replace-content' },
    snapshot: { id: 'replacement', blob: new Blob(['new']), size: 3 }
  })
  await commitPersonalChangePage(
    'alice',
    'worker',
    'next',
    page([folder, file].map((node) => ({ ...purge(node), deletedAt: undefined }))),
    new Map(),
    signal()
  )
  const before = await db.getAll('personal-sync-outbox')
  expect(before[0]).toMatchObject({ failure: 'conflict' })
  expect(await preservePersonalContentConflict('alice', 'worker', signal())).toBe(false)
  expect(await db.getAll('personal-sync-outbox')).toEqual(before)
  expect(await db.get('folder-items', item.id)).toEqual({
    ...item,
    url: 'blob:replacement',
    size: 3
  })
  expect(await db.get('file-blobs', 'replacement')).toMatchObject({ refCount: 2 })
})

it('rolls back conflict markers and the cursor if another change in the page fails', async () => {
  const file = remote('file')
  await seed([file])
  await rename('file')
  const db = await openFileExplorerDB()
  const before = await db.get('personal-sync-outbox', 'rename-file')
  await expect(
    commitPersonalChangePage(
      'alice',
      'worker',
      'next',
      page([purge(file), remote('missing-download')], 'failed-page'),
      new Map(),
      signal()
    )
  ).rejects.toThrow('download')
  expect(await db.get('personal-sync-outbox', 'rename-file')).toEqual(before)
  expect((await db.get('personal-sync-nodes', localId('file')))?.remoteHead).toBeUndefined()
  expect(await db.get('folder-items', localId('file'))).toBeDefined()
  expect(await db.get('file-blobs', 'blob-file')).toMatchObject({ refCount: 1 })
  expect(await db.get('personal-sync-state', 'alice')).toMatchObject({ cursor: 'next' })
})
