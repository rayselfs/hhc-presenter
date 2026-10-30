import {
  insertBlankEditableSlide,
  type EditablePresentationAsset,
  type EditablePresentationDocument,
  type EditablePresentationSlide,
  type EditablePresentationTheme
} from './editable-presentation'

export interface PresentationSlideClipboard {
  slides: EditablePresentationSlide[]
  assets: Record<string, EditablePresentationAsset>
  themes: Record<string, EditablePresentationTheme>
}

export function createSlideClipboard(
  document: EditablePresentationDocument,
  selectedSlideIds: Iterable<string>
): PresentationSlideClipboard {
  const selected = new Set(selectedSlideIds)
  const slides = document.slideOrder
    .filter((id) => selected.has(id))
    .flatMap((id) => (document.slides[id] ? [structuredClone(document.slides[id])] : []))
  const assetIds = new Set(
    slides.flatMap((slide) =>
      slide.elementOrder.flatMap((id) => {
        const element = slide.elements[id]
        return element?.type === 'image' ? [element.assetId] : []
      })
    )
  )
  const themeIds = new Set(slides.flatMap((slide) => (slide.themeId ? [slide.themeId] : [])))
  return {
    slides,
    assets: Object.fromEntries(
      [...assetIds].flatMap((id) =>
        document.assets[id] ? [[id, structuredClone(document.assets[id])]] : []
      )
    ),
    themes: Object.fromEntries(
      [...themeIds].flatMap((id) =>
        document.themes?.[id] ? [[id, structuredClone(document.themes[id])]] : []
      )
    )
  }
}

export function pasteSlideClipboard(
  document: EditablePresentationDocument,
  clipboard: PresentationSlideClipboard,
  insertionIndex: number
): { document: EditablePresentationDocument; slideIds: string[] } {
  const assets = { ...document.assets }
  const assetIds = new Map<string, string>()
  for (const [sourceId, asset] of Object.entries(clipboard.assets)) {
    const existing = assets[sourceId]
    const destinationId =
      !existing || JSON.stringify(existing) === JSON.stringify(asset)
        ? sourceId
        : crypto.randomUUID()
    assetIds.set(sourceId, destinationId)
    assets[destinationId] = { ...structuredClone(asset), id: destinationId }
  }

  const themes = { ...document.themes }
  const themeIds = new Map<string, string>()
  for (const [sourceId, theme] of Object.entries(clipboard.themes)) {
    const existing = themes[sourceId]
    const destinationId =
      !existing || JSON.stringify(existing) === JSON.stringify(theme)
        ? sourceId
        : crypto.randomUUID()
    themeIds.set(sourceId, destinationId)
    themes[destinationId] = { ...structuredClone(theme), id: destinationId }
  }

  const slides = { ...document.slides }
  const slideIds = clipboard.slides.map((sourceSlide) => {
    const slideId = crypto.randomUUID()
    const elementIds = new Map(sourceSlide.elementOrder.map((id) => [id, crypto.randomUUID()]))
    const elements = Object.fromEntries(
      sourceSlide.elementOrder.flatMap((sourceId) => {
        const element = sourceSlide.elements[sourceId]
        const elementId = elementIds.get(sourceId)
        if (!element || !elementId) return []
        const next = { ...structuredClone(element), id: elementId }
        delete next.pptxSourceNode
        if (next.type === 'image') next.assetId = assetIds.get(next.assetId) ?? next.assetId
        return [[elementId, next]]
      })
    )
    slides[slideId] = {
      ...structuredClone(sourceSlide),
      id: slideId,
      themeId: sourceSlide.themeId
        ? (themeIds.get(sourceSlide.themeId) ?? sourceSlide.themeId)
        : undefined,
      elementOrder: sourceSlide.elementOrder.flatMap((id) => elementIds.get(id) ?? []),
      elements
    }
    delete slides[slideId].pptxSourcePart
    return slideId
  })
  const safeIndex = Math.max(0, Math.min(insertionIndex, document.slideOrder.length))
  return {
    document: {
      ...document,
      slideOrder: [
        ...document.slideOrder.slice(0, safeIndex),
        ...slideIds,
        ...document.slideOrder.slice(safeIndex)
      ],
      slides,
      assets,
      themes,
      updatedAt: Date.now()
    },
    slideIds
  }
}

export function cutSlides(
  document: EditablePresentationDocument,
  selectedSlideIds: Iterable<string>
): EditablePresentationDocument {
  const selected = new Set(selectedSlideIds)
  const remaining = document.slideOrder.filter((id) => !selected.has(id))
  if (remaining.length === 0) {
    const empty = insertBlankEditableSlide({ ...document, slideOrder: [], slides: {} }, 0)
    return empty.document
  }
  return {
    ...document,
    slideOrder: remaining,
    slides: Object.fromEntries(Object.entries(document.slides).filter(([id]) => !selected.has(id))),
    updatedAt: Date.now()
  }
}
