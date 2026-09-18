import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PersonalNativeRequest } from '@shared/personal-cloud'
import type { HhcAuthAdapter } from '@shared/hhc-auth'
import { createPersonalCloudProvider } from '../personal-cloud-provider'

const mocks = vi.hoisted(() => ({ electron: false, getBlob: vi.fn() }))
vi.mock('../env', () => ({ isElectron: () => mocks.electron }))
vi.mock('../file-explorer-db', () => ({ getFileBlobRecord: mocks.getBlob }))
const auth: HhcAuthAdapter = {
  getSession: async () => ({ userId: 'alice', displayName: 'Alice', roles: [] }),
  getAccessToken: async () => 'token',
  refreshAfterUnauthorized: async () => 'refreshed',
  signIn: async () => ({ expiresAt: 0 }),
  cancelSignIn: async () => undefined,
  signOut: async () => undefined,
  subscribe: () => () => undefined,
  dispose: () => undefined
}
const fetcher = vi.fn<typeof fetch>()
beforeEach(() => {
  mocks.electron = false
  mocks.getBlob.mockReset()
  fetcher.mockReset()
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

it('rejects truncated content without returning a publishable snapshot', async () => {
  fetcher.mockResolvedValue(new Response('short', { headers: { 'content-length': '20' } }))
  await expect(
    createPersonalCloudProvider(auth, 'alice').downloadSnapshot(
      'item',
      1,
      'blob',
      new AbortController().signal
    )
  ).rejects.toMatchObject({ code: 'incomplete-content' })
})

it('uploads exactly the immutable snapshot selected by the outbox', async () => {
  const blob = new Blob(['old revision'])
  mocks.getBlob.mockResolvedValue({ id: 'old-blob', blob })
  fetcher.mockResolvedValue(new Response(null, { status: 204 }))
  await createPersonalCloudProvider(auth, 'alice').uploadSnapshot(
    'upload',
    'old-blob',
    new AbortController().signal
  )
  expect(mocks.getBlob).toHaveBeenCalledWith('old-blob')
  expect(fetcher.mock.calls[0][1]?.body).toBe(blob)
})

it('cancels native work and rejects a late success after logout', async () => {
  mocks.electron = true
  const controller = new AbortController()
  const cancel = vi.fn(async () => undefined)
  const ensureSpace = vi.fn(async (_request: PersonalNativeRequest) => {
    controller.abort()
    return { ok: true, value: { id: 'space', revision: 0 } }
  })
  vi.stubGlobal('window', { api: { personalCloud: { ensureSpace, cancel } } })
  await expect(
    createPersonalCloudProvider(auth, 'alice').ensureSpace(controller.signal)
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(cancel).toHaveBeenCalledWith(ensureSpace.mock.calls[0]?.[0]?.requestId)
})

it('completes browser uploads using the original snapshot checksum', async () => {
  const { Blob } = await import('node:buffer')
  const { webcrypto } = await import('node:crypto')
  vi.stubGlobal('crypto', webcrypto)
  mocks.getBlob.mockResolvedValue({ id: 'snapshot', blob: new Blob(['one']) })
  fetcher.mockResolvedValue(
    Response.json({
      id: 'upload',
      contentPath: '/api/assets/personal-space/uploads/upload/content',
      expiresAt: '2030-01-01T00:00:00Z',
      uploadStatus: 'completed',
      scanStatus: 'pending',
      processingStatus: 'not_required'
    })
  )
  await createPersonalCloudProvider(auth, 'alice').completeUpload('upload', {
    blobId: 'snapshot',
    mimeType: 'image/png',
    sizeBytes: 3
  })
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
    mimeType: 'image/png',
    sizeBytes: 3,
    checksumSha256: '7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed'
  })
})
