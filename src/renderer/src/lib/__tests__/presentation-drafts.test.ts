import { beforeEach, expect, it } from 'vitest'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { createBlankEditablePresentationDocument } from '../editable-presentation'
import {
  createPresentationDraft,
  getPresentationDraft,
  savePresentationDraft,
  discardPresentationDraft,
  persistDraftRevision
} from '../presentation-drafts'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import type { FileItemRecord } from '@shared/types/folder'

const source: FileItemRecord = {
  id: 'source',
  parentId: 'synced',
  type: 'file',
  name: 'Original.pptx',
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  url: 'blob:source',
  size: 1,
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null
}
beforeEach(async () => {
  await resetFileExplorerDBForTests()
  usePersonalSyncStore.setState({ activeOwnerId: null })
})

it('keeps recovery snapshots out of the catalog and promotes only to a writable destination', async () => {
  const document = createBlankEditablePresentationDocument('Copy')
  const item = await createPresentationDraft(source, document)
  const db = await openFileExplorerDB()
  expect(await db.get('folder-items', item.id)).toBeUndefined()
  expect(await db.get('file-blobs', item.id)).toBeUndefined()
  expect((await getPresentationDraft(item.id))?.document.name).toBe('Copy')
  await persistDraftRevision(item.id, { ...document, name: 'Edited' }, 1)
  await expect(persistDraftRevision(item.id, document, 1)).rejects.toThrow(/revision/i)
  await db.put('folder-records', {
    id: 'synced',
    name: 'LINE',
    parentId: 'file-root',
    createdAt: 1,
    expiresAt: null,
    sortIndex: 0,
    syncLink: { providerType: 'hhc-line', providerConnectionId: 'line', remoteFolderId: 'line' }
  })
  await db.put('folder-records', {
    id: 'child',
    name: 'Child',
    parentId: 'synced',
    createdAt: 1,
    expiresAt: null,
    sortIndex: 0
  })
  await expect(savePresentationDraft(item.id, 'child', 'Saved')).rejects.toThrow()
  await expect(savePresentationDraft(item.id, 'missing', 'Saved')).rejects.toThrow()
  expect(await getPresentationDraft(item.id)).not.toBeNull()
  const saved = await savePresentationDraft(item.id, 'file-root', 'Saved')
  expect(saved.parentId).toBe('file-root')
  expect(saved.expiresAt).toBeNull()
  expect(await getPresentationDraft(item.id)).toBeNull()
  expect((await db.get('folder-items', item.id))?.id).toBe(item.id)
})

it('retains drafts after failed writes and isolates account-owned recovery', async () => {
  usePersonalSyncStore.setState({ activeOwnerId: 'owner-a' })
  const item = await createPresentationDraft(
    source,
    createBlankEditablePresentationDocument('Private')
  )
  await expect(savePresentationDraft(item.id, 'file-root', '')).rejects.toThrow()
  expect(await getPresentationDraft(item.id)).not.toBeNull()
  usePersonalSyncStore.setState({ activeOwnerId: 'owner-b' })
  await expect(getPresentationDraft(item.id)).rejects.toThrow(/account/i)
  await expect(discardPresentationDraft(item.id)).rejects.toThrow(/account/i)
  usePersonalSyncStore.setState({ activeOwnerId: 'owner-a' })
  await discardPresentationDraft(item.id)
  expect(await getPresentationDraft(item.id)).toBeNull()
})

it('ignores an old account-owned recovery snapshot after promotion to local storage', async () => {
  usePersonalSyncStore.setState({ activeOwnerId: 'owner-a' })
  const item = await createPresentationDraft(
    source,
    createBlankEditablePresentationDocument('Copy')
  )
  const db = await openFileExplorerDB()
  const recovery = await db.get('presentation-drafts', item.id)
  await savePresentationDraft(item.id, 'file-root', 'Saved')
  await db.put('presentation-drafts', recovery!)
  usePersonalSyncStore.setState({ activeOwnerId: null })
  expect(await getPresentationDraft(item.id)).toBeNull()
  expect((await db.get('folder-items', item.id))?.personalOwnerId).toBeUndefined()
})

it('promotes a draft into the current account cloud with exactly one pending create operation', async () => {
  usePersonalSyncStore.setState({ activeOwnerId: 'owner-a' })
  const db = await openFileExplorerDB()
  await db.put('folder-records', {
    id: 'personal-root',
    name: 'Cloud',
    parentId: 'file-root',
    personalOwnerId: 'owner-a',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null
  })
  await db.put('personal-sync-state', {
    ownerId: 'owner-a',
    rootId: 'personal-root',
    collectionId: 'collection',
    collectionRevision: 1,
    sequence: 0
  })
  const item = await createPresentationDraft(
    source,
    createBlankEditablePresentationDocument('Cloud copy')
  )
  const saved = await savePresentationDraft(item.id, 'personal-root', 'Cloud copy')
  expect(saved.personalOwnerId).toBe('owner-a')
  expect(await getPresentationDraft(item.id)).toBeNull()
  const operations = await db.getAll('personal-sync-outbox')
  expect(operations).toHaveLength(1)
  expect(operations[0].mutation.type).toBe('create-file')
})
