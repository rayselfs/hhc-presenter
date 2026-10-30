import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  clearEditablePresentationCache,
  createBlankEditablePresentationDocument,
  createEditablePresentationItem,
  duplicateElementInSlide,
  duplicateEditableSlide,
  loadEditablePresentation,
  moveEditableSlide,
  updateElementInSlide,
  type EditablePresentationDocument
} from '../editable-presentation'
import { validatePptxSource } from '../pptx-source'
import { persistEditablePresentationRevision } from '../editable-presentation-persistence'
import { createPresentationDraft, getPresentationDraft } from '../presentation-drafts'
import { createSlideClipboard, pasteSlideClipboard } from '../presentation-slide-clipboard'
import { commitPresentationDocument, undoPresentationDocument } from '../presentation-history'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { resetMediaWorkDBForTests } from '../media-work-db'
import { resetThumbnailDBForTests } from '../thumbnail-db'
import { getBlobId } from '../blob-identity'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { EDITABLE_PRESENTATION_MIME_TYPE } from '../presentation-media'

beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('crypto', webcrypto)
  clearEditablePresentationCache()
  usePersonalSyncStore.setState({ activeOwnerId: null })
  await resetFileExplorerDBForTests()
  await resetMediaWorkDBForTests()
  await resetThumbnailDBForTests()
})
afterEach(() => vi.unstubAllGlobals())

async function fixture(): Promise<EditablePresentationDocument> {
  const cases = JSON.parse(
    await readFile('src/renderer/src/lib/__fixtures__/pptx-source/contract.json', 'utf8')
  ) as { document: EditablePresentationDocument }[]
  return cases[0].document
}

it('reopens exact source after supported edit and authoritative save', async () => {
  const document = await fixture()
  const item = await createEditablePresentationItem(document, 'file-root')
  const reopened = await loadEditablePresentation(item)
  expect(reopened).toMatchObject({ schemaVersion: 2, pptxSource: document.pptxSource })
  const slideId = reopened.slideOrder[0]
  const elementId = reopened.slides[slideId].elementOrder[0]
  const edited = updateElementInSlide(reopened, slideId, elementId, { x: 40 })
  await persistEditablePresentationRevision({
    itemId: item.id,
    sourceBlobId: getBlobId(item),
    revision: 1,
    document: edited
  })
  clearEditablePresentationCache()
  const saved = await loadEditablePresentation(item)
  expect(saved.pptxSource).toEqual(document.pptxSource)
  expect(saved.slides[slideId].elements[elementId]).toMatchObject({
    x: 40,
    pptxSourceNode: { id: '2', role: 'geometry' }
  })
  await expect(validatePptxSource(saved)).resolves.toBeUndefined()
})

it('duplicates objects without claiming another original node', async () => {
  const document = await fixture()
  const slideId = document.slideOrder[0]
  const elementId = document.slides[slideId].elementOrder[0]
  const copied = duplicateElementInSlide(document, slideId, elementId)
  expect(copied.document.slides[slideId].elements[copied.elementId]).not.toHaveProperty(
    'pptxSourceNode'
  )
  expect(document.slides[slideId].elements[elementId]).toHaveProperty('pptxSourceNode')
  const duplicated = duplicateEditableSlide(document, slideId)
  const next = duplicated.slides[duplicated.slideOrder[1]]
  expect(next).not.toHaveProperty('pptxSourcePart')
  expect(
    Object.values(next.elements).every((element) => element.pptxSourceNode === undefined)
  ).toBe(true)
  expect(duplicated.pptxSource).toEqual(document.pptxSource)
  await expect(validatePptxSource(duplicated)).resolves.toBeUndefined()
})

it('detaches source references when pasting into another native deck', async () => {
  const document = await fixture()
  const result = pasteSlideClipboard(
    createBlankEditablePresentationDocument('Destination'),
    createSlideClipboard(document, document.slideOrder),
    0
  )
  const pasted = result.document.slides[result.slideIds[0]]
  expect(pasted).not.toHaveProperty('pptxSourcePart')
  expect(
    Object.values(pasted.elements).every((element) => element.pptxSourceNode === undefined)
  ).toBe(true)
  await expect(validatePptxSource(result.document)).resolves.toBeUndefined()
})

it('retains original bindings through reorder, edit and undo', async () => {
  const document = await fixture()
  const duplicated = duplicateEditableSlide(document, document.slideOrder[0])
  const moved = moveEditableSlide(duplicated, document.slideOrder[0], 1)
  expect(moved.slides[document.slideOrder[0]]).toEqual(document.slides[document.slideOrder[0]])
  const history = commitPresentationDocument({ past: [], present: document, future: [] }, moved)
  expect(undoPresentationDocument(history).present).toEqual(document)
})

it('rejects corrupted source before creating catalog or restoring persisted content', async () => {
  const document = await fixture()
  if (!document.pptxSource) throw new Error('Fixture source missing')
  document.pptxSource.sha256 = '0'.repeat(64)
  await expect(createEditablePresentationItem(document, 'file-root')).rejects.toThrow()
  const db = await openFileExplorerDB()
  expect(await db.getAll('folder-items')).toHaveLength(0)
  await db.put('file-blobs', {
    id: 'bad',
    blob: new Blob([JSON.stringify(document)], { type: EDITABLE_PRESENTATION_MIME_TYPE })
  })
  await expect(
    loadEditablePresentation({ id: 'bad', name: 'Bad', url: 'blob:bad' })
  ).rejects.toThrow()
})

it('validates the source package of restored drafts before exposing their document', async () => {
  const document = await fixture()
  const item = await createPresentationDraft(
    {
      id: 'input',
      parentId: 'file-root',
      type: 'file',
      name: 'Input',
      url: 'blob:input',
      mimeType: EDITABLE_PRESENTATION_MIME_TYPE,
      size: 1,
      createdAt: 1,
      expiresAt: null,
      sortIndex: 0
    },
    document
  )
  const db = await openFileExplorerDB()
  const draft = await db.get('presentation-drafts', item.id)
  if (!draft?.document.pptxSource) throw new Error('Draft source missing')
  draft.document.pptxSource.sha256 = '0'.repeat(64)
  await db.put('presentation-drafts', draft)
  await expect(getPresentationDraft(item.id)).rejects.toThrow()
  expect(await db.get('presentation-drafts', item.id)).toBeDefined()
})

it('rejects account changes during source validation before creation or draft mutation', async () => {
  const document = await fixture()
  const originalDigest = webcrypto.subtle.digest.bind(webcrypto.subtle)
  for (const draft of [false, true]) {
    usePersonalSyncStore.setState({ activeOwnerId: 'owner-a' })
    vi.spyOn(webcrypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      usePersonalSyncStore.setState({ activeOwnerId: 'owner-b' })
      return originalDigest(...args)
    })
    const creation = draft
      ? createPresentationDraft(
          {
            id: 'input',
            parentId: 'file-root',
            type: 'file',
            name: 'Input',
            url: 'blob:input',
            mimeType: EDITABLE_PRESENTATION_MIME_TYPE,
            size: 1,
            createdAt: 1,
            expiresAt: null,
            sortIndex: 0,
            personalOwnerId: 'owner-a'
          },
          document
        )
      : createEditablePresentationItem(document, 'file-root')
    await expect(creation).rejects.toThrow('Personal account changed')
    const db = await openFileExplorerDB()
    expect(await db.getAll('folder-items')).toHaveLength(0)
    expect(await db.getAll('presentation-drafts')).toHaveLength(0)
  }
})

it('rejects forged source references before replacing saved or draft revisions', async () => {
  const document = await fixture()
  const item = await createEditablePresentationItem(document, 'file-root')
  const slide = document.slides[document.slideOrder[0]]
  const element = slide.elements[slide.elementOrder[0]]
  element.pptxSourceNode = { id: 'missing-node', role: 'geometry' }
  await expect(
    persistEditablePresentationRevision({
      itemId: item.id,
      sourceBlobId: getBlobId(item),
      revision: 1,
      document
    })
  ).rejects.toThrow()
  const db = await openFileExplorerDB()
  expect((await db.get('file-blobs', getBlobId(item)))?.revision ?? 0).toBe(0)
  const valid = await fixture()
  valid.id = crypto.randomUUID()
  const draft = await createPresentationDraft(item, valid)
  const badSlide = valid.slides[valid.slideOrder[0]]
  badSlide.elements[badSlide.elementOrder[0]].pptxSourceNode = {
    id: 'missing-node',
    role: 'geometry'
  }
  const { persistDraftRevision } = await import('../presentation-drafts')
  await expect(persistDraftRevision(draft.id, valid, 1)).rejects.toThrow()
  expect((await db.get('presentation-drafts', draft.id))?.revision).toBe(0)
})
