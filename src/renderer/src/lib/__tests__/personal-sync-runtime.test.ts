import { beforeEach, expect, it, vi } from 'vitest'
import { PersonalCloudHttpError, type PersonalUploadState } from '@shared/personal-cloud'
import type { PersonalCloudProvider } from '../personal-cloud-provider'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import {
  acquirePersonalSyncLease,
  commitPersonalLocalMutation,
  listPersonalOutbox
} from '../personal-sync-db'
import { advancePersonalOutbox, startPersonalSync } from '../personal-sync-runtime'
import { releasePersonalSyncLease } from '../personal-sync-db'
import { pullPersonalChanges } from '../personal-sync-pull'
import { usePersonalSyncStore } from '../../stores/personal-sync'
import {
  preservePersonalContentConflict,
  getPersonalConflictScope,
  acceptPersonalCloudVersion
} from '../personal-sync-conflicts'

vi.mock('../personal-cloud-provider', () => ({ createPersonalCloudProvider: () => api }))

const upload: PersonalUploadState = {
  id: 'upload',
  contentPath: '/unused',
  expiresAt: '2099-01-01T00:00:00Z',
  uploadStatus: 'completed',
  scanStatus: 'clean',
  processingStatus: 'not_required'
}
const api = {
  ensureSpace: vi.fn(),
  getUsage: vi.fn(),
  getChanges: vi.fn(),
  createUpload: vi.fn(),
  getUpload: vi.fn(),
  uploadSnapshot: vi.fn(),
  completeUpload: vi.fn(),
  mutate: vi.fn(),
  purgeTrash: vi.fn(),
  downloadSnapshot: vi.fn()
} satisfies PersonalCloudProvider
const run = (): ReturnType<typeof advancePersonalOutbox> =>
  advancePersonalOutbox('alice', 'worker', api, new AbortController().signal)

beforeEach(async () => {
  vi.resetAllMocks()
  await resetFileExplorerDBForTests()
  const db = await openFileExplorerDB()
  await db.put('personal-sync-state', {
    ownerId: 'alice',
    collectionId: 'space',
    rootId: 'root',
    collectionRevision: 0,
    sequence: 0
  })
  await commitPersonalLocalMutation({
    ownerId: 'alice',
    nodeId: 'file',
    remoteId: 'remote',
    operationId: 'operation',
    localRevision: 1,
    catalog: {
      id: 'file',
      parentId: 'root',
      type: 'file',
      name: 'image.png',
      mimeType: 'image/png',
      size: 3,
      url: 'blob:snapshot',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null
    },
    mutation: { type: 'create-file', parentId: '', name: 'image.png' },
    snapshot: { id: 'snapshot', blob: new Blob(['one']), size: 3 }
  })
  await acquirePersonalSyncLease('alice', 'worker')
  api.createUpload.mockResolvedValue(upload)
  api.getUpload.mockResolvedValue(upload)
  api.mutate.mockResolvedValue({ itemId: 'remote', nodeRevision: 1, collectionRevision: 1 })
})

it('replays the exact submitted body after a lost mutation response, without a new upload', async () => {
  api.mutate.mockRejectedValueOnce(new TypeError('Connection lost'))
  await expect(run()).rejects.toThrow('Connection lost')
  const pending = (await listPersonalOutbox('alice'))[0]
  expect(pending.submittedRequest?.uploadId).toBe('upload')
  api.getUpload.mockRejectedValue(new PersonalCloudHttpError(404, 'expired'))
  expect(await run()).toBe('acknowledged')
  expect(api.mutate.mock.calls[1][0]).toEqual(api.mutate.mock.calls[0][0])
  expect(api.createUpload).toHaveBeenCalledTimes(1)
  expect(api.getUpload).not.toHaveBeenCalled()
  expect(await listPersonalOutbox('alice')).toEqual([])
})

it('keeps the local snapshot and durable outbox when quota is exceeded', async () => {
  api.mutate.mockRejectedValue(
    new PersonalCloudHttpError(409, 'quota-exceeded', 0, {
      usedBytes: 90,
      quotaBytes: 100,
      requiredBytes: 20
    })
  )
  expect(await run()).toBe('blocked')
  expect((await listPersonalOutbox('alice'))[0]).toMatchObject({
    failure: 'quota-exceeded',
    failureData: { usedBytes: 90, quotaBytes: 100, requiredBytes: 20 }
  })
  expect(await getPersonalConflictScope('alice')).toBeNull()
  expect(await (await openFileExplorerDB()).get('file-blobs', 'snapshot')).toBeDefined()
})

it('reuses the acknowledged local content instead of downloading its own upload again', async () => {
  await run()
  api.getChanges.mockResolvedValue({
    collection: { id: 'space', revision: 1 },
    items: [
      {
        id: 'remote',
        collectionId: 'space',
        kind: 'file',
        name: 'image.png',
        assetId: 'new-asset',
        revision: 1
      }
    ],
    nextCursor: 'cursor',
    hasMore: false,
    reset: true
  })
  await pullPersonalChanges('alice', 'worker', api, new AbortController().signal)
  expect(api.downloadSnapshot).not.toHaveBeenCalled()
  expect(await (await openFileExplorerDB()).get('folder-items', 'file')).toMatchObject({
    url: 'blob:snapshot'
  })
})

it('waits for scanning and preserves immutable bytes on a rate limit', async () => {
  api.createUpload.mockResolvedValue({ ...upload, scanStatus: 'pending' })
  expect(await run()).toBe('scanning')
  expect(api.mutate).not.toHaveBeenCalled()
  api.getUpload.mockRejectedValue(new PersonalCloudHttpError(429, 'rate-limit', 10000))
  await expect(run()).rejects.toMatchObject({ retryAfterMs: 10000 })
  expect(await listPersonalOutbox('alice')).toHaveLength(1)
  expect(await (await openFileExplorerDB()).get('file-blobs', 'snapshot')).toMatchObject({
    refCount: 2
  })
})

it('starts a new upload attempt only before a mutation has been submitted', async () => {
  api.createUpload.mockResolvedValueOnce({ ...upload, expiresAt: '2000-01-01T00:00:00Z' })
  expect(await run()).toBe('scanning')
  expect((await listPersonalOutbox('alice'))[0]).toMatchObject({ uploadAttempt: 1 })
  expect(await run()).toBe('acknowledged')
  expect(api.createUpload.mock.calls.map((call) => call[1])).toEqual([
    'operation-upload-0',
    'operation-upload-1'
  ])
})

it('retains conflicting content and stops retrying the destructive operation', async () => {
  api.mutate.mockRejectedValue(new PersonalCloudHttpError(409, 'AST_CONFLICT'))
  expect(await run()).toBe('blocked')
  expect(await run()).toBe('blocked')
  expect(api.mutate).toHaveBeenCalledTimes(1)
  expect((await listPersonalOutbox('alice'))[0]).toMatchObject({
    failure: 'conflict',
    snapshotBlobId: 'snapshot'
  })
})

it('preserves conflicting bytes as one queued copy and keeps the editor item identity', async () => {
  api.mutate.mockRejectedValue(new PersonalCloudHttpError(409, 'AST_CONFLICT'))
  await run()
  expect(
    await preservePersonalContentConflict('alice', 'worker', new AbortController().signal)
  ).toBe(true)
  const db = await openFileExplorerDB()
  const pending = await listPersonalOutbox('alice')
  expect(pending).toHaveLength(1)
  expect(pending[0]).toMatchObject({
    nodeId: 'file',
    sequence: 1,
    snapshotBlobId: 'snapshot',
    expectedRevision: 0,
    mutation: { type: 'create-file' }
  })
  expect(pending[0].remoteId).not.toBe('remote')
  expect(await db.get('folder-items', 'file')).toMatchObject({
    name: expect.stringContaining('conflict')
  })
  expect(await db.get('file-blobs', 'snapshot')).toMatchObject({ refCount: 2 })
  expect(
    await preservePersonalContentConflict('alice', 'worker', new AbortController().signal)
  ).toBe(false)
})

it('reserves a separate local mapping for the cloud original and rejects stale workers', async () => {
  const db = await openFileExplorerDB()
  const node = await db.get('personal-sync-nodes', 'file')
  if (!node) throw new Error('Missing test node')
  await db.put('personal-sync-nodes', { ...node, remoteRevision: 1 })
  api.mutate.mockRejectedValue(new PersonalCloudHttpError(409, 'AST_CONFLICT'))
  await run()
  await expect(
    preservePersonalContentConflict('alice', 'other-worker', new AbortController().signal)
  ).rejects.toThrow()
  expect((await listPersonalOutbox('alice'))[0].id).toBe('operation')
  await preservePersonalContentConflict('alice', 'worker', new AbortController().signal)
  const nodes = await db.getAll('personal-sync-nodes')
  expect(nodes).toHaveLength(2)
  expect(nodes.find((entry) => entry.remoteId === 'remote')).toMatchObject({
    id: expect.not.stringMatching(/^file$/),
    localRevision: 0,
    remoteRevision: 0
  })
})

it('rejects a stale conflict choice, then atomically resets only the reviewed nodes', async () => {
  api.mutate.mockRejectedValue(new PersonalCloudHttpError(409, 'AST_CONFLICT'))
  await run()
  const scope = await getPersonalConflictScope('alice')
  if (!scope) throw new Error('Missing test conflict')
  const db = await openFileExplorerDB()
  const node = scope.nodes[0]
  await db.put('personal-sync-nodes', { ...node, localRevision: node.localRevision + 1 })
  await expect(
    acceptPersonalCloudVersion('alice', 'worker', scope, new AbortController().signal)
  ).rejects.toThrow('conflict changed')
  expect(await listPersonalOutbox('alice')).toHaveLength(1)
  expect(await db.get('file-blobs', 'snapshot')).toMatchObject({ refCount: 2 })
  const current = await getPersonalConflictScope('alice')
  if (!current) throw new Error('Missing current conflict')
  await acceptPersonalCloudVersion('alice', 'worker', current, new AbortController().signal)
  expect(await listPersonalOutbox('alice')).toEqual([])
  expect(await db.get('folder-items', 'file')).toBeUndefined()
  expect(await db.get('personal-sync-nodes', 'file')).toMatchObject({
    remoteId: 'remote',
    localRevision: 0
  })
  expect(await db.get('file-blobs', 'snapshot')).toMatchObject({ refCount: 0 })
})

it('aborts the account worker and fences a successful mutation arriving after stop', async () => {
  usePersonalSyncStore.getState().setAccount('authenticated', 'alice', true)
  await releasePersonalSyncLease('alice', 'worker')
  let receivedSignal: AbortSignal | undefined
  let finish: (() => void) | undefined
  api.mutate.mockImplementation((_request, signal: AbortSignal) => {
    receivedSignal = signal
    return new Promise((resolve) => {
      finish = () => resolve({ itemId: 'remote', nodeRevision: 1, collectionRevision: 1 })
    })
  })
  const stop = startPersonalSync('alice', {
    getSession: async () => ({ userId: 'alice', displayName: 'Alice', roles: [] }),
    getAccessToken: async () => 'token',
    refreshAccessToken: async () => 'token'
  })
  try {
    await vi.waitFor(() => expect(finish).toBeDefined())
    stop()
    finish?.()
    expect(receivedSignal?.aborted).toBe(true)
    await vi.waitFor(async () =>
      expect(
        (await (await openFileExplorerDB()).get('personal-sync-state', 'alice'))?.lease
      ).toBeUndefined()
    )
    expect(await listPersonalOutbox('alice')).toHaveLength(1)
  } finally {
    stop()
    usePersonalSyncStore.getState().setAccount('anonymous')
  }
})

it('verifies existing immutable staging after losing the PUT response', async () => {
  api.createUpload.mockResolvedValue({ ...upload, uploadStatus: 'created' })
  api.getUpload.mockResolvedValue({ ...upload, uploadStatus: 'created' })
  api.uploadSnapshot.mockRejectedValueOnce(new TypeError('Response lost'))
  api.uploadSnapshot.mockRejectedValueOnce(new PersonalCloudHttpError(409, 'AST_CONFLICT'))
  api.completeUpload.mockResolvedValue(upload)
  await expect(run()).rejects.toThrow('Response lost')
  expect(await run()).toBe('acknowledged')
  expect(api.completeUpload).toHaveBeenCalledWith(
    'upload',
    { mimeType: 'image/png', sizeBytes: 3, blobId: 'snapshot' },
    expect.any(AbortSignal)
  )
  expect(api.createUpload).toHaveBeenCalledTimes(1)
  expect(await listPersonalOutbox('alice')).toEqual([])
})
