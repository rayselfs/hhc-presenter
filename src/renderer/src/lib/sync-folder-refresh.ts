import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import {
  getCloudProviderAdapter,
  type CloudProviderId,
  type HhcLineCloudAuth
} from './cloud-provider'
import { isElectron } from './env'
import { refreshLocalSyncConnection } from './local-sync-import'

export const NAVIGATION_REFRESH_COOLDOWN_MS = 30_000

const navigationRefreshInFlight = new Set<string>()
const lastNavigationRefreshAt = new Map<string, number>()

function isCloudProviderId(value: string): value is CloudProviderId {
  return value === 'onedrive' || value === 'hhc-line'
}

export async function refreshSyncFolderOnNavigation(
  rootFolderId: string,
  hhcAuth?: HhcLineCloudAuth
): Promise<void> {
  if (navigationRefreshInFlight.has(rootFolderId)) return

  const folder = useFileExplorerStore.getState().folders[rootFolderId]
  const syncLink = folder?.syncLink
  if (!syncLink) return

  const now = Date.now()
  const lastRefreshAt = lastNavigationRefreshAt.get(rootFolderId)
  if (typeof lastRefreshAt === 'number' && now - lastRefreshAt < NAVIGATION_REFRESH_COOLDOWN_MS) {
    return
  }

  lastNavigationRefreshAt.set(rootFolderId, now)
  navigationRefreshInFlight.add(rootFolderId)
  try {
    if (syncLink.providerType === 'local-fs') {
      if (isElectron()) await refreshLocalSyncConnection(syncLink.providerConnectionId)
      return
    }
    if (syncLink.providerType === 'hhc-share') {
      if (hhcAuth) await (await import('./personal-share-sync')).reconcilePersonalShares(hhcAuth)
      return
    }
    if (isCloudProviderId(syncLink.providerType)) {
      await getCloudProviderAdapter(syncLink.providerType, hhcAuth).refreshFolder(rootFolderId)
    }
  } catch (error) {
    console.warn('[sync] Failed to refresh sync folder on navigation', {
      rootFolderId,
      error
    })
  } finally {
    navigationRefreshInFlight.delete(rootFolderId)
  }
}

export function resetSyncFolderRefreshForTests(): void {
  navigationRefreshInFlight.clear()
  lastNavigationRefreshAt.clear()
}
