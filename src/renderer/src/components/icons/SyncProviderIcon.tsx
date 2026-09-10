import { FolderSync, UsersRound } from 'lucide-react'
import type { SyncProviderType } from '@shared/types/folder'
import { LineBrandIcon } from './LineBrandIcon'
import { OneDriveIcon } from './OneDriveIcon'

export interface SyncProviderIconProps {
  providerType: SyncProviderType
  className?: string
}

export function SyncProviderIcon({
  providerType,
  className
}: SyncProviderIconProps): React.JSX.Element {
  if (providerType === 'onedrive') return <OneDriveIcon className={className} />
  if (providerType === 'hhc-line') return <LineBrandIcon className={className} />
  if (providerType === 'hhc-share') return <UsersRound className={className} />
  return <FolderSync className={className} />
}
