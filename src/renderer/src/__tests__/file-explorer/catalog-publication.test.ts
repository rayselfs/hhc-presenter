import { beforeEach, describe, expect, it } from 'vitest'
import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import {
  FILE_EXPLORER_ROOT_ID,
  mergePersistedSyncCatalog,
  mergePersistedSyncRefresh,
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

describe('persisted refresh publication', () => {
  it('removes records and loaded parents, rebuilds sorted indexes and falls back only from a removed folder', () => {
    const removed = folder('removed')
    const retained = folder('retained')
    const deleted = item('deleted', removed.id)
    const unchanged = item('unchanged', retained.id, 0)
    const moving = item('moving', removed.id, 1)
    mergePersistedSyncCatalog([removed, retained], [deleted, moving, unchanged])
    useFileExplorerStore.setState({ currentFolderId: removed.id })
    const added = folder('empty-new', FILE_EXPLORER_ROOT_ID, -1)
    const updated = { ...retained, name: 'Updated retained' }
    const moved = { ...moving, parentId: retained.id, sortIndex: -1 }
    const plan = {
      folders: [updated, added],
      items: [moved],
      removedFolderIds: [removed.id],
      removedItemIds: [deleted.id]
    }
    mergePersistedSyncRefresh(plan)
    mergePersistedSyncRefresh(plan)
    const state = useFileExplorerStore.getState()
    expect(state.folders).toEqual({ retained: updated, 'empty-new': added })
    expect(state.items).toEqual({ unchanged, moving: moved })
    expect(state._foldersArray).toEqual(Object.values(state.folders))
    expect(state._itemsArray).toEqual(Object.values(state.items))
    expect(state._childFoldersByParent[FILE_EXPLORER_ROOT_ID]).toEqual([added, updated])
    expect(state._itemsByParent[retained.id]).toEqual([moved, unchanged])
    expect(state._itemsByParent[removed.id]).toBeUndefined()
    expect(state.loadedParents).toEqual(new Set([FILE_EXPLORER_ROOT_ID, retained.id]))
    expect(state.loadedParents.has(added.id)).toBe(false)
    expect(state.currentFolderId).toBe(FILE_EXPLORER_ROOT_ID)
  })

  it('keeps unrelated navigation and existing loaded data', () => {
    const retained = folder('retained')
    const unchanged = item('unchanged', retained.id)
    mergePersistedSyncCatalog([retained], [unchanged])
    useFileExplorerStore.setState({ currentFolderId: retained.id })
    mergePersistedSyncRefresh({
      folders: [folder('new')],
      items: [],
      removedFolderIds: [],
      removedItemIds: []
    })
    const state = useFileExplorerStore.getState()
    expect(state.currentFolderId).toBe(retained.id)
    expect(state._itemsByParent[retained.id]).toEqual([unchanged])
    expect(state.items[unchanged.id]).toBe(unchanged)
    expect(state.loadedParents.has(retained.id)).toBe(true)
    expect(state.loadedParents.has('new')).toBe(false)
  })
})
