import type { FolderRecord } from '@shared/types/folder'
import { openFileExplorerDB } from './file-explorer-db'

const connectionRevisions = new Map<string, number>()
const rootRevisions = new Map<string, number>()

export function invalidateSyncRefresh(connectionId: string, rootId?: string): void {
  const revisions = rootId ? rootRevisions : connectionRevisions
  const key = rootId ?? connectionId
  revisions.set(key, (revisions.get(key) ?? 0) + 1)
}

export async function withSyncConnectionMutation<T>(
  connectionId: string,
  operation: () => Promise<T>
): Promise<T> {
  return await navigator.locks.request(`hhc-sync-connection:${connectionId}`, operation)
}

export function isSameActiveSyncRoot(
  current: FolderRecord | undefined,
  expected: FolderRecord
): boolean {
  return Boolean(
    current &&
    current.id === expected.id &&
    current.createdAt === expected.createdAt &&
    current.deletedAt == null &&
    current.syncLink &&
    expected.syncLink &&
    current.syncLink.status !== 'access-revoked' &&
    current.syncLink.providerType === expected.syncLink.providerType &&
    current.syncLink.providerConnectionId === expected.syncLink.providerConnectionId &&
    current.syncLink.remoteFolderId === expected.syncLink.remoteFolderId
  )
}

export function createSyncRefreshGuard(root: FolderRecord): () => Promise<boolean> {
  const connectionId = root.syncLink!.providerConnectionId
  const connectionRevision = connectionRevisions.get(connectionId) ?? 0
  const rootRevision = rootRevisions.get(root.id) ?? 0
  const isCurrent = (): boolean =>
    connectionRevision === (connectionRevisions.get(connectionId) ?? 0) &&
    rootRevision === (rootRevisions.get(root.id) ?? 0)
  return async () => {
    if (!isCurrent()) return false
    const db = await openFileExplorerDB()
    const current = await db.get('folder-records', root.id)
    return isCurrent() && isSameActiveSyncRoot(current, root)
  }
}
