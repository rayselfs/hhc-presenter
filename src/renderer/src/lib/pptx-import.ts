import type { PptxFiles, PresentationData } from '@aiden0z/pptx-renderer'
import { isFileItem, type FileItemRecord } from '@shared/types/folder'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { convertPresentationData, createEditablePresentationItem } from './editable-presentation'
import { openFileExplorerDB } from './file-explorer-db'
import { resolveUniqueFileName } from './file-naming'
import { PPTX_MIME_TYPE } from './presentation-media'
import { validatePortablePresentation } from './portable-presentation'

let pendingCatalogCreation: Promise<unknown> = Promise.resolve()

export async function importEditablePptx(file: File, parentId: string): Promise<FileItemRecord> {
  const ownerId = usePersonalSyncStore.getState().activeOwnerId
  const { parseZip, buildPresentation, materializeAllSlideNodes, RECOMMENDED_ZIP_LIMITS } =
    await import('@aiden0z/pptx-renderer')
  const files = await parseZip(await file.arrayBuffer(), RECOMMENDED_ZIP_LIMITS)
  const presentation = buildPresentation(files)
  assertEditablePptxFeatures(files, presentation)
  materializeAllSlideNodes(presentation)
  const source: FileItemRecord = {
    id: crypto.randomUUID(),
    parentId,
    type: 'file',
    sortIndex: 0,
    createdAt: Date.now(),
    expiresAt: null,
    name: file.name,
    url: '',
    size: file.size,
    mimeType: PPTX_MIME_TYPE
  }
  const document = convertPresentationData(source, presentation)
  if (!document.slideOrder.length) throw new Error('The presentation contains no slides')
  if (
    Object.values(document.slides).some((slide) =>
      Object.values(slide.elements).some((element) => element.type === 'locked')
    )
  ) {
    throw new Error(
      'This presentation contains objects that cannot yet be edited. The original PPTX has not been changed.'
    )
  }
  // Name resolution and persistence must stay together when upload workers finish concurrently.
  const creation = pendingCatalogCreation.then(async () => {
    const db = await openFileExplorerDB()
    const siblings = await db.getAllFromIndex('folder-items', 'by-parent', parentId)
    const name = resolveUniqueFileName(
      `${file.name.replace(/\.pptx$/i, '')}.lpdeck`,
      siblings
        .filter(isFileItem)
        .filter((item) => !item.deletedAt)
        .map((item) => item.name)
    )
    document.name = name.replace(/\.lpdeck$/, '')
    delete document.sourceItemId
    delete document.sourceBlobId
    validatePortablePresentation(document)
    if (ownerId !== usePersonalSyncStore.getState().activeOwnerId)
      throw new Error('Personal account changed')
    return createEditablePresentationItem(document, parentId, name)
  })
  pendingCatalogCreation = creation.catch(() => undefined)
  return creation
}

function assertEditablePptxFeatures(files: PptxFiles, presentation: PresentationData): void {
  const drawingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/main'
  const presentationNamespace = 'http://schemas.openxmlformats.org/presentationml/2006/main'
  const sources = new Map<string, string>()
  for (const slide of presentation.slides) {
    const layoutId = slide.layoutIndex
    const masterId = presentation.layoutToMaster.get(layoutId)
    for (const [path, xml] of [
      [slide.slidePath, files.slides.get(slide.slidePath)],
      [layoutId, files.slideLayouts.get(layoutId)],
      [masterId, masterId ? files.slideMasters.get(masterId) : undefined]
    ]) {
      if (path && xml) sources.set(path, xml)
    }
  }
  for (const [path, xml] of sources) {
    const root = new DOMParser().parseFromString(xml, 'application/xml')
    if (root.getElementsByTagName('parsererror').length) throw new Error('Invalid PowerPoint XML')
    const has = (namespace: string, name: string): boolean =>
      root.getElementsByTagNameNS(namespace, name).length > 0
    if (has(presentationNamespace, 'timing'))
      throw new Error('PowerPoint animation is not supported for editable import')
    if (has(presentationNamespace, 'transition'))
      throw new Error('PowerPoint transitions are not supported for editable import')
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
          throw new Error(
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
      throw new Error('PowerPoint audio/video media is not supported for editable import')
  }
}
