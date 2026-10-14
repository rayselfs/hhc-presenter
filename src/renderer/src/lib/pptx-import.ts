import { isFileItem, type FileItemRecord } from '@shared/types/folder'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { convertPresentationData, createEditablePresentationItem } from './editable-presentation'
import { openFileExplorerDB } from './file-explorer-db'
import { resolveUniqueFileName } from './file-naming'
import { PPTX_MIME_TYPE } from './presentation-media'
import { readPptxNotes } from './pptx-notes'
import {
  assertEditablePptxDocument,
  assertEditablePptxFeatures,
  assertEditablePptxPackage
} from './pptx-compatibility'
import { validatePortablePresentation } from './portable-presentation'

let pendingCatalogCreation: Promise<unknown> = Promise.resolve()

export async function importEditablePptx(file: File, parentId: string): Promise<FileItemRecord> {
  const ownerId = usePersonalSyncStore.getState().activeOwnerId
  const { parseZip, buildPresentation, materializeAllSlideNodes, RECOMMENDED_ZIP_LIMITS } =
    await import('@aiden0z/pptx-renderer')
  const buffer = await file.arrayBuffer()
  await assertEditablePptxPackage(buffer)
  const files = await parseZip(buffer, RECOMMENDED_ZIP_LIMITS)
  const presentation = buildPresentation(files)
  assertEditablePptxFeatures(files, presentation)
  materializeAllSlideNodes(presentation)
  const source: FileItemRecord = {
    id: crypto.randomUUID(),
    parentId,
    type: 'file',
    sortIndex: 0,
    createdAt: Date.now(),
    expiresAt: null,
    name: file.name,
    url: '',
    size: file.size,
    mimeType: PPTX_MIME_TYPE
  }
  const document = convertPresentationData(
    source,
    presentation,
    undefined,
    await readPptxNotes(buffer, presentation)
  )
  assertEditablePptxDocument(document, presentation)
  // Name resolution and persistence must stay together when upload workers finish concurrently.
  const creation = pendingCatalogCreation.then(async () => {
    const db = await openFileExplorerDB()
    const siblings = await db.getAllFromIndex('folder-items', 'by-parent', parentId)
    const name = resolveUniqueFileName(
      `${file.name.replace(/\.pptx$/i, '')}.lpdeck`,
      siblings
        .filter(isFileItem)
        .filter((item) => !item.deletedAt)
        .map((item) => item.name)
    )
    document.name = name.replace(/\.lpdeck$/, '')
    delete document.sourceItemId
    delete document.sourceBlobId
    validatePortablePresentation(document)
    if (ownerId !== usePersonalSyncStore.getState().activeOwnerId)
      throw new Error('Personal account changed')
    return createEditablePresentationItem(document, parentId, name)
  })
  pendingCatalogCreation = creation.catch(() => undefined)
  return creation
}
