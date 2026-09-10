import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WindowManager } from '../../windowManager'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  fetch: vi.fn(),
  root: '',
  main: { id: 1 }
}))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.root },
  BrowserWindow: { fromWebContents: () => mocks.main },
  ipcMain: {
    handle: (channel: string, action: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(channel, action)
  },
  net: { fetch: mocks.fetch }
}))
vi.mock('../../ipc/native-fs', () => ({
  getNativeFilePath: (id: string) => `${mocks.root}/${id}`,
  clearNativeMediaLeases: vi.fn(),
  registerNativeMediaLease: vi.fn(),
  releaseNativeMediaLease: vi.fn()
}))
vi.mock('../../ipc/video-remux', () => ({ mutateVideoSource: vi.fn() }))
import { registerPersonalCloudHandlers } from '../../ipc/personal-cloud'

const blobId = '123e4567-e89b-42d3-a456-426614174001'
const request = { ownerId: 'alice', requestId: '123e4567-e89b-42d3-a456-426614174002' }
let owner = 'alice'
function invoke(channel: string, input: unknown): Promise<unknown> {
  const handler = mocks.handlers.get(`personal-cloud:${channel}`)
  if (!handler) throw new Error('Handler missing')
  return handler({ sender: {} }, input)
}

beforeEach(async () => {
  mocks.root = await mkdtemp(join(tmpdir(), 'personal-cloud-test-'))
  mocks.fetch.mockReset()
  mocks.handlers.clear()
  owner = 'alice'
  registerPersonalCloudHandlers({ getMainWindow: () => mocks.main } as unknown as WindowManager, {
    getSession: async () => ({ userId: owner, displayName: owner, roles: [] }),
    getAccessToken: async () => 'token',
    refreshAccessToken: async () => 'refreshed',
    subscribe: () => () => undefined
  })
})
afterEach(async () => {
  await rm(mocks.root, { force: true, recursive: true })
})

it('rejects another account before sending an authenticated request', async () => {
  owner = 'bob'
  expect(await invoke('ensureSpace', request)).toMatchObject({ ok: false, status: 401 })
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it('rejects native path traversal before reading a source file', async () => {
  expect(
    await invoke('uploadSnapshot', { ...request, uploadId: 'upload', blobId: '../private' })
  ).toMatchObject({ ok: false, status: 400 })
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it('uploads a native snapshot as a disk-backed Blob', async () => {
  await writeFile(join(mocks.root, blobId), 'one')
  mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }))
  expect(await invoke('uploadSnapshot', { ...request, uploadId: 'upload', blobId })).toMatchObject({
    ok: true
  })
  const init = mocks.fetch.mock.calls[0][1] as RequestInit
  expect(await (init.body as Blob).text()).toBe('one')
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer token')
})

it('never overwrites an existing native destination when downloading', async () => {
  await writeFile(join(mocks.root, blobId), 'original')
  mocks.fetch.mockResolvedValue(
    new Response('new', { headers: { 'content-length': '3', 'content-type': 'image/png' } })
  )
  expect(
    await invoke('downloadSnapshot', { ...request, itemId: 'item', revision: 1, blobId })
  ).toMatchObject({ ok: false })
  expect(await readFile(join(mocks.root, blobId), 'utf8')).toBe('original')
})

it('accepts the dependent rename operation ID emitted by a deck save', async () => {
  mocks.fetch.mockResolvedValue(
    Response.json({
      itemId: 'item',
      nodeRevision: 2,
      collectionRevision: 2
    })
  )
  expect(
    await invoke('mutate', {
      ...request,
      mutation: {
        operationId: 'operation:rename',
        itemId: 'item',
        type: 'rename',
        name: 'Renamed',
        expectedRevision: 1
      }
    })
  ).toMatchObject({ ok: true })
})

it('returns usage, purges trash, and preserves structured quota errors', async () => {
  mocks.fetch
    .mockResolvedValueOnce(
      Response.json({
        activeBytes: 1,
        trashBytes: 2,
        protectedBytes: 3,
        usedBytes: 6,
        quotaBytes: 100,
        overrideBytes: null
      })
    )
    .mockResolvedValueOnce(Response.json({ purgedItemIds: ['item'] }))
    .mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: 'quota-exceeded',
            data: { usedBytes: 90, quotaBytes: 100, requiredBytes: 20 }
          }
        },
        { status: 409 }
      )
    )
  expect(await invoke('getUsage', request)).toMatchObject({ ok: true, value: { usedBytes: 6 } })
  expect(
    await invoke('purgeTrash', {
      ...request,
      purge: { operationId: 'operation', itemIds: ['item'] }
    })
  ).toMatchObject({ ok: true, value: { purgedItemIds: ['item'] } })
  expect(
    await invoke('mutate', {
      ...request,
      mutation: {
        operationId: 'operation',
        itemId: 'item',
        type: 'create-folder',
        name: 'Folder'
      }
    })
  ).toMatchObject({
    ok: false,
    code: 'quota-exceeded',
    data: { usedBytes: 90, quotaBytes: 100, requiredBytes: 20 }
  })
})

it('completes uploads with the SHA-256 of the immutable native snapshot', async () => {
  await writeFile(join(mocks.root, blobId), 'one')
  mocks.fetch.mockResolvedValue(
    Response.json({
      id: 'upload',
      contentPath: '/api/assets/personal-space/uploads/upload/content',
      expiresAt: '2030-01-01T00:00:00Z',
      uploadStatus: 'completed',
      scanStatus: 'pending',
      processingStatus: 'not_required'
    })
  )
  expect(
    await invoke('completeUpload', {
      ...request,
      uploadId: 'upload',
      upload: { blobId, mimeType: 'image/png', sizeBytes: 3 }
    })
  ).toMatchObject({ ok: true })
  const body = JSON.parse(mocks.fetch.mock.calls[0][1].body)
  expect(body.checksumSha256).toBe(
    '7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed'
  )
  expect(body).not.toHaveProperty('blobId')
})
