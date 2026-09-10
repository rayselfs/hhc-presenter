import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { deleteDB } from 'idb'
import { PersonalShareProvider, personalShareRemoteId } from '../personal-share-provider'
import { assertProviderDoesNotExposeWriteOperations } from '../sync-provider'

const root = {
  grantId: 'grant-a',
  ownerUserId: 'owner-a',
  collectionRevision: 4,
  root: {
    id: 'folder',
    collectionId: 'collection',
    kind: 'folder' as const,
    name: 'Shared',
    revision: 4
  }
}

describe('PersonalShareProvider', () => {
  beforeEach(async () => deleteDB('hhc-sync'))

  it('namespaces nodes by grant and exposes no writes', () => {
    expect(personalShareRemoteId('grant-a', 'item')).not.toBe(
      personalShareRemoteId('grant-b', 'item')
    )
    const provider = new PersonalShareProvider({
      api: {} as never,
      getSession: () => ({ userId: 'recipient', displayName: 'Recipient' }) as never
    })
    expect(() => assertProviderDoesNotExposeWriteOperations(provider)).not.toThrow()
  })

  it('pages a reset snapshot then keeps an unchanged revision idle', async () => {
    const api = {
      listSharedFolders: async () => [root],
      getSharedFolderSnapshot: async (_grant: string, cursor?: string) => ({
        grantId: 'grant-a',
        collectionRevision: 4,
        reset: true,
        items: cursor
          ? [
              {
                ...root.root,
                id: 'file',
                parentId: 'folder',
                kind: 'file' as const,
                name: 'photo.jpg',
                mimeType: 'image/jpeg',
                sizeBytes: 12,
                etag: 'etag'
              }
            ]
          : [root.root],
        nextCursor: cursor ? '' : 'server-page-2',
        hasMore: !cursor
      })
    }
    const provider = new PersonalShareProvider({
      api: api as never,
      getSession: () => ({ userId: 'recipient', displayName: 'Recipient' }) as never
    })
    const remoteRoot = personalShareRemoteId('grant-a', 'folder')
    const first = await provider.initialScan('hhc-share:recipient', remoteRoot)
    expect(first.reset).toBe(true)
    const second = await provider.incrementalChanges({
      providerConnectionId: 'hhc-share:recipient',
      remoteFolderId: remoteRoot,
      cursor: first.nextCursor!
    })
    expect(second.items[0]).toMatchObject({
      remoteItemId: personalShareRemoteId('grant-a', 'file'),
      mimeType: 'image/jpeg',
      size: 12
    })
    const handoff = await provider.incrementalChanges({
      providerConnectionId: 'hhc-share:recipient',
      remoteFolderId: remoteRoot,
      cursor: second.nextCursor!
    })
    expect(handoff).toMatchObject({ items: [], hasMore: false, reset: false })
    const idle = await provider.incrementalChanges({
      providerConnectionId: 'hhc-share:recipient',
      remoteFolderId: remoteRoot,
      cursor: handoff.nextCursor!
    })
    expect(idle).toMatchObject({ items: [], hasMore: false, reset: false })
  })

  it('uses the grant-scoped content endpoint and fences account changes', async () => {
    let userId = 'recipient'
    let downloaded = ''
    const provider = new PersonalShareProvider({
      api: {
        listSharedFolders: async () => [root],
        getSharedFolderSnapshot: async () => ({
          grantId: 'grant-a',
          collectionRevision: 4,
          reset: true,
          items: [
            root.root,
            {
              ...root.root,
              id: 'file',
              parentId: 'folder',
              kind: 'file' as const,
              name: 'photo.jpg',
              mimeType: 'image/jpeg',
              sizeBytes: 1
            }
          ],
          nextCursor: '',
          hasMore: false
        }),
        downloadSharedContent: async (grant: string, item: string) => {
          downloaded = `${grant}/${item}`
          return new Response('x', { headers: { 'content-type': 'image/jpeg' } })
        }
      } as never,
      getSession: () => ({ userId, displayName: 'Recipient' }) as never,
      saveDownloadedContent: async (request, _response, _metadata, canCommit) => {
        expect(await canCommit()).toBe(true)
        return { blobId: request.targetBlobId, size: 1, mimeType: 'image/jpeg' }
      }
    })
    await provider.initialScan('hhc-share:recipient', personalShareRemoteId('grant-a', 'folder'))
    await provider.downloadContent(
      {
        providerConnectionId: 'hhc-share:recipient',
        rootRemoteFolderId: personalShareRemoteId('grant-a', 'folder'),
        remoteItemId: personalShareRemoteId('grant-a', 'file'),
        targetBlobId: crypto.randomUUID(),
        offlinePolicy: 'on-demand'
      },
      new AbortController().signal,
      () => true
    )
    expect(downloaded).toBe('grant-a/file')
    userId = 'other'
    await expect(
      provider.initialScan('hhc-share:recipient', personalShareRemoteId('grant-a', 'folder'))
    ).rejects.toMatchObject({ classification: 'auth-required' })
  })

  it('starts a fresh reset when the shared collection revision changes', async () => {
    let revision = 4
    const api = {
      listSharedFolders: async () => [{ ...root, collectionRevision: revision }],
      getSharedFolderSnapshot: async () => ({
        grantId: 'grant-a',
        collectionRevision: revision,
        reset: true,
        items: [root.root],
        nextCursor: '',
        hasMore: false
      })
    }
    const provider = new PersonalShareProvider({
      api: api as never,
      getSession: () => ({ userId: 'recipient', displayName: 'Recipient' }) as never
    })
    revision = 5
    await expect(
      provider.incrementalChanges({
        providerConnectionId: 'hhc-share:recipient',
        remoteFolderId: personalShareRemoteId('grant-a', 'folder'),
        cursor: 'steady:4'
      })
    ).resolves.toMatchObject({ reset: true, nextCursor: 'steady:5' })
  })
})
