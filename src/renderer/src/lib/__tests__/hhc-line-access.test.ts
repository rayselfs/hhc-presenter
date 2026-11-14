import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderRecord } from '@shared/types/folder'
import type { HhcLineCloudAuth } from '../cloud-provider'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { HhcAssetApiError } from '../hhc-asset-api'
import {
  cleanupHhcLineAccountAccess,
  handleHhcLineAccessError,
  isHhcLineRootAuthorized
} from '../hhc-line-access'

const mocks = vi.hoisted(() => ({
  cancelAndWait: vi.fn(),
  getEntry: vi.fn(),
  putFolder: vi.fn(),
  unlinkAccount: vi.fn(),
  unlinkRoot: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('../sync-download-queue', () => ({
  cancelSyncDownloadsAndWait: mocks.cancelAndWait
}))
vi.mock('../sync-db', () => ({
  getSyncEntryByRemoteItem: mocks.getEntry
}))
vi.mock('../file-explorer-db', () => ({
  openFileExplorerDB: vi.fn(async () => ({ put: mocks.putFolder }))
}))
vi.mock('../sync-unlink', () => ({
  unlinkHhcLineAccountFromApp: mocks.unlinkAccount,
  unlinkSyncRootFolderFromApp: mocks.unlinkRoot,
  removeRevokedSyncItem: mocks.removeItem
}))

function root(
  id: string,
  connectionId: string,
  remoteFolderId: string,
  status: 'active' | 'access-revoked' = 'active'
): FolderRecord {
  return {
    id,
    name: id,
    parentId: 'file-root',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    syncLink: {
      providerConnectionId: connectionId,
      providerType: 'hhc-line',
      remoteFolderId,
      offlinePolicy: 'online-only',
      status
    }
  }
}

function auth(userId = 'user-a'): Pick<HhcLineCloudAuth, 'getSession' | 'endSession'> {
  return {
    getSession: () => ({ userId, displayName: userId, roles: ['media_sync_user'] }),
    endSession: vi.fn(async () => undefined)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useFileExplorerStore.setState({
    folders: {
      'root-a1': root('root-a1', 'hhc-line:user-a', 'collection-a1'),
      'root-a2': root('root-a2', 'hhc-line:user-a', 'collection-a2'),
      'root-b': root('root-b', 'hhc-line:user-b', 'collection-b'),
      onedrive: {
        ...root('onedrive', 'onedrive:user-a', 'onedrive-root'),
        syncLink: {
          providerConnectionId: 'onedrive:user-a',
          providerType: 'onedrive',
          remoteFolderId: 'onedrive-root'
        }
      }
    }
  })
  mocks.getEntry.mockResolvedValue({
    providerConnectionId: 'hhc-line:user-a',
    remoteItemId: 'item-a1',
    parentRemoteItemId: 'collection-a1'
  })
  mocks.cancelAndWait.mockResolvedValue(0)
  mocks.unlinkAccount.mockResolvedValue(undefined)
  mocks.unlinkRoot.mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { hhcAssets: { clearContentLeases: vi.fn(async () => undefined) } }
  })
})

describe('HHC LINE access owner', () => {
  it('ends the session once for terminal auth-required without refreshing again', async () => {
    const currentAuth = auth()

    await handleHhcLineAccessError(
      currentAuth,
      { kind: 'account', accountUserId: 'user-a' },
      new HhcAssetApiError('auth-required', 401)
    )

    expect(currentAuth.endSession).toHaveBeenCalledOnce()
    expect(mocks.unlinkAccount).not.toHaveBeenCalled()
  })

  it('cleans a stale account 403 by captured scope without ending the newer session', async () => {
    const currentAuth = {
      getSession: () => ({ userId: 'user-b', displayName: 'Grace', roles: [] }),
      getAuthGeneration: () => 1,
      endSession: vi.fn(async () => undefined)
    }

    await handleHhcLineAccessError(
      currentAuth,
      { kind: 'account', accountUserId: 'user-a' },
      new HhcAssetApiError('access-revoked', 403),
      { accountUserId: 'user-a', authGeneration: 0 }
    )

    expect(mocks.unlinkAccount).toHaveBeenCalledWith('user-a')
    expect(currentAuth.endSession).not.toHaveBeenCalled()
  })

  it('purges every HHC root for only the listed account after a list 403', async () => {
    await handleHhcLineAccessError(
      auth(),
      { kind: 'account', accountUserId: 'user-a' },
      new HhcAssetApiError('access-revoked', 403)
    )

    expect(mocks.unlinkAccount).toHaveBeenCalledWith('user-a')
    expect(mocks.unlinkAccount).toHaveBeenCalledOnce()
    expect(window.api.hhcAssets.clearContentLeases).not.toHaveBeenCalled()
    expect(mocks.unlinkRoot).not.toHaveBeenCalled()
  })

  it('does not purge every HHC root for an account-scoped 404', async () => {
    await handleHhcLineAccessError(
      auth(),
      { kind: 'account', accountUserId: 'user-a' },
      new HhcAssetApiError('access-revoked', 404)
    )

    expect(mocks.unlinkAccount).not.toHaveBeenCalled()
    expect(mocks.unlinkRoot).not.toHaveBeenCalled()
    expect(useFileExplorerStore.getState().folders['root-a1'].syncLink?.status).toBe('active')
  })

  it.each([403, 404] as const)(
    'marks and purges only the addressed root after an item-scoped %s',
    async (status) => {
      await handleHhcLineAccessError(
        auth(),
        {
          kind: 'root',
          providerConnectionId: 'hhc-line:user-a',
          remoteItemId: 'item-a1'
        },
        new HhcAssetApiError('access-revoked', status)
      )

      const folders = useFileExplorerStore.getState().folders
      expect(folders['root-a1'].syncLink?.status).toBe('access-revoked')
      expect(folders['root-a2'].syncLink?.status).toBe('active')
      expect(folders['root-b'].syncLink?.status).toBe('active')
      expect(folders.onedrive.syncLink?.providerType).toBe('onedrive')
      expect(mocks.putFolder).toHaveBeenCalledWith(
        'folder-records',
        expect.objectContaining({
          id: 'root-a1',
          syncLink: expect.objectContaining({ status: 'access-revoked' })
        })
      )
      expect(mocks.cancelAndWait).toHaveBeenCalledWith({
        providerConnectionId: 'hhc-line:user-a',
        rootRemoteFolderId: 'collection-a1'
      })
      expect(mocks.unlinkRoot).toHaveBeenCalledWith(expect.objectContaining({ id: 'root-a1' }))
      expect(window.api.hhcAssets.clearContentLeases).not.toHaveBeenCalled()
    }
  )

  it('preserves the root and cached state for retryable failures', async () => {
    await handleHhcLineAccessError(
      auth(),
      {
        kind: 'root',
        providerConnectionId: 'hhc-line:user-a',
        rootRemoteFolderId: 'collection-a1'
      },
      new HhcAssetApiError('retryable', 503)
    )

    expect(useFileExplorerStore.getState().folders['root-a1'].syncLink?.status).toBe('active')
    expect(mocks.putFolder).not.toHaveBeenCalled()
    expect(mocks.unlinkRoot).not.toHaveBeenCalled()
  })

  it('coalesces concurrent cleanup for the same account', async () => {
    let resolveCleanup!: () => void
    mocks.unlinkAccount.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCleanup = resolve
      })
    )

    const first = cleanupHhcLineAccountAccess('user-a')
    const second = cleanupHhcLineAccountAccess('user-a')
    expect(first).toBe(second)
    expect(mocks.unlinkAccount).toHaveBeenCalledOnce()

    resolveCleanup()
    await Promise.all([first, second])
  })

  it('waits for cancelled root work before unlinking persisted resources', async () => {
    let resolveCancelled!: () => void
    mocks.cancelAndWait.mockReturnValue(
      new Promise<number>((resolve) => {
        resolveCancelled = () => resolve(1)
      })
    )
    const cleanup = handleHhcLineAccessError(
      auth(),
      {
        kind: 'root',
        providerConnectionId: 'hhc-line:user-a',
        rootRemoteFolderId: 'collection-a1'
      },
      new HhcAssetApiError('access-revoked', 403)
    )
    await vi.waitFor(() => expect(mocks.cancelAndWait).toHaveBeenCalled())
    expect(mocks.unlinkRoot).not.toHaveBeenCalled()

    resolveCancelled()
    await cleanup
    expect(mocks.unlinkRoot).toHaveBeenCalledOnce()
  })

  it('requires the current account, live root, and active status at every queue guard', async () => {
    const currentAuth = auth()
    await expect(
      isHhcLineRootAuthorized(currentAuth, 'hhc-line:user-a', 'collection-a1')
    ).resolves.toBe(true)

    useFileExplorerStore.setState((state) => ({
      folders: {
        ...state.folders,
        'root-a1': root('root-a1', 'hhc-line:user-a', 'collection-a1', 'access-revoked')
      }
    }))
    await expect(
      isHhcLineRootAuthorized(currentAuth, 'hhc-line:user-a', 'collection-a1')
    ).resolves.toBe(false)
    await expect(
      isHhcLineRootAuthorized(auth('user-b'), 'hhc-line:user-a', 'collection-a1')
    ).resolves.toBe(false)
  })
})

it('removes expired item A without unlinking its collection or item B', async () => {
  await handleHhcLineAccessError(
    auth(),
    {
      kind: 'root',
      providerConnectionId: 'hhc-line:user-a',
      rootRemoteFolderId: 'collection-a1',
      remoteItemId: 'item-a1'
    },
    new HhcAssetApiError('access-revoked', 410, 'item-expired')
  )
  expect(mocks.removeItem).toHaveBeenCalledWith('hhc-line:user-a', 'item-a1')
  expect(mocks.unlinkRoot).not.toHaveBeenCalled()
  expect(useFileExplorerStore.getState().folders['root-a1'].syncLink?.status).toBe('active')
})
