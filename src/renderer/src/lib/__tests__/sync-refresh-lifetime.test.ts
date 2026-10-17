import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderRecord } from '@shared/types/folder'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import {
  createSyncRefreshGuard,
  invalidateSyncRefresh,
  withSyncConnectionMutation
} from '../sync-refresh-lifetime'

const root: FolderRecord = {
  id: 'lifetime-root',
  name: 'Root',
  parentId: 'file-root',
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null,
  syncLink: {
    providerType: 'onedrive',
    providerConnectionId: 'onedrive:lifetime',
    remoteFolderId: 'remote-root'
  }
}

beforeEach(async () => {
  await resetFileExplorerDBForTests()
  await (await openFileExplorerDB()).put('folder-records', root)
})
afterEach(() => vi.unstubAllGlobals())

describe('sync refresh lifetime', () => {
  it('invalidates immediately before the durable root is removed', async () => {
    const guard = createSyncRefreshGuard(root)
    expect(await guard()).toBe(true)
    invalidateSyncRefresh(root.syncLink!.providerConnectionId, root.id)
    expect(await guard()).toBe(false)
    expect(await (await openFileExplorerDB()).get('folder-records', root.id)).toEqual(root)
  })

  it('does not invalidate an unrelated root unless the whole connection is revoked', async () => {
    const guard = createSyncRefreshGuard(root)
    invalidateSyncRefresh(root.syncLink!.providerConnectionId, 'other-root')
    expect(await guard()).toBe(true)
    invalidateSyncRefresh(root.syncLink!.providerConnectionId)
    expect(await guard()).toBe(false)
  })

  it.each(['deleted', 'replaced', 'unlinked', 'revoked'] as const)(
    'rejects durable root changes from another renderer: %s',
    async (change) => {
      const guard = createSyncRefreshGuard(root)
      const db = await openFileExplorerDB()
      if (change === 'deleted') await db.delete('folder-records', root.id)
      if (change === 'replaced') await db.put('folder-records', { ...root, createdAt: 2 })
      if (change === 'unlinked') await db.put('folder-records', { ...root, syncLink: undefined })
      if (change === 'revoked')
        await db.put('folder-records', {
          ...root,
          syncLink: { ...root.syncLink!, status: 'access-revoked' }
        })
      expect(await guard()).toBe(false)
    }
  )

  it('does not enter a mutation until the connection Web Lock is granted', async () => {
    let grant!: () => Promise<string>
    const request = vi.fn(
      (_name: string, callback: () => Promise<string>) =>
        new Promise<string>((resolve) => {
          grant = async () => {
            const value = await callback()
            resolve(value)
            return value
          }
        })
    )
    vi.stubGlobal('navigator', { locks: { request } })
    const mutation = vi.fn(async () => 'committed')
    const result = withSyncConnectionMutation('onedrive:lifetime', mutation)
    expect(request).toHaveBeenCalledWith('hhc-sync-connection:onedrive:lifetime', mutation)
    expect(mutation).not.toHaveBeenCalled()
    await grant()
    await expect(result).resolves.toBe('committed')
  })
})
