import { describe, expect, it, vi } from 'vitest'
import type { LocalSyncConnectionInfo, LocalSyncRemoteItem } from '@shared/ipc-channels'
import { buildLocalSyncImportPlan } from '@renderer/lib/local-sync-import'

const connection: LocalSyncConnectionInfo = {
  id: 'connection-1',
  displayName: 'Media',
  rootName: 'Media',
  createdAt: 100,
  updatedAt: 100
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

it.each([
  ['sermon.mkv', 'video/x-matroska', 'web', 'blob:'],
  ['legacy.avi', 'video/x-msvideo', 'web', 'unsupported:'],
  ['legacy.avi', 'video/x-msvideo', 'electron', 'blob:']
] as const)(
  'applies %s support policy in the actual %s import plan',
  (name, mimeType, platform, prefix) => {
    const plan = buildLocalSyncImportPlan({
      connection,
      platform,
      existingRootFolderNames: [],
      remoteItems: [{ remoteItemId: 'file', parentRemoteItemId: null, kind: 'file', name }]
    })
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]).toMatchObject({
      mimeType,
      url: expect.stringMatching(new RegExp(`^${prefix}`))
    })
    expect(plan.fileImports).toHaveLength(prefix === 'blob:' ? 1 : 0)
    expect(plan.syncEntries[1].status).toBe(
      prefix === 'blob:' ? 'available-offline' : 'remote-only'
    )
  }
)

describe('buildLocalSyncImportPlan', () => {
  it('creates read-only folders and disables unsupported synced files', () => {
    const remoteItems: LocalSyncRemoteItem[] = [
      {
        remoteItemId: 'folder-a',
        parentRemoteItemId: null,
        kind: 'folder',
        name: 'Sunday',
        sourceCreatedAt: 200
      },
      {
        remoteItemId: 'mkv-1',
        parentRemoteItemId: 'folder-a',
        kind: 'file',
        name: 'clip.mkv',
        size: 10,
        sourceCreatedAt: 300
      },
      {
        remoteItemId: 'avi-1',
        parentRemoteItemId: 'folder-a',
        kind: 'file',
        name: 'clip.avi',
        size: 20
      },
      {
        remoteItemId: 'psd-1',
        parentRemoteItemId: 'folder-a',
        kind: 'file',
        name: 'layout.psd',
        mimeType: 'image/vnd.adobe.photoshop',
        size: 20
      },
      {
        remoteItemId: 'system-file',
        parentRemoteItemId: 'folder-a',
        kind: 'file',
        name: '.DS_Store',
        size: 20
      }
    ]

    const plan = buildLocalSyncImportPlan({
      connection,
      remoteItems,
      platform: 'web',
      existingRootFolderNames: []
    })

    expect(plan.rootFolder.syncLink).toEqual({
      providerConnectionId: connection.id,
      remoteFolderId: '.',
      providerType: 'local-fs',
      offlinePolicy: 'always-offline'
    })
    expect(plan.folders).toHaveLength(2)
    expect(plan.rootFolder.createdAt).not.toBe(200)
    expect(plan.folders.find((folder) => folder.name === 'Sunday')?.createdAt).toBe(200)
    expect(plan.items).toHaveLength(2)
    expect(plan.items.find((item) => item.name === '.DS_Store')).toBeUndefined()
    expect(plan.items.find((item) => item.name === 'layout.psd')).toBeUndefined()
    expect(plan.fileImports.map((entry) => entry.remoteItemId)).toEqual(['mkv-1'])
    expect(plan.fileImports[0].itemId).toMatch(UUID_PATTERN)
    expect(plan.items.find((item) => item.name === 'clip.mkv')).toMatchObject({
      id: plan.fileImports[0].itemId,
      createdAt: 300,
      mimeType: 'video/x-matroska',
      url: expect.stringMatching(/^blob:/)
    })
    expect(plan.items.find((item) => item.name === 'clip.avi')).toMatchObject({
      mimeType: 'video/x-msvideo',
      url: expect.stringMatching(/^unsupported:/)
    })
    expect(plan.syncEntries.find((entry) => entry.remoteItemId === 'avi-1')).toMatchObject({
      status: 'remote-only'
    })
  })
})

it('preserves the complete local initial plan, source timestamps and offline receipts', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const uuid = vi
    .spyOn(crypto, 'randomUUID')
    .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
    .mockReturnValueOnce('00000000-0000-4000-8000-000000000002')
    .mockReturnValueOnce('00000000-0000-4000-8000-000000000003')
  try {
    const plan = buildLocalSyncImportPlan({
      connection: { ...connection, id: 'connection:/1' },
      existingRootFolderNames: ['Media', 'Media (1)'],
      platform: 'web',
      remoteItems: [
        {
          remoteItemId: 'sunday',
          parentRemoteItemId: null,
          kind: 'folder',
          name: 'Sunday',
          sourceCreatedAt: 200
        },
        { remoteItemId: 'nested', parentRemoteItemId: 'sunday', kind: 'folder', name: 'Nested' },
        { remoteItemId: 'orphan', parentRemoteItemId: 'missing', kind: 'folder', name: 'Orphan' },
        { remoteItemId: 'ignored', parentRemoteItemId: null, kind: 'folder', name: '__MACOSX' },
        {
          remoteItemId: 'ignored-child',
          parentRemoteItemId: 'ignored',
          kind: 'folder',
          name: 'Hidden'
        },
        {
          remoteItemId: 'image',
          parentRemoteItemId: 'nested',
          kind: 'file',
          name: 'cover.png',
          mimeType: 'image/png',
          size: 10,
          etag: 'image-v1',
          sourceCreatedAt: 300
        },
        {
          remoteItemId: 'unsupported',
          parentRemoteItemId: 'sunday',
          kind: 'file',
          name: 'clip.avi',
          size: 20,
          etag: 'video-v1'
        },
        {
          remoteItemId: 'orphan-file',
          parentRemoteItemId: 'missing',
          kind: 'file',
          name: 'outline.pdf'
        },
        { remoteItemId: 'skipped', parentRemoteItemId: null, kind: 'file', name: 'layout.psd' },
        {
          remoteItemId: 'ignored-file',
          parentRemoteItemId: 'ignored-child',
          kind: 'file',
          name: 'hidden.png'
        },
        {
          remoteItemId: 'system-file',
          parentRemoteItemId: 'sunday',
          kind: 'file',
          name: '.DS_Store'
        }
      ]
    })
    expect(plan).toMatchSnapshot()
    expect(uuid).toHaveBeenCalledTimes(3)
  } finally {
    uuid.mockRestore()
    clock.mockRestore()
  }
})
