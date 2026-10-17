import { isFileItem, type FileItemRecord } from '@shared/types/folder'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import {
  convertPptxBytesToEditableDocument,
  createEditablePresentationItem
} from './editable-presentation'
import { openFileExplorerDB } from './file-explorer-db'
import { resolveUniqueFileName } from './file-naming'
import { PPTX_MIME_TYPE } from './presentation-media'
import { validatePortablePresentation } from './portable-presentation'

let pendingCatalogCreation: Promise<unknown> = Promise.resolve()

export async function importEditablePptx(file: File, parentId: string): Promise<FileItemRecord> {
  const ownerId = usePersonalSyncStore.getState().activeOwnerId
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
  const document = await convertPptxBytesToEditableDocument(await file.arrayBuffer(), source)
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
