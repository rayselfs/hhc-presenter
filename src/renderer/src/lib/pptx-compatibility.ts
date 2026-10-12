import type { PptxFiles, PresentationData } from '@aiden0z/pptx-renderer'
import type { EditablePresentationDocument } from './editable-presentation'
import { validatePptxPackage } from './pptx-source'

export type PptxCompatibilityCode =
  | 'invalid-package'
  | 'no-slides'
  | 'animation'
  | 'transition'
  | 'media'
  | 'color-mapping'
  | 'unsupported-object'
  | 'shape'
  | 'text'
  | 'image'
  | 'background'
  | 'layout'
  | 'invalid-content'

export interface PptxCompatibilityDiagnostic {
  code: PptxCompatibilityCode
  slideNumber?: number
  objectNumber?: number
  sourcePart?: string
  objectId?: string
}

export class PptxCompatibilityError extends Error {
  constructor(
    readonly diagnostic: PptxCompatibilityDiagnostic,
    message = 'Unable to create an editable presentation',
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'PptxCompatibilityError'
  }
}

export function locatePptxCompatibilityError(
  error: unknown,
  location: Omit<PptxCompatibilityDiagnostic, 'code'>,
  fallbackCode: PptxCompatibilityCode = 'invalid-content'
): PptxCompatibilityError {
  return new PptxCompatibilityError(
    {
      ...location,
      ...(error instanceof PptxCompatibilityError ? error.diagnostic : { code: fallbackCode })
    },
    error instanceof Error ? error.message : undefined,
    { cause: error }
  )
}

export async function assertEditablePptxPackage(buffer: ArrayBuffer): Promise<void> {
  try {
    await validatePptxPackage(buffer)
  } catch (error) {
    throw locatePptxCompatibilityError(error, {}, 'invalid-package')
  }
}

export function assertEditablePptxFeatures(files: PptxFiles, presentation: PresentationData): void {
  const drawingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/main'
  const presentationNamespace = 'http://schemas.openxmlformats.org/presentationml/2006/main'
  const sources = new Map<string, { xml: string; slideNumber: number }>()
  for (const [index, slide] of presentation.slides.entries()) {
    const layoutId = slide.layoutIndex
    const masterId = presentation.layoutToMaster.get(layoutId)
    for (const [path, xml] of [
      [slide.slidePath, files.slides.get(slide.slidePath)],
      [layoutId, files.slideLayouts.get(layoutId)],
      [masterId, masterId ? files.slideMasters.get(masterId) : undefined]
    ]) {
      if (path && xml && !sources.has(path)) sources.set(path, { xml, slideNumber: index + 1 })
    }
  }
  for (const [path, { xml, slideNumber }] of sources) {
    const root = new DOMParser().parseFromString(xml, 'application/xml')
    if (root.getElementsByTagName('parsererror').length)
      throw new PptxCompatibilityError(
        { code: 'invalid-package', sourcePart: path, slideNumber },
        'Invalid PowerPoint XML'
      )
    const has = (namespace: string, name: string): boolean =>
      root.getElementsByTagNameNS(namespace, name).length > 0
    if (has(presentationNamespace, 'timing'))
      throw new PptxCompatibilityError(
        { code: 'animation', sourcePart: path, slideNumber },
        'PowerPoint animation is not supported for editable import'
      )
    if (has(presentationNamespace, 'transition'))
      throw new PptxCompatibilityError(
        { code: 'transition', sourcePart: path, slideNumber },
        'PowerPoint transitions are not supported for editable import'
      )
    const slide = presentation.slides.find((entry) => entry.slidePath === path)
    if (slide) {
      const layout = presentation.layouts.get(slide.layoutIndex)
      const masterId = presentation.layoutToMaster.get(slide.layoutIndex)
      const master = masterId ? presentation.masters.get(masterId) : undefined
      const mapping = new Map([
        ['bg1', 'lt1'],
        ['tx1', 'dk1'],
        ['bg2', 'lt2'],
        ['tx2', 'dk2'],
        ...(master?.colorMap ?? []),
        ...(layout?.colorMapOverride ?? [])
      ])
      for (const override of root.getElementsByTagNameNS(drawingNamespace, 'overrideClrMapping')) {
        if (
          Array.from(override.attributes).some(
            (attribute) =>
              attribute.namespaceURI === null &&
              attribute.value !== (mapping.get(attribute.localName) ?? attribute.localName)
          )
        )
          throw new PptxCompatibilityError(
            { code: 'color-mapping', sourcePart: path, slideNumber },
            'PowerPoint slide color mapping overrides are not supported for editable import'
          )
      }
    }
    if (
      ['audioFile', 'videoFile', 'quickTimeFile', 'wavAudioFile'].some((name) =>
        has(drawingNamespace, name)
      ) ||
      has(presentationNamespace, 'snd') ||
      has('http://schemas.microsoft.com/office/powerpoint/2010/main', 'media')
    )
      throw new PptxCompatibilityError(
        { code: 'media', sourcePart: path, slideNumber },
        'PowerPoint audio/video media is not supported for editable import'
      )
  }
}

export function assertEditablePptxDocument(
  document: EditablePresentationDocument,
  presentation: PresentationData
): void {
  if (!document.slideOrder.length)
    throw new PptxCompatibilityError({ code: 'no-slides' }, 'The presentation contains no slides')
  for (const [index, slideId] of document.slideOrder.entries()) {
    const slide = document.slides[slideId]
    const objectIndex = slide.elementOrder.findIndex((id) => slide.elements[id].type === 'locked')
    if (objectIndex !== -1)
      throw new PptxCompatibilityError(
        {
          code: 'unsupported-object',
          slideNumber: index + 1,
          objectNumber: objectIndex + 1,
          sourcePart: presentation.slides[index].slidePath
        },
        'This presentation contains objects that cannot yet be edited. The original PPTX has not been changed.'
      )
  }
}
