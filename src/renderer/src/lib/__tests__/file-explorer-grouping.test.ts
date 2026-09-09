import { describe, expect, it } from 'vitest'
import { groupItemsByDate } from '../file-explorer-grouping'
import { resolveFolderDisplay, useFileExplorerSettings } from '@renderer/stores/file-explorer'
import type { FolderRecord } from '@shared/types/folder'

describe('media date groups and folder preferences', () => {
  it('uses the configured day boundary, retains item order, and puts invalid dates last', () => {
    const items = [
      { id: 'before', createdAt: Date.parse('2026-09-03T15:59:59Z') },
      { id: 'after', createdAt: Date.parse('2026-09-03T16:00:00Z') },
      { id: 'later', createdAt: Date.parse('2026-09-03T17:00:00Z') },
      { id: 'missing' },
      { id: 'invalid', createdAt: NaN }
    ]
    expect(
      groupItemsByDate(items, 'Asia/Taipei', 'desc').map(({ id, dateGroup }) => [id, dateGroup])
    ).toEqual([
      ['after', '2026/09/04'],
      ['later', '2026/09/04'],
      ['before', '2026/09/03'],
      ['missing', ''],
      ['invalid', '']
    ])
    expect(groupItemsByDate(items, 'UTC', 'asc')[0].dateGroup).toBe('2026/09/03')
    expect(items[0].createdAt).toBe(Date.parse('2026-09-03T15:59:59Z'))
  })

  it('inherits LINE defaults through ancestors while preserving explicit preferences', () => {
    const root: FolderRecord = {
      id: 'line',
      parentId: null,
      name: 'LINE',
      sortIndex: 0,
      createdAt: 0,
      expiresAt: null,
      syncLink: {
        providerType: 'hhc-line',
        providerConnectionId: 'connection',
        remoteFolderId: 'remote'
      }
    }
    const child = { ...root, id: 'child', parentId: 'line', syncLink: undefined }
    const folders = { line: root, child }
    const defaults = {
      viewMode: 'medium-icon' as const,
      sortField: 'name' as const,
      sortDir: 'asc' as const
    }
    expect(resolveFolderDisplay('child', folders, defaults)).toEqual({
      sortField: 'createdAt',
      sortDir: 'desc',
      groupMode: 'date',
      groupSortDir: 'desc',
      viewMode: 'medium-icon'
    })
    expect(resolveFolderDisplay('child', folders, defaults, { groupMode: 'none' }).groupMode).toBe(
      'none'
    )
    expect(resolveFolderDisplay('ordinary', folders, defaults)).toEqual({
      ...defaults,
      groupSortDir: 'desc',
      groupMode: 'none'
    })
    useFileExplorerSettings.getState().setFolderDisplay('child', { groupMode: 'none' })
    useFileExplorerSettings.getState().setFolderDisplay('child', { sortDir: 'asc' })
    expect(useFileExplorerSettings.getState().folderDisplay.child).toEqual({
      groupMode: 'none',
      sortDir: 'asc'
    })
    expect(useFileExplorerSettings.persist.getOptions().version).toBe(5)
  })
})
