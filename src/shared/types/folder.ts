export type SyncProviderType = 'local-fs' | 'onedrive' | 'hhc-line' | 'hhc-share'
export type SyncOfflinePolicy = 'online-only' | 'on-demand' | 'always-offline'

export interface FolderSyncLink {
  providerConnectionId: string
  remoteFolderId: string
  providerType: SyncProviderType
  offlinePolicy?: SyncOfflinePolicy
  status?: 'active' | 'access-revoked'
}

export interface FolderRecord {
  personalOwnerId?: string
  sharedRecipientId?: string
  id: string
  name: string
  parentId: string | null
  sortIndex: number
  createdAt: number
  expiresAt: number | null
  isFavorited?: boolean
  deletedAt?: number
  originalParentId?: string
  syncLink?: FolderSyncLink
}

export interface ItemRecord {
  personalOwnerId?: string
  sharedRecipientId?: string
  id: string
  parentId: string
  type: 'verse' | 'file'
  sortIndex: number
  createdAt: number
  expiresAt: number | null
  deletedAt?: number
  originalParentId?: string
}

export interface VerseItemRecord extends ItemRecord {
  type: 'verse'
  versionId: number
  bookNumber: number
  chapter: number
  verse: number
  text: string
}

export interface FileItemRecord extends ItemRecord {
  type: 'file'
  name: string
  url: string
  size: number
  mimeType: string
  notes?: string
}

export type AnyItemRecord = VerseItemRecord | FileItemRecord

export type FileExplorerViewMode =
  | 'extra-large-icon'
  | 'large-icon'
  | 'medium-icon'
  | 'small-icon'
  | 'list'

export type VerseItem = VerseItemRecord
export type FileItem = FileItemRecord
export type FolderItem = ItemRecord

export interface FolderStoreConfig {
  isVisible?: (record: FolderRecord | AnyItemRecord) => boolean
  rootId: string
  rootName: string
  getDB: () => Promise<unknown>
}

export type FolderDuration = '1day' | '1week' | '1month' | 'permanent'

export const FOLDER_DURATION_MS: Record<Exclude<FolderDuration, 'permanent'>, number> = {
  '1day': 86_400_000,
  '1week': 604_800_000,
  '1month': 2_592_000_000
}

export function computeExpiresAt(duration: FolderDuration): number | null {
  if (duration === 'permanent') return null
  return Date.now() + FOLDER_DURATION_MS[duration]
}

export function inferDuration(
  expiresAt: number | null | undefined,
  createdAt: number
): FolderDuration {
  if (expiresAt == null) return 'permanent'
  const diff = expiresAt - createdAt
  const entries = Object.entries(FOLDER_DURATION_MS) as [
    Exclude<FolderDuration, 'permanent'>,
    number
  ][]
  let closest: FolderDuration = '1day'
  let minDiff = Infinity
  for (const [key, ms] of entries) {
    const d = Math.abs(diff - ms)
    if (d < minDiff) {
      minDiff = d
      closest = key
    }
  }
  return closest
}

export function isVerseItem(item: ItemRecord): item is VerseItemRecord {
  return item.type === 'verse'
}

export function isFileItem(item: ItemRecord): item is FileItemRecord {
  return item.type === 'file'
}

export function isFolderRecord(node: unknown): node is FolderRecord {
  return (
    typeof node === 'object' &&
    node !== null &&
    'name' in node &&
    'parentId' in node &&
    !('type' in node)
  )
}
