import { beforeEach, describe, expect, it } from 'vitest'
import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import {
  FILE_EXPLORER_ROOT_ID,
  mergePersistedSyncCatalog,
  publishPersistedSyncRoot,
  useFileExplorerStore
} from '@renderer/stores/file-explorer'

function folder(id: string, parentId = FILE_EXPLORER_ROOT_ID, sortIndex = 0): FolderRecord {
  return { id, parentId, sortIndex, name: id, createdAt: 1, expiresAt: null }
}

function item(id: string, parentId: string, sortIndex = 0): FileItemRecord {
  return {
    ...folder(id, parentId, sortIndex),
    parentId,
    type: 'file',
    url: `blob:${id}`,
    size: 1,
    mimeType: 'image/png'
  }
}

beforeEach(() => {
  useFileExplorerStore.setState({
    folders: {},
    items: {},
    _foldersArray: [],
    _itemsArray: [],
    _childFoldersByParent: {},
    _itemsByParent: {},
    loadedParents: new Set()
  })
})

describe('persisted sync catalog publication', () => {
  it('merges repeated imports without duplicates and retains unrelated loaded data', () => {
    const unrelated = folder('unrelated')
    const retained = item('retained', unrelated.id)
    mergePersistedSyncCatalog([unrelated], [retained])
    const root = folder('import', FILE_EXPLORER_ROOT_ID, 2)
    const nested = folder('nested', root.id)
    const first = item('first', nested.id, 0)
    const last = item('last', nested.id, 2)
    mergePersistedSyncCatalog([nested, root], [last, first])
    const renamed = { ...last, name: 'Renamed', sortIndex: -1 }
    mergePersistedSyncCatalog([root, nested], [renamed, first])

    const state = useFileExplorerStore.getState()
    expect(state._foldersArray).toEqual(Object.values(state.folders))
    expect(state._itemsArray).toEqual(Object.values(state.items))
    expect(state._foldersArray).toHaveLength(3)
    expect(state._itemsArray).toHaveLength(3)
    expect(state._childFoldersByParent[FILE_EXPLORER_ROOT_ID]).toEqual([unrelated, root])
    expect(state._childFoldersByParent[root.id]).toEqual([nested])
    expect(state._itemsByParent[nested.id]).toEqual([renamed, first])
    expect(state._itemsByParent[unrelated.id]).toEqual([retained])
    expect(state.loadedParents).toEqual(
      new Set([FILE_EXPLORER_ROOT_ID, unrelated.id, root.id, nested.id])
    )
  })

  it('updates a persisted root without marking its children loaded or changing item indices', () => {
    const sibling = folder('sibling', FILE_EXPLORER_ROOT_ID, 1)
    const retained = item('retained', sibling.id)
    mergePersistedSyncCatalog([sibling], [retained])
    const before = useFileExplorerStore.getState()
    const root = folder('import', FILE_EXPLORER_ROOT_ID, 2)
    publishPersistedSyncRoot(root)
    const renamed = { ...root, name: 'Renamed', sortIndex: 0 }
    publishPersistedSyncRoot(renamed)

    const state = useFileExplorerStore.getState()
    expect(state.folders[root.id]).toEqual(renamed)
    expect(state._foldersArray).toEqual([sibling, renamed])
    expect(state._childFoldersByParent[FILE_EXPLORER_ROOT_ID]).toEqual([renamed, sibling])
    expect(state.loadedParents).toBe(before.loadedParents)
    expect(state.loadedParents.has(root.id)).toBe(false)
    expect(state.items).toBe(before.items)
    expect(state._itemsByParent).toBe(before._itemsByParent)
  })
})
