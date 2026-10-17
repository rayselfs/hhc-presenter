import type { FolderRecord } from '@shared/types/folder'

export function assertFolderCopyTarget(
  sourceId: string,
  targetId: string,
  folders: Record<string, FolderRecord>
): void {
  const seen = new Set<string>()
  let ancestor: string | null = targetId
  while (ancestor) {
    if (ancestor === sourceId) throw new Error('Cannot copy a folder into itself')
    if (seen.has(ancestor)) throw new Error('Invalid folder ancestry')
    seen.add(ancestor)
    ancestor = folders[ancestor]?.parentId ?? null
  }
}
