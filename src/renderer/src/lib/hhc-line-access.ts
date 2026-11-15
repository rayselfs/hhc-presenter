import type { HhcSourceControl } from '@shared/hhc-assets'
import type { FolderRecord } from '@shared/types/folder'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import type { HhcLineCloudAuth } from './cloud-provider'
import { openFileExplorerDB } from './file-explorer-db'
import { cancelSyncDownloadsAndWait } from './sync-download-queue'
import { getSyncEntryByRemoteItem, listSyncTombstones } from './sync-db'
import {
  unlinkHhcLineAccountFromApp,
  unlinkSyncRootFolderFromApp,
  removeRevokedSyncItem
} from './sync-unlink'
import { getCurrentHhcSession } from './hhc-auth'

type HhcLineAccessScope =
  | { kind: 'account'; accountUserId: string }
  | {
      kind: 'root'
      providerConnectionId: string
      rootFolderId?: string
      rootRemoteFolderId?: string
      remoteItemId?: string
    }

type HhcLineAccessError = {
  classification?: unknown
  status?: unknown
  outcome?: unknown
}

export interface HhcLineAccessRequestAuth {
  accountUserId: string
  authGeneration: number
}

const accountCleanups = new Map<string, Promise<void>>()
const rootCleanups = new Map<string, Promise<void>>()

function updateRootStatus(root: FolderRecord): FolderRecord {
  const updated = {
    ...root,
    syncLink: root.syncLink ? { ...root.syncLink, status: 'access-revoked' as const } : undefined
  }
  useFileExplorerStore.setState((state) => {
    const folders = { ...state.folders, [updated.id]: updated }
    return {
      folders,
      _foldersArray: Object.values(folders),
      _childFoldersByParent: Object.fromEntries(
        Object.entries(state._childFoldersByParent).map(([parentId, children]) => [
          parentId,
          children.map((child) => (child.id === updated.id ? updated : child))
        ])
      )
    }
  })
  return updated
}

function findRoot(
  providerConnectionId: string,
  rootRemoteFolderId: string
): FolderRecord | undefined {
  return Object.values(useFileExplorerStore.getState().folders).find(
    (folder) =>
      folder.syncLink?.providerType === 'hhc-line' &&
      folder.syncLink.providerConnectionId === providerConnectionId &&
      folder.syncLink.remoteFolderId === rootRemoteFolderId
  )
}

async function resolveRootRemoteFolderId(
  scope: Extract<HhcLineAccessScope, { kind: 'root' }>
): Promise<string | undefined> {
  if (scope.rootRemoteFolderId) return scope.rootRemoteFolderId
  if (!scope.remoteItemId) return undefined
  const entry = await getSyncEntryByRemoteItem(scope.providerConnectionId, scope.remoteItemId)
  return entry?.parentRemoteItemId ?? (entry?.kind === 'folder' ? entry.remoteItemId : undefined)
}

export function cleanupHhcLineAccountAccess(accountUserId: string): Promise<void> {
  const existing = accountCleanups.get(accountUserId)
  if (existing) return existing
  const cleanup = unlinkHhcLineAccountFromApp(accountUserId).finally(() => {
    if (accountCleanups.get(accountUserId) === cleanup) accountCleanups.delete(accountUserId)
  })
  accountCleanups.set(accountUserId, cleanup)
  return cleanup
}

export async function revokeHhcLineRootAccess(
  scope: Extract<HhcLineAccessScope, { kind: 'root' }>
): Promise<void> {
  const rootById = scope.rootFolderId
    ? useFileExplorerStore.getState().folders[scope.rootFolderId]
    : undefined
  const rootRemoteFolderId =
    rootById?.syncLink?.remoteFolderId ?? (await resolveRootRemoteFolderId(scope))
  if (!rootRemoteFolderId) return
  const key = `${scope.providerConnectionId}\0${rootRemoteFolderId}`
  const existing = rootCleanups.get(key)
  if (existing) return existing

  const cleanup = (async () => {
    const root = rootById ?? findRoot(scope.providerConnectionId, rootRemoteFolderId)
    if (!root?.syncLink) return
    const revokedRoot = updateRootStatus(root)
    await (await openFileExplorerDB()).put('folder-records', revokedRoot)
    await cancelSyncDownloadsAndWait({
      providerConnectionId: scope.providerConnectionId,
      rootRemoteFolderId
    })
    await unlinkSyncRootFolderFromApp(revokedRoot)
  })().finally(() => {
    if (rootCleanups.get(key) === cleanup) rootCleanups.delete(key)
  })
  rootCleanups.set(key, cleanup)
  return cleanup
}

export async function handleHhcLineAccessError(
  auth: Pick<HhcLineCloudAuth, 'getSession' | 'getAuthGeneration' | 'endSession'>,
  scope: HhcLineAccessScope,
  error: unknown,
  requestAuth?: HhcLineAccessRequestAuth
): Promise<void> {
  const classified = error as HhcLineAccessError
  if (classified.classification === 'auth-required') {
    if (
      requestAuth &&
      (auth.getSession()?.userId !== requestAuth.accountUserId ||
        (auth.getAuthGeneration?.() ?? 0) !== requestAuth.authGeneration)
    ) {
      return
    }
    await auth.endSession()
    return
  }
  if (
    scope.kind === 'root' &&
    (classified.outcome === 'item-expired' || classified.outcome === 'item-revoked')
  ) {
    if (scope.remoteItemId)
      await removeRevokedSyncItem(scope.providerConnectionId, scope.remoteItemId)
    return
  }
  if (scope.kind === 'root' && classified.outcome === 'collection-revoked') {
    await revokeHhcLineRootAccess(scope)
    return
  }
  if (classified.classification !== 'access-revoked') return
  if (scope.kind === 'account') {
    if (classified.status === 403) await cleanupHhcLineAccountAccess(scope.accountUserId)
    return
  }
  if (classified.status !== 403 && classified.status !== 404) return
  await revokeHhcLineRootAccess(scope)
}

export async function isHhcLineRootAuthorized(
  auth: Pick<HhcLineCloudAuth, 'getSession'>,
  providerConnectionId: string,
  rootRemoteFolderId: string
): Promise<boolean> {
  const session = auth.getSession()
  if (!session || providerConnectionId !== `hhc-line:${session.userId}`) return false
  const link = findRoot(providerConnectionId, rootRemoteFolderId)?.syncLink
  return link?.status === 'active' && (!link.sourceControl || link.sourceControl.state === 'active')
}

export async function canCommitHhcLinePoster(
  providerConnectionId: string,
  rootRemoteFolderId: string
): Promise<boolean> {
  if (
    !(await isHhcLineRootAuthorized(
      { getSession: getCurrentHhcSession },
      providerConnectionId,
      rootRemoteFolderId
    ))
  ) {
    return false
  }
  return !(await listSyncTombstones()).some(
    (record) =>
      record.providerConnectionId === providerConnectionId &&
      record.remoteItemId === rootRemoteFolderId &&
      record.reason === 'unlink'
  )
}

export async function updateHhcSourceControl(
  connectionId: string,
  control: HhcSourceControl
): Promise<void> {
  const root = findRoot(connectionId, control.collectionId)
  if (!root?.syncLink) return
  if (JSON.stringify(root.syncLink.sourceControl) === JSON.stringify(control)) return
  const updated = { ...root, syncLink: { ...root.syncLink, sourceControl: control } }
  await (await openFileExplorerDB()).put('folder-records', updated)
  useFileExplorerStore.setState((state) => ({
    folders: { ...state.folders, [updated.id]: updated }
  }))
}
