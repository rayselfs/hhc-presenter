import {
  persistDraftRevision,
  getPresentationDraft,
  assertWritablePresentationFolder
} from './presentation-drafts'
import type { IDBPDatabase } from 'idb'
import type { EditablePresentationDocument } from './editable-presentation'
import { generateEditablePresentationThumbnail } from './editable-presentation'
import { openFileExplorerDB, type FileExplorerDBSchema } from './file-explorer-db'
import { EDITABLE_PRESENTATION_MIME_TYPE } from './presentation-media'
import { saveThumbnail } from './thumbnail-db'
import { isFileItem } from '@shared/types/folder'
import { getBlobId } from './blob-identity'
import { commitPersonalFileMutation } from './personal-sync-db'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { publishPersistedFileItem } from '@renderer/stores/file-explorer'

export interface EditablePresentationRevisionWrite {
  itemId: string
  sourceBlobId: string
  revision: number
  document: EditablePresentationDocument
  catalogName?: string
}

export interface EditablePresentationRevisionResult {
  revision: number
  mirrorWarnings: Array<'derived-document'>
}

interface EditablePresentationPersistenceDependencies {
  openFileExplorerDB: () => Promise<IDBPDatabase<FileExplorerDBSchema>>
}

const defaultDependencies: EditablePresentationPersistenceDependencies = {
  openFileExplorerDB
}

export async function persistEditablePresentationRevision(
  write: EditablePresentationRevisionWrite,
  overrides: Partial<EditablePresentationPersistenceDependencies> = {}
): Promise<EditablePresentationRevisionResult> {
  if (await persistDraftRevision(write.itemId, write.document, write.revision, write.catalogName))
    return { revision: write.revision, mirrorWarnings: [] }
  const dependencies = { ...defaultDependencies, ...overrides }
  const body = JSON.stringify(write.document)
  const blob = new Blob([body], { type: EDITABLE_PRESENTATION_MIME_TYPE })
  const db = await dependencies.openFileExplorerDB()
  const personalNode = await db.get('personal-sync-nodes', write.itemId)
  if (personalNode) {
    const item = await db.get('folder-items', write.itemId)
    if (!item || !isFileItem(item)) throw new Error('Personal presentation catalog item is missing')
    const source = await db.get('file-blobs', getBlobId(item))
    if (!source || write.revision <= (source.revision ?? 0)) {
      throw new Error('Personal presentation source is missing or revision is stale')
    }
    const snapshotId = crypto.randomUUID()
    const catalog = {
      ...item,
      personalOwnerId: personalNode.ownerId,
      name: write.catalogName ?? item.name,
      url: `blob:${snapshotId}`,
      size: blob.size
    }
    await commitPersonalFileMutation(
      {
        ownerId: personalNode.ownerId,
        nodeId: item.id,
        remoteId: personalNode.remoteId,
        operationId: crypto.randomUUID(),
        localRevision: personalNode.localRevision + 1,
        contentRevision: write.revision,
        mutation: { type: 'replace-content' },
        catalog
      },
      new File([body], catalog.name, { type: EDITABLE_PRESENTATION_MIME_TYPE })
    )
    if (usePersonalSyncStore.getState().activeOwnerId === personalNode.ownerId) {
      publishPersistedFileItem(catalog)
      usePersonalSyncStore.setState({ syncStatus: 'pending', errorCode: null })
      window.dispatchEvent(new CustomEvent('hhc:personal-sync', { detail: personalNode.ownerId }))
    }
    return { revision: write.revision, mirrorWarnings: [] }
  }
  const tx = db.transaction(['file-blobs', 'folder-items', 'folder-records'], 'readwrite')
  const sourceStore = tx.objectStore('file-blobs')
  const catalogStore = tx.objectStore('folder-items')
  const [source, item] = await Promise.all([
    sourceStore.get(write.sourceBlobId),
    catalogStore.get(write.itemId)
  ])
  if (!source) {
    tx.abort()
    await tx.done.catch(() => undefined)
    throw new Error(`Editable presentation source is missing: ${write.sourceBlobId}`)
  }
  if (!item || !isFileItem(item)) {
    tx.abort()
    await tx.done.catch(() => undefined)
    throw new Error(`Editable presentation catalog item is missing: ${write.itemId}`)
  }
  try {
    assertWritablePresentationFolder(item.parentId, await tx.objectStore('folder-records').getAll())
  } catch (error) {
    tx.abort()
    await tx.done.catch(() => undefined)
    throw error
  }
  const storedRevision = source.revision ?? 0
  if (write.revision <= storedRevision) {
    tx.abort()
    await tx.done.catch(() => undefined)
    throw new Error(
      `Presentation revision ${write.revision} is not newer than persisted revision ${storedRevision}`
    )
  }

  await Promise.all([
    sourceStore.put({
      ...source,
      blob,
      size: blob.size,
      revision: write.revision
    }),
    catalogStore.put({
      ...item,
      name: write.catalogName ?? item.name,
      size: blob.size
    })
  ])
  await tx.done

  return { revision: write.revision, mirrorWarnings: [] }
}

export async function refreshEditablePresentationThumbnail(
  document: EditablePresentationDocument
): Promise<void> {
  if (await getPresentationDraft(document.id)) return
  const thumbnail = generateEditablePresentationThumbnail(document)
  await saveThumbnail(document.id, thumbnail)
  window.dispatchEvent(
    new CustomEvent('hhc:thumbnail-ready', {
      detail: { itemId: document.id, dataUrl: thumbnail }
    })
  )
}
