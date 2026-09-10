import { expect, it, vi } from 'vitest'
import {
  createPersonalCloudHttpApi,
  PersonalCloudHttpError,
  requirePersonalUsage
} from '../personal-cloud'

it('validates integer quota usage and purge responses', async () => {
  expect(
    requirePersonalUsage({
      activeBytes: 1,
      trashBytes: 2,
      protectedBytes: 3,
      usedBytes: 6,
      quotaBytes: 100 * 1024 ** 3,
      overrideBytes: null
    })
  ).toMatchObject({ usedBytes: 6, quotaBytes: 100 * 1024 ** 3 })
  expect(() =>
    requirePersonalUsage({
      activeBytes: 1,
      trashBytes: 2.5,
      protectedBytes: 3,
      usedBytes: 6,
      quotaBytes: 100,
      overrideBytes: null
    })
  ).toThrow(PersonalCloudHttpError)

  const send = vi.fn().mockResolvedValue(Response.json({ purgedItemIds: ['item'] }))
  const result = await createPersonalCloudHttpApi(send).purgeTrash({
    operationId: 'operation',
    itemIds: ['item']
  })
  expect(result).toEqual({ purgedItemIds: ['item'] })
  expect(send).toHaveBeenCalledWith(
    '/api/assets/personal-space/trash/purge',
    expect.objectContaining({
      body: JSON.stringify({ operationId: 'operation', itemIds: ['item'] })
    })
  )
})

it('scopes paths and forwards cancellation while validating changes', async () => {
  const send = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        collection: { id: 'collection', revision: 2 },
        items: [
          {
            id: 'node',
            collectionId: 'collection',
            kind: 'file',
            name: 'Image.png',
            revision: 2,
            assetId: 'asset'
          }
        ],
        nextCursor: 'cursor',
        hasMore: false,
        reset: true
      })
    )
  )
  const api = createPersonalCloudHttpApi(send)
  const controller = new AbortController()
  const page = await api.getChanges('old+cursor', controller.signal)
  expect(page.items[0]).toMatchObject({ name: 'Image.png', revision: 2 })
  expect(send).toHaveBeenCalledWith(
    '/api/assets/personal-space/changes?cursor=old%2Bcursor',
    expect.objectContaining({ signal: controller.signal })
  )
})

it('distinguishes a pending scan from a content conflict', async () => {
  const api = createPersonalCloudHttpApi(
    async () =>
      new Response(JSON.stringify({ error: { code: 'asset-not-ready' } }), { status: 409 })
  )
  await expect(api.ensureSpace()).rejects.toMatchObject({ status: 409, code: 'asset-not-ready' })
})

it('rejects malformed responses without trusting their collection or upload paths', async () => {
  const api = createPersonalCloudHttpApi(
    async () =>
      new Response(
        JSON.stringify({
          id: 'upload',
          contentPath: 'https://untrusted.example/upload',
          expiresAt: '2026-10-01T00:00:00Z',
          uploadStatus: 'created',
          scanStatus: 'pending',
          processingStatus: 'not_required'
        })
      )
  )
  await expect(
    api.createUpload({ fileName: 'image.png', mimeType: 'image/png', sizeBytes: 3 }, 'op')
  ).rejects.toThrow(PersonalCloudHttpError)
})

it('never sends another account credentials when the session changes during token refresh', async () => {
  const { createAuthenticatedPersonalCloudApi } = await import('../personal-cloud')
  let owner = 'alice'
  const auth = {
    getSession: async () => ({ userId: owner, displayName: owner, roles: [] }),
    getAccessToken: async () => 'first-token',
    refreshAccessToken: async () => {
      owner = 'bob'
      return 'other-token'
    }
  }
  const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
  const api = createAuthenticatedPersonalCloudApi(auth, 'alice', fetcher)
  await expect(api.ensureSpace()).rejects.toMatchObject({ status: 401, code: 'owner-changed' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
