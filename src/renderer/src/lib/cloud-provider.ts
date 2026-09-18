import type { FileItemRecord } from '@shared/types/folder'
import type { HhcSession } from '@shared/hhc-auth'
import type { ProviderConnectionRecord } from './sync-db'
import { getProviderConnection, getSyncEntryByLocalItem } from './sync-db'
import {
  ensureOneDriveItemAvailableForPresentation,
  getConnectedOneDriveAccount,
  importOneDriveFolder,
  listOneDriveFolders,
  refreshOneDriveFolder
} from './onedrive-connect'

export type CloudProviderId = 'onedrive' | 'hhc-line'

export interface HhcLineCloudAuth {
  getSession(): HhcSession | null
  getAuthGeneration?(): number
  getAccessToken(): Promise<string | null>
  refreshAfterUnauthorized(rejectedToken: string): Promise<string | null>
  endSession(): Promise<void>
}

export interface CloudRemoteFolder {
  remoteItemId: string
  name: string
  parentRemoteItemId: string | null
}

export interface CloudImportResult {
  connectionId: string
  displayName: string
  folderCount: number
  itemCount: number
  downloadedCount: number
  disabledCount: number
}

export interface CloudRefreshSummary {
  connectionId: string
  rootFolderId: string
  updatedItemCount: number
  removedItemCount: number
  removedFolderCount: number
  downloadedCount: number
  failedFileCount: number
  disabledFileCount: number
  changedCount?: number
  pendingFileCount?: number
  retryableFileCount?: number
  nextRetryAt?: number
  usedCursor?: boolean
  fullScanFallback?: boolean
}

export interface CloudProviderAdapter {
  id: CloudProviderId
  supportsFolderNavigation?: boolean
  getConnectedAccount(): Promise<ProviderConnectionRecord | null>
  listFolders(parentRemoteFolderId?: string): Promise<CloudRemoteFolder[]>
  importFolder(folder: CloudRemoteFolder): Promise<CloudImportResult>
  refreshFolder(
    rootFolderId: string,
    options?: { forceRetry?: boolean }
  ): Promise<CloudRefreshSummary>
}

const ONEDRIVE_ADAPTER: CloudProviderAdapter = {
  id: 'onedrive',
  getConnectedAccount: getConnectedOneDriveAccount,
  listFolders: listOneDriveFolders,
  importFolder: importOneDriveFolder,
  refreshFolder: refreshOneDriveFolder
}

export function getCloudProviderAdapter(
  providerId: CloudProviderId,
  hhcAuth?: HhcLineCloudAuth
): CloudProviderAdapter {
  if (providerId === 'onedrive') return ONEDRIVE_ADAPTER
  if (providerId === 'hhc-line' && hhcAuth) {
    return {
      id: 'hhc-line',
      supportsFolderNavigation: false,
      getConnectedAccount: async () =>
        (await import('./hhc-line-connect')).getConnectedHhcLineAccount(hhcAuth),
      listFolders: async () => (await import('./hhc-line-connect')).listHhcLineCollections(hhcAuth),
      importFolder: async (folder) =>
        (await import('./hhc-line-connect')).importHhcLineCollection(hhcAuth, folder),
      refreshFolder: async (rootFolderId, options) =>
        (await import('./hhc-line-connect')).refreshHhcLineFolder(hhcAuth, rootFolderId, options)
    }
  }
  throw new Error(`Unsupported cloud provider: ${providerId}`)
}

export async function ensureSyncItemAvailableForPresentation(
  item: FileItemRecord
): Promise<boolean> {
  const entry = await getSyncEntryByLocalItem(item.id)
  if (!entry || entry.status === 'available-offline') return true
  const connection = await getProviderConnection(entry.providerConnectionId)
  if (connection?.providerType === 'onedrive') {
    return ensureOneDriveItemAvailableForPresentation(item)
  }
  return false
}
