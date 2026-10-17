import type { FolderStoreState } from '@renderer/stores/folder'
import type { FolderRecord, VerseItemRecord } from '@shared/types/folder'
import { assertFolderCopyTarget } from './folder-copy-target'

type FolderSnapshot = {
  folder: FolderRecord
  items: VerseItemRecord[]
  children: FolderSnapshot[]
}

export async function copyBibleFolder(
  getState: () => FolderStoreState,
  sourceId: string,
  targetId: string
): Promise<string> {
  assertFolderCopyTarget(sourceId, targetId, getState().folders)
  const visited = new Set<string>()
  async function snapshot(id: string): Promise<FolderSnapshot> {
    if (visited.has(id)) throw new Error('Invalid folder ancestry')
    visited.add(id)
    const folder = getState().folders[id]
    if (!folder) throw new Error('Copy source is unavailable')
    await getState().ensureItemsLoaded(id)
    const items = getState().getItems(id)
    if (!items.every((item): item is VerseItemRecord => item.type === 'verse')) {
      throw new Error('Bible folders can only contain verses')
    }
    const children = []
    for (const child of getState().getChildFolders(id)) children.push(await snapshot(child.id))
    return { folder, items: [...items], children }
  }
  const source = await snapshot(sourceId)
  await getState().flushPersistence()
  assertFolderCopyTarget(sourceId, targetId, getState().folders)
  if (!getState().folders[sourceId]) throw new Error('Copy source is unavailable')
  function write(node: FolderSnapshot, parentId: string): string {
    const target = getState().addFolder(node.folder.name, parentId, node.folder.expiresAt)
    if (!target) throw new Error('Copy destination is unavailable')
    for (const item of node.items) {
      const { id: _id, sortIndex: _sortIndex, createdAt: _createdAt, ...verse } = item
      getState().addItem({ ...verse, parentId: target })
    }
    for (const child of node.children) write(child, target)
    return target
  }
  const target = write(source, targetId)
  await getState().flushPersistence()
  return target
}
