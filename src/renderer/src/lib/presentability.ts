import { groupItemsByDate } from './file-explorer-grouping'
import type { AnyItemRecord, FileItemRecord } from '@shared/types/folder'
import { isFileItem } from '@shared/types/folder'
import type { FilePlaybackPhase, VideoPreparationPhase } from '@shared/projection-messages'
import {
  getMediaSupport,
  resolveMediaCapability,
  type MediaPlatform,
  type MediaSupportMode
} from './media-capabilities'
import { isElectron } from './env'

export type MediaTypeStateMap = {
  image: Record<string, never>
  video: {
    phase?: FilePlaybackPhase
    preparationPhase?: VideoPreparationPhase
    hasStarted?: boolean
    isPlaying?: boolean
    isEnded?: boolean
    currentTime?: number
    duration?: number
    seekable?: boolean
    volume?: number
  }
  pdf: {
    viewMode: 'slide' | 'scroll'
    thumbsCollapsed?: boolean
    itemId?: string
    currentPage?: number
    scrollPage?: number
  }
  presentation: { slideIndex: number; slideCount?: number }
}

export type MediaType = keyof MediaTypeStateMap

function getPresentabilityPlatform(): MediaPlatform {
  return isElectron() ? 'electron' : 'web'
}

function canPresentSupport(support: MediaSupportMode): boolean {
  return support === 'native' || support === 'desktop-engine'
}

function projectionMediaType(kind: string): MediaType | null {
  if (kind === 'audio') return 'video'
  if (kind === 'image' || kind === 'video' || kind === 'pdf' || kind === 'presentation') return kind
  return null
}

export function isPresentable(mimeType: string, platform = getPresentabilityPlatform()): boolean {
  const capability = resolveMediaCapability({ mimeType })
  return (
    capability !== null &&
    projectionMediaType(capability.kind) !== null &&
    canPresentSupport(getMediaSupport(capability, platform))
  )
}

export function getMediaType(
  mimeType: string,
  platform = getPresentabilityPlatform()
): MediaType | null {
  const capability = resolveMediaCapability({ mimeType })
  if (
    !capability ||
    !projectionMediaType(capability.kind) ||
    !canPresentSupport(getMediaSupport(capability, platform))
  ) {
    return null
  }
  return projectionMediaType(capability.kind)
}

export function getPresentableItems(
  items: AnyItemRecord[],
  platform = getPresentabilityPlatform()
): FileItemRecord[] {
  return items.filter(
    (item): item is FileItemRecord =>
      isFileItem(item) &&
      !item.url.startsWith('unsupported:') &&
      isPresentable(item.mimeType, platform)
  )
}

export function getProjectionPlaylist(
  items: AnyItemRecord[],
  requestedItem?: FileItemRecord,
  platform = getPresentabilityPlatform(),
  groupTimezone?: string
): FileItemRecord[] {
  const presentable = getPresentableItems(items, platform)
  if (requestedItem && getMediaType(requestedItem.mimeType, platform) === 'presentation') {
    return presentable.filter((item) => item.id === requestedItem.id)
  }
  const playlist = presentable.filter(
    (item) => getMediaType(item.mimeType, platform) !== 'presentation'
  )
  if (!groupTimezone) return playlist
  const grouped = groupItemsByDate(playlist, groupTimezone, 'desc')
  const targetId = requestedItem?.id ?? playlist[0]?.id
  const target = grouped.find((item) => item.id === targetId)
  return target ? grouped.filter((item) => item.dateGroup === target.dateGroup) : []
}
