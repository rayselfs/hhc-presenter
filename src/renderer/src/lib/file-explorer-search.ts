import { isPersonalRootFolder } from './sync-readonly'
import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import type { FolderStoreState } from '@renderer/stores/folder'

export type SearchResult =
  | { kind: 'file'; item: FileItemRecord; folderPath: string }
  | { kind: 'folder'; folder: FolderRecord; folderPath: string }

export function searchAllItems(
  query: string,
  storeState: FolderStoreState,
  rootLabel: string,
  ownerId?: string | null
): SearchResult[] {
  if (query.trim() === '') return []

  const lowerQuery = query.toLowerCase()
  const results: SearchResult[] = []

  for (const record of storeState._itemsArray) {
    if (record.type !== 'file') continue
    if (record.deletedAt) continue
    if (
      ownerId !== undefined &&
      (record.personalOwnerId ?? record.sharedRecipientId ?? null) !== ownerId
    )
      continue
    if (
      record.sharedRecipientId &&
      !storeState
        .getFolderPath(record.parentId)
        .some((folder) => folder.syncLink?.providerType === 'hhc-share' && folder.parentId)
    )
      continue
    if (!record.name.toLowerCase().includes(lowerQuery)) continue

    const item = record as FileItemRecord
    const pathFolders = storeState
      .getFolderPath(item.parentId)
      .filter((f) => f.parentId !== null && !isPersonalRootFolder(f))
    const folderPath = '/' + [rootLabel, ...pathFolders.map((f) => f.name)].join('/')

    results.push({ kind: 'file', item, folderPath })

    if (results.length >= 20) break
  }

  if (results.length < 20) {
    for (const folder of storeState._foldersArray) {
      if (folder.parentId === null) continue
      if (folder.deletedAt || isPersonalRootFolder(folder)) continue
      if (
        ownerId !== undefined &&
        (folder.personalOwnerId ?? folder.sharedRecipientId ?? null) !== ownerId
      )
        continue
      if (
        folder.sharedRecipientId &&
        !storeState
          .getFolderPath(folder.id)
          .some((ancestor) => ancestor.syncLink?.providerType === 'hhc-share' && ancestor.parentId)
      )
        continue
      if (!folder.name.toLowerCase().includes(lowerQuery)) continue

      const pathFolders = storeState
        .getFolderPath(folder.parentId)
        .filter((f) => f.parentId !== null && !isPersonalRootFolder(f))
      const folderPath = '/' + [rootLabel, ...pathFolders.map((f) => f.name)].join('/')

      results.push({ kind: 'folder', folder, folderPath })

      if (results.length >= 20) break
    }
  }

  return results
}
