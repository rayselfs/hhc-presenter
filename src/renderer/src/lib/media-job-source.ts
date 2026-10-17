import { getFileBlob, getFileSource, openFileExplorerDB } from './file-explorer-db'
import { getBlobId } from './blob-identity'

export async function loadMediaJobFile(
  sourceBlobId: string,
  itemId: string,
  sourceLabel: 'thumbnail' | 'PDF'
): Promise<File | null> {
  const db = await openFileExplorerDB()
  const requestedItem = await db.get('folder-items', itemId)
  const item =
    requestedItem?.type === 'file'
      ? requestedItem
      : (await db.getAll('folder-items')).find(
          (candidate) => candidate.type === 'file' && getBlobId(candidate) === sourceBlobId
        )
  if (!item || item.type !== 'file') return null

  const blob = await getFileBlob(db, sourceBlobId)
  if (blob) return new File([blob], item.name, { type: item.mimeType })

  const source = await getFileSource(db, sourceBlobId, item.mimeType)
  if (!source) return null
  try {
    const response = await fetch(source.url)
    if (!response.ok) throw new Error(`Failed to read ${sourceLabel} source: ${response.status}`)
    return new File([await response.blob()], item.name, { type: item.mimeType })
  } finally {
    source.revoke()
  }
}
