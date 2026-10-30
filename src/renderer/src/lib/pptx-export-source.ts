import JSZip from 'jszip'
import {
  buildPresentation,
  materializeAllSlideNodes,
  parseZip,
  RECOMMENDED_ZIP_LIMITS
} from '@aiden0z/pptx-renderer'
import {
  convertPresentationData,
  createTextElement,
  normalizeSlideBackground,
  type EditablePresentationDocument,
  type EditablePresentationElement,
  type EditablePresentationSlide,
  type EditableTextElement
} from './editable-presentation'
import { normalizeTextParagraphs, resolveParagraphListNumbers } from './presentation-rich-text'
import { validatePptxSource, readPptxPackageMemberSizes } from './pptx-source'
import { readPptxNotes } from './pptx-notes'
import { buildNativePptx, encodePptxImage } from './pptx-export-package'
import {
  DRAWINGML_NS as A_NS,
  PRESENTATIONML_NS as P_NS,
  OFFICE_RELATIONSHIPS_NS as R_NS,
  PptxExportError,
  writeSlideDrawingMl
} from './pptx-export-drawingml'
import {
  drawingChild,
  presentationChild,
  replaceDrawingChild,
  patchSourceText
} from './pptx-export-source-text'
import type { FileItemRecord } from '@shared/types/folder'

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const TYPE_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const SP_ORDER = [
  'xfrm',
  'prstGeom',
  'custGeom',
  'noFill',
  'solidFill',
  'gradFill',
  'blipFill',
  'pattFill',
  'grpFill',
  'ln',
  'effectLst',
  'effectDag',
  'scene3d',
  'sp3d',
  'extLst'
]
const FRAME_KEYS = ['x', 'y', 'width', 'height', 'rotation'] as const

function conflict(message: string, slideId?: string, elementId?: string): never {
  throw new PptxExportError([{ code: 'source-conflict', message, slideId, elementId }])
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, stable(value)])
    )
  return value
}
function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}
function textPayload(element: EditableTextElement): unknown {
  const {
    x: _x,
    y: _y,
    width: _w,
    height: _h,
    rotation: _rot,
    id: _id,
    locked: _locked,
    pptxSourceNode: _ref,
    text: _text,
    runs: _runs,
    paragraphs: _paragraphs,
    ...style
  } = element
  const paragraphs = normalizeTextParagraphs(element)
  const numbers = resolveParagraphListNumbers(paragraphs)
  return {
    ...style,
    paragraphs: paragraphs.map(({ typingStyleCaret: _caret, list, ...paragraph }, index) => ({
      ...paragraph,
      list: list ? { ...list, sequenceId: undefined, startAt: numbers[index] } : null
    }))
  }
}
function elementValue(
  element: EditablePresentationElement,
  document: EditablePresentationDocument
): unknown {
  const { id: _id, locked: _locked, ...value } = element
  if (element.type === 'text')
    return {
      frame: FRAME_KEYS.map((key) => element[key]),
      ref: element.pptxSourceNode,
      text: textPayload(element)
    }
  if (element.type === 'image')
    return { ...value, assetId: document.assets[element.assetId]?.dataUrl }
  return value
}
function slideValue(
  slide: EditablePresentationSlide,
  document: EditablePresentationDocument
): unknown {
  return {
    sourcePart: slide.pptxSourcePart,
    background: normalizeSlideBackground(slide.background),
    notes: slide.notes,
    elements: slide.elementOrder.map((id) => elementValue(slide.elements[id], document))
  }
}
function relationPart(part: string): string {
  const slash = part.lastIndexOf('/')
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}
function targetPart(owner: string, target: string): string {
  const url = new URL(target, `https://pptx.invalid/${owner}`)
  if (url.origin !== 'https://pptx.invalid' || url.search || url.hash)
    conflict('An internal relationship target cannot be patched')
  return decodeURIComponent(url.pathname.slice(1))
}
function relativeTarget(owner: string, target: string): string {
  const from = owner.split('/').slice(0, -1)
  const to = target.split('/')
  while (from.length && from[0] === to[0]) {
    from.shift()
    to.shift()
  }
  return '../'.repeat(from.length) + to.join('/')
}
function parsed(xml: string): XMLDocument {
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  if (document.getElementsByTagName('parsererror').length)
    conflict('A retained XML part cannot be parsed')
  return document
}
function namespaceChild(parent: Element, namespace: string, name: string): Element | undefined {
  return Array.from(parent.children).find(
    (child) => child.namespaceURI === namespace && child.localName === name
  )
}
function appendRelationship(root: Element, type: string, target: string): string {
  const ids = new Set(Array.from(root.children, (node) => node.getAttribute('Id')))
  let number = 1
  while (ids.has(`rIdHhc${number}`)) number++
  const id = `rIdHhc${number}`
  const node = root.ownerDocument.createElementNS(REL_NS, 'Relationship')
  for (const [name, value] of Object.entries({ Id: id, Type: `${R_NS}/${type}`, Target: target }))
    node.setAttribute(name, value)
  root.appendChild(node)
  return id
}
function patchPresetGeometry(properties: Element, nextProperties: Element): void {
  const next = drawingChild(nextProperties, 'prstGeom')
  if (!next) return conflict('The generated preset geometry is missing')
  const original = drawingChild(properties, 'prstGeom')
  if (!original) {
    replaceDrawingChild(properties, nextProperties, 'prstGeom', SP_ORDER)
    return
  }
  original.setAttribute('prst', next.getAttribute('prst')!)
  let adjustments = drawingChild(original, 'avLst')
  if (!adjustments) {
    adjustments = properties.ownerDocument.createElementNS(A_NS, 'a:avLst')
    original.insertBefore(adjustments, original.firstChild)
  }
  const owned = Array.from(adjustments.children).filter(
    (node) => node.namespaceURI === A_NS && node.localName === 'gd'
  )
  const generated = Array.from(drawingChild(next, 'avLst')?.children ?? []).filter(
    (node) => node.namespaceURI === A_NS && node.localName === 'gd'
  )
  const names = new Set(generated.map((node) => node.getAttribute('name')))
  for (const node of owned) if (!names.has(node.getAttribute('name'))) node.remove()
  for (const node of generated) {
    const existing = owned.find((entry) => entry.getAttribute('name') === node.getAttribute('name'))
    if (existing) existing.setAttribute('fmla', node.getAttribute('fmla')!)
    else
      adjustments.insertBefore(
        properties.ownerDocument.importNode(node, true),
        drawingChild(adjustments, 'extLst') ?? null
      )
  }
}

function roleKey(element: EditablePresentationElement): string | undefined {
  const ref = element.pptxSourceNode
  return ref ? `${ref.id}:${ref.role}` : undefined
}

export async function buildSourcePptx(
  document: EditablePresentationDocument
): Promise<ArrayBuffer> {
  await validatePptxSource(document)
  if (!document.pptxSource) return conflict('The retained PPTX package is missing')
  const bytes = Uint8Array.from(atob(document.pptxSource.base64), (character) =>
    character.charCodeAt(0)
  ).buffer
  const files = await parseZip(bytes, RECOMMENDED_ZIP_LIMITS)
  const presentation = buildPresentation(files)
  materializeAllSlideNodes(presentation)
  let baseline: EditablePresentationDocument
  try {
    baseline = convertPresentationData(
      { id: 'pptx-export-baseline', name: 'Original.pptx', url: '' } as FileItemRecord,
      presentation,
      document.pptxSource,
      await readPptxNotes(bytes, presentation),
      document.schemaVersion === 3 ? 3 : undefined
    )
  } catch (error) {
    throw new PptxExportError(
      [
        {
          code: 'source-conflict',
          message: 'The retained package cannot be reconciled with the editable model'
        }
      ],
      { cause: error }
    )
  }
  const baselineByPart = new Map(
    baseline.slideOrder.map((id) => [baseline.slides[id].pptxSourcePart!, baseline.slides[id]])
  )
  const currentSlides = document.slideOrder.map((id) => document.slides[id])
  if (
    document.width === baseline.width &&
    document.height === baseline.height &&
    equal(
      currentSlides.map((slide) => slideValue(slide, document)),
      baseline.slideOrder.map((id) => slideValue(baseline.slides[id], baseline))
    )
  )
    return bytes
  const zip = await JSZip.loadAsync(bytes, { createFolders: false })
  const types = parsed(await zip.file('[Content_Types].xml')!.async('string'))
  const originalPresentation = zip.file('ppt/presentation.xml')
  if (!originalPresentation)
    return conflict('The presentation part path is not supported for editing')
  const pres = parsed(await originalPresentation.async('string'))
  const presRels = parsed(await zip.file('ppt/_rels/presentation.xml.rels')!.async('string'))
  let typesChanged = false
  let presentationChanged = false
  let presentationRelsChanged = false
  const allocate = (path: string): string => {
    const index = path.lastIndexOf('.')
    const prefix = path.slice(0, index)
    const extension = path.slice(index)
    let number = 1
    while (zip.files[`${prefix}-${number}${extension}`]) number++
    return `${prefix}-${number}${extension}`
  }
  const memberSizes = new Map(readPptxPackageMemberSizes(bytes))
  let expandedBytes = Array.from(memberSizes.values()).reduce((sum, size) => sum + size, 0)
  let mediaBytes = Array.from(memberSizes).reduce(
    (sum, [name, size]) => sum + (name.startsWith('ppt/media/') ? size : 0),
    0
  )
  const put = (path: string, value: XMLDocument | string | Uint8Array, type?: string): void => {
    const data =
      typeof value === 'string' || value instanceof Uint8Array
        ? value
        : new XMLSerializer().serializeToString(value)
    const size = typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength
    const nextExpanded = expandedBytes + size - (memberSizes.get(path) ?? 0)
    const nextMedia =
      mediaBytes + (path.startsWith('ppt/media/') ? size - (memberSizes.get(path) ?? 0) : 0)
    if (
      size > 32 * 1024 * 1024 ||
      nextExpanded > 256 * 1024 * 1024 ||
      nextMedia > 192 * 1024 * 1024 ||
      (!zip.files[path] && Object.keys(zip.files).length >= 4000)
    )
      throw new PptxExportError([
        { code: 'package-limit', message: 'The edited PPTX exceeds a package limit' }
      ])
    expandedBytes = nextExpanded
    mediaBytes = nextMedia
    memberSizes.set(path, size)
    zip.file(path, data, { createFolders: false, date: new Date('1980-01-01T00:00:00Z') })
    if (
      type &&
      !Array.from(types.documentElement.children).some(
        (node) => node.getAttribute('PartName') === `/${path}`
      )
    ) {
      const override = types.createElementNS(TYPE_NS, 'Override')
      override.setAttribute('PartName', `/${path}`)
      override.setAttribute('ContentType', type)
      types.documentElement.appendChild(override)
      typesChanged = true
    }
  }
  const mediaCache = new Map<string, string>()
  const mediaHashes = new Map<string, string>()
  const mediaHash = async (data: Uint8Array): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(data).buffer)
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
      ''
    )
  }
  for (const [path, data] of files.media) mediaHashes.set(await mediaHash(data), path)
  const imagePart = async (assetId: string): Promise<string> => {
    const asset = document.assets[assetId]
    const existing = mediaCache.get(asset.dataUrl)
    if (existing) return existing
    const image = await encodePptxImage(asset)
    const hash = await mediaHash(image.bytes)
    const retained = mediaHashes.get(hash)
    if (retained) {
      mediaCache.set(asset.dataUrl, retained)
      return retained
    }
    const path = allocate(`ppt/media/hhc-image.${image.extension}`)
    mediaHashes.set(hash, path)
    put(path, image.bytes, image.mimeType)
    mediaCache.set(asset.dataUrl, path)
    return path
  }
  const sharedNative = new Map<string, string>()
  const newMasters = new Set<string>()
  const newNotesMasters = new Set<string>()
  const copyNativeSlide = async (
    slide: EditablePresentationSlide,
    notesOnly = false
  ): Promise<string> => {
    const nativeSlide = notesOnly ? { ...slide, elements: {}, elementOrder: [] } : slide
    const native = await JSZip.loadAsync(
      await buildNativePptx({
        ...document,
        slides: { [slide.id]: nativeSlide },
        slideOrder: [slide.id]
      }),
      { createFolders: false }
    )
    const nativeTypes = parsed(await native.file('[Content_Types].xml')!.async('string'))
    const mapping = new Map<string, string>()
    const copyPart = async (path: string): Promise<string> => {
      if (mapping.has(path)) return mapping.get(path)!
      const shared = /^(?:ppt\/(?:slideMasters|slideLayouts|theme|notesMasters)\/)/.test(path)
      if (shared && sharedNative.has(path)) return sharedNative.get(path)!
      const entry = native.file(path)
      if (!entry) return conflict('A generated dependency is missing')
      const data = await entry.async('uint8array')
      if (path.startsWith('ppt/media/')) {
        const hash = await mediaHash(data)
        const retained = mediaHashes.get(hash)
        if (retained) return retained
      }
      const contentType =
        Array.from(nativeTypes.documentElement.children)
          .find((node) => node.getAttribute('PartName') === `/${path}`)
          ?.getAttribute('ContentType') ?? undefined
      const target = allocate(path.replace(/\/([^/]+)$/, '/hhc-$1'))
      mapping.set(path, target)
      if (shared) sharedNative.set(path, target)
      put(target, data, contentType)
      if (path.startsWith('ppt/media/')) mediaHashes.set(await mediaHash(data), target)
      if (path.startsWith('ppt/slideMasters/')) newMasters.add(target)
      if (path.startsWith('ppt/notesMasters/')) newNotesMasters.add(target)
      const relationships = native.file(relationPart(path))
      if (relationships) {
        const root = parsed(await relationships.async('string'))
        for (const rel of root.documentElement.children) {
          const dependency = targetPart(path, rel.getAttribute('Target')!)
          const copied =
            notesOnly && rel.getAttribute('Type') === `${R_NS}/slide`
              ? slide.pptxSourcePart!
              : await copyPart(dependency)
          rel.setAttribute('Target', relativeTarget(target, copied))
        }
        put(relationPart(target), root)
      }
      return target
    }
    return copyPart(notesOnly ? 'ppt/notesSlides/notesSlide1.xml' : 'ppt/slides/slide1.xml')
  }
  const editedSlideParts: string[] = []
  for (const slide of currentSlides) {
    if (!slide.pptxSourcePart) {
      editedSlideParts.push(await copyNativeSlide(slide))
      continue
    }
    const previous = baselineByPart.get(slide.pptxSourcePart)
    if (!previous) return conflict('The slide reference has no editable source baseline', slide.id)
    editedSlideParts.push(slide.pptxSourcePart)
    if (equal(slideValue(slide, document), slideValue(previous, baseline))) continue
    const xml = parsed(await zip.file(slide.pptxSourcePart)!.async('string'))
    const common = presentationChild(xml.documentElement, 'cSld')!
    const tree = presentationChild(common, 'spTree')!
    const relPath = relationPart(slide.pptxSourcePart)
    const relationships = zip.file(relPath)
      ? parsed(await zip.file(relPath)!.async('string'))
      : documentXml(REL_NS, 'Relationships')
    let relsChanged = false
    const baselineRoles = new Map(
      previous.elementOrder
        .map((id) => previous.elements[id])
        .filter((element) => roleKey(element))
        .map((element) => [roleKey(element)!, element])
    )
    const originalNodes = new Map(
      Array.from(tree.children)
        .filter((node) => ['sp', 'pic'].includes(node.localName) && node.namespaceURI === P_NS)
        .map((node) => [
          node.getElementsByTagNameNS(P_NS, 'cNvPr')[0]?.getAttribute('id') ?? '',
          node
        ])
    )
    const imageRelationships = new Map<string, string>()
    for (const id of slide.elementOrder) {
      const element = slide.elements[id]
      if (element.type !== 'image') continue
      const old = baselineRoles.get(roleKey(element) ?? '')
      const sourceNode = element.pptxSourceNode
        ? originalNodes.get(element.pptxSourceNode.id)
        : undefined
      if (
        old?.type === 'image' &&
        sourceNode &&
        baseline.assets[old.assetId].dataUrl === document.assets[element.assetId].dataUrl
      ) {
        const embed = sourceNode
          .getElementsByTagNameNS(A_NS, 'blip')[0]
          ?.getAttributeNS(R_NS, 'embed')
        if (!embed) return conflict('The source image relationship is missing', slide.id, id)
        imageRelationships.set(element.assetId, embed)
      } else if (!imageRelationships.has(element.assetId)) {
        const path = await imagePart(element.assetId)
        imageRelationships.set(
          element.assetId,
          appendRelationship(
            relationships.documentElement,
            'image',
            relativeTarget(slide.pptxSourcePart, path)
          )
        )
        relsChanged = true
      }
    }
    const generated = writeSlideDrawingMl(document, slide.id, imageRelationships)
    const generatedTree = presentationChild(
      presentationChild(generated.documentElement, 'cSld')!,
      'spTree'
    )!
    const generatedNodes = Array.from(generatedTree.children).filter((node) =>
      ['sp', 'pic'].includes(node.localName)
    )
    const existingIds = new Set(
      Array.from(xml.getElementsByTagNameNS(P_NS, 'cNvPr'), (node) => node.getAttribute('id') ?? '')
    )
    const claimedIds = new Set<string>()
    const nextId = (): string => {
      let number = 1
      while (existingIds.has(String(number)) || claimedIds.has(String(number))) number++
      claimedIds.add(String(number))
      return String(number)
    }
    const beforeNodes = new Set(baselineRoles.keys())
    const output: Element[] = []
    const handled = new Set<string>()
    for (const [index, id] of slide.elementOrder.entries()) {
      if (handled.has(id)) continue
      const element = slide.elements[id]
      const reference = element.pptxSourceNode
      const original = reference ? originalNodes.get(reference.id) : undefined
      const previousElement = baselineRoles.get(roleKey(element) ?? '')
      if (reference && (!original || !previousElement))
        return conflict('The source role does not match its editable baseline', slide.id, id)
      const pairId = slide.elementOrder[index + 1]
      const pair = pairId ? slide.elements[pairId] : undefined
      const coalesce =
        reference &&
        pair?.pptxSourceNode?.id === reference.id &&
        pair.pptxSourceNode.role !== reference.role &&
        ((element.type === 'text' && pair.type === 'shape') ||
          (element.type === 'shape' && pair.type === 'text')) &&
        FRAME_KEYS.every((key) => element[key] === pair[key])
      const group = coalesce ? [element, pair!] : [element]
      const target = xml.importNode(original ?? generatedNodes[index], true)
      const targetId = reference && !claimedIds.has(reference.id) ? reference.id : nextId()
      claimedIds.add(targetId)
      target.getElementsByTagNameNS(P_NS, 'cNvPr')[0].setAttribute('id', targetId)
      const properties = presentationChild(target, 'spPr')!
      const hasText = group.some((entry) => entry.type === 'text')
      const hasGeometry = group.some((entry) => entry.type === 'shape' || entry.type === 'line')
      if (original && !hasText && presentationChild(target, 'txBody'))
        presentationChild(target, 'txBody')!.remove()
      if (original && hasText && !hasGeometry && beforeNodes.has(`${reference!.id}:geometry`)) {
        for (const name of [
          'solidFill',
          'gradFill',
          'blipFill',
          'pattFill',
          'grpFill',
          'ln',
          'effectLst',
          'effectDag'
        ])
          drawingChild(properties, name)?.remove()
        const textNode = group.find((entry) => entry.type === 'text')!
        const textGenerated = generatedNodes[slide.elementOrder.indexOf(textNode.id)]
        const textProperties = presentationChild(textGenerated, 'spPr')!
        for (const name of ['prstGeom', 'noFill', 'ln'])
          replaceDrawingChild(properties, textProperties, name, SP_ORDER)
        target.getElementsByTagNameNS(P_NS, 'cNvSpPr')[0]?.setAttribute('txBox', '1')
      }
      for (const current of group) {
        handled.add(current.id)
        const old = baselineRoles.get(roleKey(current) ?? '')
        const next = generatedNodes[slide.elementOrder.indexOf(current.id)]
        const nextProperties = presentationChild(next, 'spPr')!
        if (old && FRAME_KEYS.some((key) => current[key] !== old[key]))
          patchFrame(properties, nextProperties, old, current)
        if (
          old &&
          current.type === 'text' &&
          old.type === 'text' &&
          (!equal(textPayload(current), textPayload(old)) ||
            ((current.width !== old.width || current.height !== old.height) &&
              target.getElementsByTagNameNS(A_NS, 'normAutofit').length > 0))
        )
          patchSourceText(target, next, old, current, slide.id)
        if (old && current.type === 'shape' && old.type === 'shape') {
          if (current.shape !== old.shape || !equal(current.adjustments, old.adjustments))
            patchPresetGeometry(properties, nextProperties)
          if (current.fillColor !== old.fillColor || current.opacity !== old.opacity) {
            for (const name of ['noFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'])
              drawingChild(properties, name)?.remove()
            replaceDrawingChild(properties, nextProperties, 'solidFill', SP_ORDER)
          }
        }
        if (
          old &&
          ((current.type === 'shape' && old.type === 'shape') ||
            (current.type === 'line' && old.type === 'line'))
        ) {
          if (
            current.strokeWidth !== old.strokeWidth ||
            current.strokeColor !== old.strokeColor ||
            current.opacity !== old.opacity
          )
            patchOutline(
              properties,
              nextProperties,
              current.strokeWidth !== old.strokeWidth,
              current.strokeColor !== old.strokeColor || current.opacity !== old.opacity
            )
        }
        if (old?.type === 'image' && current.type === 'image') {
          const imageFill = presentationChild(target, 'blipFill')!
          const nextFill = presentationChild(next, 'blipFill')!
          if (baseline.assets[old.assetId].dataUrl !== document.assets[current.assetId].dataUrl)
            imageFill
              .getElementsByTagNameNS(A_NS, 'blip')[0]
              .setAttributeNS(R_NS, 'r:embed', imageRelationships.get(current.assetId)!)
          if (current.opacity !== old.opacity)
            replaceDrawingChild(
              drawingChild(imageFill, 'blip')!,
              drawingChild(nextFill, 'blip')!,
              'alphaModFix',
              [
                'alphaBiLevel',
                'alphaCeiling',
                'alphaFloor',
                'alphaInv',
                'alphaMod',
                'alphaModFix',
                'alphaRepl',
                'extLst'
              ]
            )
          if (!equal(current.crop, old.crop))
            replaceDrawingChild(imageFill, nextFill, 'srcRect', [
              'blip',
              'srcRect',
              'tile',
              'stretch'
            ])
          if (
            current.borderWidth !== old.borderWidth ||
            current.borderColor !== old.borderColor ||
            current.opacity !== old.opacity
          )
            patchOutline(
              properties,
              nextProperties,
              current.borderWidth !== old.borderWidth,
              current.borderColor !== old.borderColor || current.opacity !== old.opacity
            )
          if (current.shadow !== old.shadow || current.opacity !== old.opacity) {
            const oldEffects = drawingChild(properties, 'effectLst')
            const nextEffects = drawingChild(nextProperties, 'effectLst')
            if (oldEffects && nextEffects)
              replaceDrawingChild(oldEffects, nextEffects, 'outerShdw', [
                'blur',
                'fillOverlay',
                'glow',
                'innerShdw',
                'outerShdw',
                'prstShdw',
                'reflection',
                'softEdge'
              ])
            else if (nextEffects)
              replaceDrawingChild(properties, nextProperties, 'effectLst', SP_ORDER)
            else if (oldEffects) drawingChild(oldEffects, 'outerShdw')?.remove()
          }
        }
      }
      output.push(target)
    }
    const mappedIds = new Set(
      Array.from(baselineRoles.values(), (element) => element.pptxSourceNode!.id)
    )
    const mappedNodes = Array.from(tree.children).filter((node) =>
      mappedIds.has(node.getElementsByTagNameNS(P_NS, 'cNvPr')[0]?.getAttribute('id') ?? '')
    )
    let cursor = 0
    const insertion =
      mappedNodes.at(-1)?.nextSibling ?? namespaceChild(tree, P_NS, 'extLst') ?? null
    for (const node of mappedNodes) {
      if (output[cursor]) node.replaceWith(output[cursor++])
      else node.remove()
    }
    for (const node of output.slice(cursor)) tree.insertBefore(node, insertion)
    if (
      !equal(
        normalizeSlideBackground(slide.background),
        normalizeSlideBackground(previous.background)
      )
    ) {
      const generatedBg = presentationChild(
        presentationChild(generated.documentElement, 'cSld')!,
        'bg'
      )!
      const oldBg = presentationChild(common, 'bg')
      if (oldBg) {
        const oldProperties = presentationChild(oldBg, 'bgPr')
        const nextProperties = presentationChild(generatedBg, 'bgPr')!
        presentationChild(oldBg, 'bgRef')?.remove()
        if (oldProperties) {
          for (const name of ['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'])
            replaceDrawingChild(oldProperties, nextProperties, name, [
              'noFill',
              'solidFill',
              'gradFill',
              'blipFill',
              'pattFill',
              'grpFill',
              'effectLst',
              'effectDag',
              'extLst'
            ])
        } else oldBg.insertBefore(xml.importNode(nextProperties, true), oldBg.firstChild)
      } else common.insertBefore(xml.importNode(generatedBg, true), tree)
    }
    if (slide.notes !== previous.notes) {
      const noteRel = Array.from(relationships.documentElement.children).find(
        (node) => node.getAttribute('Type') === `${R_NS}/notesSlide`
      )
      if (noteRel) {
        const path = targetPart(slide.pptxSourcePart, noteRel.getAttribute('Target')!)
        const noteXml = parsed(await zip.file(path)!.async('string'))
        const contributors = Array.from(noteXml.getElementsByTagNameNS(P_NS, 'sp')).filter(
          (node) => {
            const placeholder = node.getElementsByTagNameNS(P_NS, 'ph')[0]?.getAttribute('type')
            return (
              (!placeholder || placeholder === 'body') &&
              node.getElementsByTagNameNS(A_NS, 'p').length > 0
            )
          }
        )
        if (
          contributors.length !== 1 ||
          contributors[0].getElementsByTagNameNS(P_NS, 'ph')[0]?.getAttribute('type') !== 'body' ||
          contributors[0].getElementsByTagNameNS(A_NS, 'fld').length
        )
          return conflict('The retained note structure cannot be edited safely', slide.id)
        const beforeNote = createTextElement({ text: previous.notes })
        const afterNote = { ...beforeNote, text: slide.notes }
        const noteSlide = {
          ...slide,
          elements: { [afterNote.id]: afterNote },
          elementOrder: [afterNote.id]
        }
        const generatedNote = writeSlideDrawingMl(
          { ...document, slides: { [slide.id]: noteSlide } },
          slide.id,
          new Map()
        )
        patchSourceText(
          contributors[0],
          generatedNote.getElementsByTagNameNS(P_NS, 'sp')[0],
          beforeNote,
          afterNote,
          slide.id
        )
        put(path, noteXml)
      } else if (slide.notes) {
        const notesPath = await copyNativeSlide(slide, true)
        appendRelationship(
          relationships.documentElement,
          'notesSlide',
          relativeTarget(slide.pptxSourcePart, notesPath)
        )
        relsChanged = true
      }
    }
    if (
      !equal(
        slideValue({ ...slide, notes: previous.notes }, document),
        slideValue(previous, baseline)
      )
    )
      put(slide.pptxSourcePart, xml)
    if (relsChanged) put(relPath, relationships)
  }
  const previousParts = baseline.slideOrder.map((id) => baseline.slides[id].pptxSourcePart)
  if (!equal(editedSlideParts, previousParts)) {
    const list = presentationChild(pres.documentElement, 'sldIdLst')!
    const relations = new Map(
      Array.from(presRels.documentElement.children)
        .filter((node) => node.getAttribute('Type') === `${R_NS}/slide`)
        .map((node) => [
          targetPart('ppt/presentation.xml', node.getAttribute('Target')!),
          node.getAttribute('Id')!
        ])
    )
    let maximum = Math.max(
      255,
      ...Array.from(list.children, (node) => Number(node.getAttribute('id')))
    )
    const oldEntries = new Map(
      Array.from(list.children).map((node) => [node.getAttributeNS(R_NS, 'id')!, node])
    )
    const usedIds = new Set<string>()
    const children = editedSlideParts.map((part) => {
      let relation = relations.get(part)
      if (!relation) {
        relation = appendRelationship(
          presRels.documentElement,
          'slide',
          relativeTarget('ppt/presentation.xml', part)
        )
        presentationRelsChanged = true
      }
      const entry =
        (oldEntries.get(relation)?.cloneNode(true) as Element | undefined) ??
        pres.createElementNS(P_NS, 'p:sldId')
      if (!entry.hasAttribute('id') || usedIds.has(entry.getAttribute('id')!))
        entry.setAttribute('id', String(++maximum))
      usedIds.add(entry.getAttribute('id')!)
      entry.setAttributeNS(R_NS, 'r:id', relation)
      return entry
    })
    list.replaceChildren(...children)
    presentationChanged = true
  }
  for (const [masters, tag, childTag, relationshipType] of [
    [newMasters, 'sldMasterIdLst', 'sldMasterId', 'slideMaster'],
    [newNotesMasters, 'notesMasterIdLst', 'notesMasterId', 'notesMaster']
  ] as const) {
    if (!masters.size) continue
    let list = presentationChild(pres.documentElement, tag)
    if (!list) {
      list = pres.createElementNS(P_NS, `p:${tag}`)
      pres.documentElement.insertBefore(
        list,
        presentationChild(pres.documentElement, 'sldIdLst') ?? null
      )
    }
    let maximum = Math.max(
      2147483647,
      ...Array.from(list.children, (node) => Number(node.getAttribute('id') ?? 0))
    )
    for (const part of masters) {
      const id = appendRelationship(
        presRels.documentElement,
        relationshipType,
        relativeTarget('ppt/presentation.xml', part)
      )
      const entry = pres.createElementNS(P_NS, `p:${childTag}`)
      if (childTag === 'sldMasterId') entry.setAttribute('id', String(++maximum))
      entry.setAttributeNS(R_NS, 'r:id', id)
      list.appendChild(entry)
    }
    presentationChanged = true
    presentationRelsChanged = true
  }
  if (document.width !== baseline.width || document.height !== baseline.height) {
    const size = presentationChild(pres.documentElement, 'sldSz')!
    size.setAttribute('cx', String(Math.round(document.width * 9525)))
    size.setAttribute('cy', String(Math.round(document.height * 9525)))
    presentationChanged = true
  }
  if (presentationChanged) put('ppt/presentation.xml', pres)
  if (presentationRelsChanged) put('ppt/_rels/presentation.xml.rels', presRels)
  if (typesChanged) put('[Content_Types].xml', types)
  return zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  })
}

function documentXml(namespace: string, name: string): XMLDocument {
  return document.implementation.createDocument(namespace, name)
}
function patchFrame(
  properties: Element,
  nextProperties: Element,
  before: EditablePresentationElement,
  after: EditablePresentationElement
): void {
  const current = drawingChild(properties, 'xfrm')
  const generated = drawingChild(nextProperties, 'xfrm')!
  if (!current) {
    replaceDrawingChild(properties, nextProperties, 'xfrm', SP_ORDER)
    return
  }
  if (before.rotation !== after.rotation) {
    const rotation = generated.getAttribute('rot')
    if (rotation === null) current.removeAttribute('rot')
    else current.setAttribute('rot', rotation)
  }
  for (const [field, name, attribute] of [
    ['x', 'off', 'x'],
    ['y', 'off', 'y'],
    ['width', 'ext', 'cx'],
    ['height', 'ext', 'cy']
  ] as const) {
    if (before[field] === after[field]) continue
    let child = drawingChild(current, name)
    if (!child) {
      replaceDrawingChild(current, generated, name, ['off', 'ext'])
      child = drawingChild(current, name)!
    }
    child.setAttribute(attribute, drawingChild(generated, name)!.getAttribute(attribute)!)
  }
}

function patchOutline(
  properties: Element,
  nextProperties: Element,
  widthChanged: boolean,
  colorChanged: boolean
): void {
  const current = drawingChild(properties, 'ln')
  const generated = drawingChild(nextProperties, 'ln')!
  if (!current) {
    replaceDrawingChild(properties, nextProperties, 'ln', SP_ORDER)
    return
  }
  if (widthChanged) current.setAttribute('w', generated.getAttribute('w')!)
  if (colorChanged || drawingChild(generated, 'noFill') || drawingChild(current, 'noFill')) {
    for (const name of ['noFill', 'solidFill', 'gradFill', 'pattFill'])
      replaceDrawingChild(current, generated, name, [
        'noFill',
        'solidFill',
        'gradFill',
        'pattFill',
        'prstDash',
        'custDash',
        'round',
        'bevel',
        'miter',
        'headEnd',
        'tailEnd',
        'extLst'
      ])
  }
}
