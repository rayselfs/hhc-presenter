import { getBlobId } from '@renderer/lib/blob-identity'
import {
  loadEditablePresentation,
  type EditablePresentationAsset,
  type EditablePresentationDocument
} from '@renderer/lib/editable-presentation'
import { getMediaType, type MediaTypeStateMap } from '@renderer/lib/presentability'
import type { PresentationSnapshot } from '@renderer/lib/presentation-readiness'
import { isEditablePresentationMimeType } from '@renderer/lib/presentation-media'
import type { ProjectionPayload } from '@shared/projection-messages'
import type { FileItemRecord } from '@shared/types/folder'

export interface BuildFileProjectionPayloadInput {
  playlist: FileItemRecord[]
  currentIndex: number
  snapshot?: PresentationSnapshot | null
  typeStates?: Partial<{ [K in keyof MediaTypeStateMap]: MediaTypeStateMap[K] }>
}

function buildEditableSlide(
  document: EditablePresentationDocument,
  slideIndex: number
): NonNullable<ProjectionPayload<'file:show'>['editablePresentation']> | null {
  const slideId = document.slideOrder[slideIndex]
  const slide = slideId ? document.slides[slideId] : undefined
  if (!slide) return null

  const assets: Record<string, EditablePresentationAsset> = {}
  for (const elementId of slide.elementOrder) {
    const element = slide.elements[elementId]
    if (element?.type !== 'image') continue
    const asset = document.assets[element.assetId]
    if (asset) assets[asset.id] = asset
  }

  return {
    width: document.width,
    height: document.height,
    slide,
    assets
  }
}

export function buildEditableSlideProjectionPayload(
  base: ProjectionPayload<'file:show'>,
  document: EditablePresentationDocument,
  activeSlideId: string
): ProjectionPayload<'file:show'> {
  const requestedIndex = document.slideOrder.indexOf(activeSlideId)
  const slideIndex = requestedIndex >= 0 ? requestedIndex : 0
  const editablePresentation = buildEditableSlide(document, slideIndex)
  if (!editablePresentation) return base

  return {
    ...base,
    presentation: { slideIndex, slideCount: document.slideOrder.length },
    editablePresentation
  }
}

export function buildFileProjectionPayload({
  playlist,
  currentIndex,
  snapshot,
  typeStates
}: BuildFileProjectionPayloadInput): ProjectionPayload<'file:show'> | null {
  const item = playlist[currentIndex]
  if (!item) return null

  const snapshotEntry = snapshot?.entries.find((entry) => entry.itemId === item.id)
  const blobId = snapshotEntry?.blobId ?? getBlobId(item)
  const presentation =
    getMediaType(item.mimeType) === 'presentation'
      ? (typeStates?.presentation ?? { slideIndex: 0 })
      : undefined

  const payload: ProjectionPayload<'file:show'> = {
    itemId: item.id,
    blobId,
    fileName: item.name,
    mimeType: item.mimeType,
    playlist: playlist.map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType
    })),
    currentIndex,
    playbackMode: snapshotEntry?.playbackMode,
    playbackVariant: snapshotEntry?.playbackVariant,
    seekable: snapshotEntry?.seekable,
    durationMs: snapshotEntry?.durationMs
  }
  if (snapshotEntry?.sourceUrl && snapshotEntry.sourceUrl !== item.url) {
    payload.streamUrl = snapshotEntry.sourceUrl
  }
  if (item.mimeType === 'application/pdf') {
    const pdf = typeStates?.pdf
    payload.pdf = {
      page: pdf?.itemId === item.id ? (pdf.currentPage ?? 1) : 1,
      scroll: pdf?.itemId === item.id ? (pdf.scrollPage ?? 0) : 0,
      viewMode: pdf?.viewMode === 'scroll' ? 'continuous' : 'single'
    }
  }
  if (presentation) payload.presentation = presentation
  return payload
}

export async function buildFileProjectionPayloadWithEditableSlide(
  input: BuildFileProjectionPayloadInput
): Promise<ProjectionPayload<'file:show'> | null> {
  const payload = buildFileProjectionPayload(input)
  const item = input.playlist[input.currentIndex]
  if (!payload || !item || !isEditablePresentationMimeType(item.mimeType)) return payload

  const document = await loadEditablePresentation(item)
  const requestedIndex = payload.presentation?.slideIndex ?? 0
  const slideIndex = Math.max(
    0,
    Math.min(requestedIndex, Math.max(0, document.slideOrder.length - 1))
  )
  const activeSlideId = document.slideOrder[slideIndex] ?? ''
  return buildEditableSlideProjectionPayload(payload, document, activeSlideId)
}
