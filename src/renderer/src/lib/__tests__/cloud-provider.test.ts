import { describe, expect, it, vi } from 'vitest'
import type { HhcSession } from '@shared/hhc-auth'
import { getCloudProviderAdapter } from '../cloud-provider'

const hhcLineMocks = vi.hoisted(() => ({
  getConnectedAccount: vi.fn(),
  importCollection: vi.fn(),
  listCollections: vi.fn(),
  refreshFolder: vi.fn()
}))

vi.mock('../onedrive-connect', () => ({
  getConnectedOneDriveAccount: vi.fn(async () => ({ id: 'onedrive:account-1' })),
  importOneDriveFolder: vi.fn(async () => ({ connectionId: 'onedrive:account-1' })),
  refreshOneDriveFolder: vi.fn(async () => ({ connectionId: 'onedrive:account-1' })),
  listOneDriveFolders: vi.fn(async () => [])
}))

vi.mock('../hhc-line-connect', () => ({
  getConnectedHhcLineAccount: hhcLineMocks.getConnectedAccount,
  importHhcLineCollection: hhcLineMocks.importCollection,
  listHhcLineCollections: hhcLineMocks.listCollections,
  refreshHhcLineFolder: hhcLineMocks.refreshFolder
}))

describe('cloud provider adapter', () => {
  it('exposes OneDrive through the shared cloud provider boundary', async () => {
    const adapter = getCloudProviderAdapter('onedrive')

    await expect(adapter.getConnectedAccount()).resolves.toMatchObject({
      id: 'onedrive:account-1'
    })
    await expect(adapter.listFolders('root')).resolves.toEqual([])
  })

  it('loads HHC LINE operations only through the authorized literal branch', async () => {
    const session: HhcSession = {
      userId: 'user-1',
      displayName: 'Ada',
      roles: ['media_sync_user']
    }
    const auth = {
      getSession: () => session,
      getAccessToken: vi.fn(async () => 'access-token'),
      refreshAfterUnauthorized: vi.fn(async () => 'refresh-token'),
      endSession: vi.fn(async () => undefined)
    }
    hhcLineMocks.listCollections.mockResolvedValueOnce([
      { remoteItemId: 'collection-1', name: 'Sunday', parentRemoteItemId: null }
    ])
    const adapter = getCloudProviderAdapter('hhc-line', auth)

    await expect(adapter.listFolders()).resolves.toEqual([
      { remoteItemId: 'collection-1', name: 'Sunday', parentRemoteItemId: null }
    ])
    expect(hhcLineMocks.listCollections).toHaveBeenCalledWith(auth)
  })
})
