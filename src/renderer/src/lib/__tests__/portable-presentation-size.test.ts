import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import {
  createBlankEditablePresentationDocument,
  createEditablePresentationItem
} from '../editable-presentation'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { createPresentationDraft, persistDraftRevision } from '../presentation-drafts'
import { persistEditablePresentationRevision } from '../editable-presentation-persistence'
import { EDITABLE_PRESENTATION_MIME_TYPE } from '../presentation-media'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'

// Use the same production boundary with a small test policy; avoid 200 MiB allocations.
vi.mock('@shared/personal-cloud', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/personal-cloud')>()),
  PERSONAL_MAX_FILE_BYTES: 4096
}))

beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob)
  usePersonalSyncStore.setState({ activeOwnerId: null })
  await resetFileExplorerDBForTests()
})
afterEach(() => vi.unstubAllGlobals())

const source = {
  id: 'input',
  parentId: 'file-root',
  type: 'file' as const,
  name: 'Input',
  url: 'blob:input',
  mimeType: EDITABLE_PRESENTATION_MIME_TYPE,
  size: 1,
  createdAt: 1,
  expiresAt: null,
  sortIndex: 0
}

it('rejects UTF-8 byte overflow before catalog creation', async () => {
  const document = createBlankEditablePresentationDocument('Large')
  document.slides[document.slideOrder[0]].notes = '界'.repeat(1500)
  const body = JSON.stringify(document)
  expect(body.length).toBeLessThan(4096)
  expect(new Blob([body]).size).toBeGreaterThan(4096)
  await expect(createEditablePresentationItem(document, 'file-root')).rejects.toThrow(
    /size|MiB|large/i
  )
  const db = await openFileExplorerDB()
  expect(await db.getAll('folder-items')).toHaveLength(0)
  expect(await db.getAll('file-blobs')).toHaveLength(0)
})

it('rejects oversized edits before replacing the old authority or catalog', async () => {
  const document = createBlankEditablePresentationDocument('Original')
  const item = await createEditablePresentationItem(document, 'file-root')
  const db = await openFileExplorerDB()
  const before = await db.get('file-blobs', document.id)
  const changed = structuredClone(document)
  changed.slides[changed.slideOrder[0]].notes = '界'.repeat(1500)
  await expect(
    persistEditablePresentationRevision({
      itemId: item.id,
      sourceBlobId: document.id,
      revision: 1,
      document: changed
    })
  ).rejects.toThrow(/size|MiB|large/i)
  expect((await db.get('file-blobs', document.id))?.revision).toBe(before?.revision)
  expect((await db.get('file-blobs', document.id))?.size).toBe(before?.size)
  expect(await db.get('folder-items', item.id)).toEqual(item)
})

it('rejects oversized draft creation and edits before mutating recovery records', async () => {
  const document = createBlankEditablePresentationDocument('Draft')
  const item = await createPresentationDraft(source, document)
  const changed = structuredClone(document)
  changed.slides[changed.slideOrder[0]].notes = '界'.repeat(1500)
  await expect(createPresentationDraft(source, { ...changed, id: 'large' })).rejects.toThrow(
    /size|MiB|large/i
  )
  await expect(persistDraftRevision(item.id, changed, 1)).rejects.toThrow(/size|MiB|large/i)
  const db = await openFileExplorerDB()
  expect(await db.getAll('presentation-drafts')).toHaveLength(1)
  expect((await db.get('presentation-drafts', item.id))?.document).toEqual(document)
})
