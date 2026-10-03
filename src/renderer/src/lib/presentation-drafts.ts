import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import type { EditablePresentationDocument } from './editable-presentation'
import { openFileExplorerDB } from './file-explorer-db'
import { EDITABLE_PRESENTATION_MIME_TYPE } from './presentation-media'
import { isPersonalRecordVisible, usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { hasNameConflict, validateDisplayName } from './file-naming'

export const PRESENTATION_DRAFT_PARENT = 'presentation-drafts'
export interface PresentationDraftRecord {
  id: string
  item: FileItemRecord
  document: EditablePresentationDocument
  revision: number
}

export function assertWritablePresentationFolder(
  parentId: string,
  folders: FolderRecord[],
  ownerId = usePersonalSyncStore.getState().activeOwnerId
): void {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const visited = new Set<string>()
  let id: string | null = parentId
  while (id && id !== 'file-root') {
    const folder = byId.get(id)
    if (
      !folder ||
      visited.has(id) ||
      folder.deletedAt ||
      folder.syncLink ||
      folder.sharedRecipientId ||
      (folder.personalOwnerId && folder.personalOwnerId !== ownerId)
    ) {
      throw new Error('Presentation destination is unavailable or read-only')
    }
    visited.add(id)
    id = folder.parentId
  }
  if (id !== 'file-root') throw new Error('Presentation destination is unavailable')
}

export async function isReadonlyPresentationSource(item: FileItemRecord): Promise<boolean> {
  if (item.sharedRecipientId) return true
  const db = await openFileExplorerDB()
  try {
    assertWritablePresentationFolder(item.parentId, await db.getAll('folder-records'))
    return false
  } catch {
    return true
  }
}

function assertDraftOwner(draft: PresentationDraftRecord): void {
  if (!isPersonalRecordVisible(draft.item)) throw new Error('Personal account changed')
}

export function assertPresentationDraftPromotion(
  draft: PresentationDraftRecord | undefined,
  revision: number | undefined
): void {
  if (!draft || draft.revision !== revision)
    throw new Error('Presentation draft changed during save')
  assertDraftOwner(draft)
}

export async function createPresentationDraft(
  source: FileItemRecord,
  document: EditablePresentationDocument
): Promise<FileItemRecord> {
  if (!isPersonalRecordVisible(source)) throw new Error('Personal account changed')
  const item: FileItemRecord = {
    id: document.id,
    type: 'file',
    name: document.name,
    parentId: PRESENTATION_DRAFT_PARENT,
    personalOwnerId: usePersonalSyncStore.getState().activeOwnerId ?? undefined,
    url: `blob:${document.id}`,
    mimeType: EDITABLE_PRESENTATION_MIME_TYPE,
    size: new Blob([JSON.stringify(document)]).size,
    sortIndex: 0,
    createdAt: Date.now(),
    expiresAt: null
  }
  const db = await openFileExplorerDB()
  await db.add('presentation-drafts', { id: item.id, item, document, revision: 0 })
  return item
}

export async function getPresentationDraft(id: string): Promise<PresentationDraftRecord | null> {
  const db = await openFileExplorerDB()
  const draft = await db.get('presentation-drafts', id)
  if (!draft) return null
  // A crash after promotion must not resurrect a second copy or restrict the saved file.
  if (await db.get('folder-items', id)) return null
  assertDraftOwner(draft)
  return draft
}

export async function listPresentationDrafts(): Promise<PresentationDraftRecord[]> {
  const db = await openFileExplorerDB()
  const drafts = await db.getAll('presentation-drafts')
  const catalog = new Set(await db.getAllKeys('folder-items'))
  return drafts.filter((draft) => isPersonalRecordVisible(draft.item) && !catalog.has(draft.id))
}

export async function getPresentationItem(id: string): Promise<FileItemRecord | undefined> {
  const db = await openFileExplorerDB()
  const item = await db.get('folder-items', id)
  if (item?.type === 'file') return isPersonalRecordVisible(item) ? item : undefined
  return (await getPresentationDraft(id))?.item
}

export async function persistDraftRevision(
  id: string,
  document: EditablePresentationDocument,
  revision: number,
  catalogName?: string
): Promise<boolean> {
  const db = await openFileExplorerDB()
  const tx = db.transaction(['presentation-drafts', 'folder-items'], 'readwrite')
  try {
    const draft = await tx.objectStore('presentation-drafts').get(id)
    if (!draft || (await tx.objectStore('folder-items').get(id))) {
      await tx.done
      return false
    }
    assertDraftOwner(draft)
    if (revision <= draft.revision) throw new Error('Draft revision is stale')
    await tx.objectStore('presentation-drafts').put({
      ...draft,
      document,
      revision,
      item: {
        ...draft.item,
        name: catalogName ?? draft.item.name,
        size: new Blob([JSON.stringify(document)]).size
      }
    })
    await tx.done
    return true
  } catch (error) {
    tx.abort()
    await tx.done.catch(() => undefined)
    throw error
  }
}

export async function discardPresentationDraft(id: string): Promise<void> {
  const db = await openFileExplorerDB()
  const draft = await db.get('presentation-drafts', id)
  if (!draft) return
  assertDraftOwner(draft)
  await db.delete('presentation-drafts', id)
}

export async function savePresentationDraft(
  id: string,
  parentId: string,
  name: string
): Promise<FileItemRecord> {
  const draft = await getPresentationDraft(id)
  if (!draft) throw new Error('Presentation draft is unavailable')
  const trimmed = name.trim()
  if (!validateDisplayName(trimmed)) throw new Error('Invalid presentation name')
  const db = await openFileExplorerDB()
  const folders = await db.getAll('folder-records')
  assertWritablePresentationFolder(parentId, folders)
  const siblings = await db.getAllFromIndex('folder-items', 'by-parent', parentId)
  if (
    hasNameConflict(
      trimmed,
      siblings
        .filter((item) => item.type === 'file' && !item.deletedAt)
        .map((item) => (item.type === 'file' ? item.name : ''))
    )
  )
    throw new Error('A file with this name already exists')
  const document = { ...draft.document, name: trimmed }
  const blob = new Blob([JSON.stringify(document)], { type: EDITABLE_PRESENTATION_MIME_TYPE })
  const item: FileItemRecord = {
    ...draft.item,
    parentId,
    personalOwnerId: folders.find((folder) => folder.id === parentId)?.personalOwnerId,
    name: trimmed,
    size: blob.size
  }
  const { persistEditablePresentationCreation } = await import('./editable-presentation-creation')
  const { generateEditablePresentationThumbnail } = await import('./editable-presentation')
  assertDraftOwner(draft)
  await persistEditablePresentationCreation({
    item,
    blob,
    thumbnail: generateEditablePresentationThumbnail(document),
    draftId: id,
    draftRevision: draft.revision
  })
  return item
}
