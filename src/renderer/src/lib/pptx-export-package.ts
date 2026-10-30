import JSZip from 'jszip'
import {
  createTextElement,
  type EditablePresentationDocument,
  type EditablePresentationAsset
} from './editable-presentation'
import {
  DRAWINGML_NS,
  PRESENTATIONML_NS,
  OFFICE_RELATIONSHIPS_NS,
  PptxExportError,
  writeSlideDrawingMl
} from './pptx-export-drawingml'

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CONTENT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const CONTENT_PREFIX = 'application/vnd.openxmlformats-officedocument.presentationml.'
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'
const TREE =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>'
const NS = `xmlns:p="${PRESENTATIONML_NS}" xmlns:a="${DRAWINGML_NS}" xmlns:r="${OFFICE_RELATIONSHIPS_NS}"`
const COLOR_MAP =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"'

function packageLimit(message: string): never {
  throw new PptxExportError([{ code: 'package-limit', message }])
}
function xmlDocument(namespace: string, tag: string): XMLDocument {
  const xml = document.implementation.createDocument(namespace, tag)
  for (const [prefix, uri] of [
    ['p', PRESENTATIONML_NS],
    ['a', DRAWINGML_NS],
    ['r', OFFICE_RELATIONSHIPS_NS]
  ]) {
    xml.documentElement.setAttributeNS(XMLNS_NS, `xmlns:${prefix}`, uri)
  }
  return xml
}
function child(
  parent: Element,
  name: string,
  attributes: Record<string, string | number> = {}
): Element {
  const namespace = name.startsWith('p:') ? PRESENTATIONML_NS : parent.namespaceURI
  const node = parent.ownerDocument.createElementNS(namespace, name)
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('r:')) node.setAttributeNS(OFFICE_RELATIONSHIPS_NS, key, String(value))
    else node.setAttribute(key, String(value))
  }
  parent.appendChild(node)
  return node
}
function relationships(entries: { id: string; type: string; target: string }[]): XMLDocument {
  const xml = document.implementation.createDocument(REL_NS, 'Relationships')
  for (const entry of entries)
    child(xml.documentElement, 'Relationship', {
      Id: entry.id,
      Type: `${OFFICE_RELATIONSHIPS_NS}/${entry.type}`,
      Target: entry.target
    })
  return xml
}
function webpDimensions(bytes: Uint8Array): { width: number; height: number } {
  const chunk = String.fromCharCode(...bytes.subarray(12, 16))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (chunk === 'VP8X' && bytes.length >= 30)
    return {
      width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
      height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)
    }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f)
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10)
    }
  if (
    chunk === 'VP8 ' &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 1 &&
    bytes[25] === 0x2a
  )
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff
    }
  throw new PptxExportError([
    { code: 'invalid-value', message: 'The WebP dimensions cannot be decoded' }
  ])
}
export async function encodePptxImage(
  asset: EditablePresentationAsset
): Promise<{ bytes: Uint8Array<ArrayBuffer>; extension: string; mimeType: string }> {
  const bytes = Uint8Array.from(
    atob(asset.dataUrl.slice(asset.dataUrl.indexOf(',') + 1)),
    (value) => value.charCodeAt(0)
  )
  const extensions: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/bmp': 'bmp'
  }
  if (extensions[asset.mimeType])
    return { bytes, extension: extensions[asset.mimeType], mimeType: asset.mimeType }
  if (asset.mimeType !== 'image/webp')
    throw new PptxExportError([
      { code: 'unsupported-content', message: `Unsupported export image: ${asset.mimeType}` }
    ])
  const size = webpDimensions(bytes)
  if (
    size.width < 1 ||
    size.height < 1 ||
    size.width > 8192 ||
    size.height > 8192 ||
    size.width * size.height > 16777216
  )
    packageLimit('The image exceeds the PPTX rasterization limit')
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () =>
      reject(
        new PptxExportError([
          { code: 'invalid-value', message: 'The WebP image cannot be decoded' }
        ])
      )
    image.src = asset.dataUrl
  })
  if (image.naturalWidth !== size.width || image.naturalHeight !== size.height)
    throw new PptxExportError([
      { code: 'invalid-value', message: 'The decoded image dimensions differ from its header' }
    ])
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  try {
    const context = canvas.getContext('2d')
    if (!context)
      throw new PptxExportError([
        { code: 'unsupported-content', message: 'Image rasterization is unavailable' }
      ])
    context.drawImage(image, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob)
      throw new PptxExportError([{ code: 'invalid-value', message: 'Image rasterization failed' }])
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      extension: 'png',
      mimeType: 'image/png'
    }
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

export async function buildNativePptx(
  document: EditablePresentationDocument
): Promise<ArrayBuffer> {
  const zip = new JSZip()
  const types = globalThis.document.implementation.createDocument(CONTENT_NS, 'Types')
  child(types.documentElement, 'Default', {
    Extension: 'rels',
    ContentType: 'application/vnd.openxmlformats-package.relationships+xml'
  })
  let expandedSize = 0
  const put = (path: string, data: string | XMLDocument | Uint8Array, mimeType?: string): void => {
    const value =
      typeof data === 'string' || data instanceof Uint8Array
        ? data
        : new XMLSerializer().serializeToString(data)
    const size =
      typeof value === 'string' ? new TextEncoder().encode(value).length : value.byteLength
    expandedSize += size
    if (expandedSize > 256 * 1024 * 1024)
      packageLimit('PPTX content exceeds the expanded size limit')
    if (size > 32 * 1024 * 1024) packageLimit('A PPTX part exceeds the expanded size limit')
    zip.file(path, value, { createFolders: false, date: new Date('1980-01-01T00:00:00Z') })
    if (mimeType)
      child(types.documentElement, 'Override', { PartName: `/${path}`, ContentType: mimeType })
  }
  const slides = document.slideOrder.map((id) => document.slides[id])
  const noteCount = slides.filter((slide) => slide.notes).length
  if (9 + slides.length * 2 + (noteCount ? 2 : 0) + noteCount * 2 > 4000)
    packageLimit('The PPTX exceeds the ZIP entry limit')
  const media = new Map<
    string,
    { path: string; bytes: Uint8Array<ArrayBuffer>; mimeType: string }
  >()
  const assetPaths = new Map<string, string>()
  let mediaSize = 0
  for (const slide of slides)
    for (const id of slide.elementOrder) {
      const element = slide.elements[id]
      if (element.type !== 'image' || assetPaths.has(element.assetId)) continue
      const asset = document.assets[element.assetId]
      if (!asset)
        throw new PptxExportError([
          {
            code: 'invalid-value',
            message: 'An image asset is missing',
            slideId: slide.id,
            elementId: id
          }
        ])
      const entry = await encodePptxImage(asset)
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', entry.bytes)),
        (value) => value.toString(16).padStart(2, '0')
      ).join('')
      const key = `${entry.mimeType}:${hash}`
      let existing = media.get(key)
      if (!existing) {
        mediaSize += entry.bytes.byteLength
        if (mediaSize > 192 * 1024 * 1024)
          packageLimit('PPTX media exceeds the expanded size limit')
        existing = { ...entry, path: `ppt/media/image${media.size + 1}.${entry.extension}` }
        media.set(key, existing)
      }
      assetPaths.set(element.assetId, existing.path)
    }
  if (9 + slides.length * 2 + (noteCount ? 2 : 0) + noteCount * 2 + media.size > 4000)
    packageLimit('The PPTX exceeds the ZIP entry limit')
  for (const entry of media.values()) put(entry.path, entry.bytes, entry.mimeType)
  put(
    '_rels/.rels',
    relationships([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }])
  )
  const presentation = xmlDocument(PRESENTATIONML_NS, 'p:presentation')
  child(child(presentation.documentElement, 'p:sldMasterIdLst'), 'p:sldMasterId', {
    id: 2147483648,
    'r:id': 'rId1'
  })
  if (noteCount)
    child(child(presentation.documentElement, 'p:notesMasterIdLst'), 'p:notesMasterId', {
      'r:id': 'rId2'
    })
  const slideList = child(presentation.documentElement, 'p:sldIdLst')
  const presentationRels = [
    { id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' }
  ]
  if (noteCount)
    presentationRels.push({
      id: 'rId2',
      type: 'notesMaster',
      target: 'notesMasters/notesMaster1.xml'
    })
  for (const [index, slide] of slides.entries()) {
    const number = index + 1
    child(slideList, 'p:sldId', { id: 256 + index, 'r:id': `rId${number + 2}` })
    presentationRels.push({
      id: `rId${number + 2}`,
      type: 'slide',
      target: `slides/slide${number}.xml`
    })
    const slideRels = [
      { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }
    ]
    const imageRels = new Map<string, string>()
    for (const id of slide.elementOrder) {
      const element = slide.elements[id]
      if (element.type !== 'image' || imageRels.has(element.assetId)) continue
      const relationshipId = `rId${slideRels.length + 1}`
      imageRels.set(element.assetId, relationshipId)
      slideRels.push({
        id: relationshipId,
        type: 'image',
        target: `../media/${assetPaths.get(element.assetId)!.split('/').at(-1)}`
      })
    }
    if (slide.notes) {
      slideRels.push({
        id: `rId${slideRels.length + 1}`,
        type: 'notesSlide',
        target: `../notesSlides/notesSlide${number}.xml`
      })
      const text = createTextElement({
        text: slide.notes,
        x: 0,
        y: 0,
        width: document.width,
        height: document.height,
        autoSize: 'fixed',
        autoWidth: false
      })
      text.id = 'notes-body'
      const noteSlide = { ...slide, elementOrder: [text.id], elements: { [text.id]: text } }
      const noteDrawing = writeSlideDrawingMl(
        { ...document, slides: { [slide.id]: noteSlide } },
        slide.id,
        new Map()
      )
      const notes = xmlDocument(PRESENTATIONML_NS, 'p:notes')
      const common = noteDrawing.getElementsByTagNameNS(PRESENTATIONML_NS, 'cSld')[0]
      common.getElementsByTagNameNS(PRESENTATIONML_NS, 'bg')[0]?.remove()
      const nonVisual = common.getElementsByTagNameNS(PRESENTATIONML_NS, 'nvPr')[1]
      child(nonVisual, 'p:ph', { type: 'body', idx: 1 })
      notes.documentElement.appendChild(notes.importNode(common, true))
      put(`ppt/notesSlides/notesSlide${number}.xml`, notes, `${CONTENT_PREFIX}notesSlide+xml`)
      put(
        `ppt/notesSlides/_rels/notesSlide${number}.xml.rels`,
        relationships([
          { id: 'rId1', type: 'notesMaster', target: '../notesMasters/notesMaster1.xml' },
          { id: 'rId2', type: 'slide', target: `../slides/slide${number}.xml` }
        ])
      )
    }
    put(
      `ppt/slides/slide${number}.xml`,
      writeSlideDrawingMl(document, slide.id, imageRels),
      `${CONTENT_PREFIX}slide+xml`
    )
    put(`ppt/slides/_rels/slide${number}.xml.rels`, relationships(slideRels))
  }
  child(presentation.documentElement, 'p:sldSz', {
    cx: Math.round(document.width * 9525),
    cy: Math.round(document.height * 9525)
  })
  child(presentation.documentElement, 'p:notesSz', { cx: 6858000, cy: 9144000 })
  put('ppt/presentation.xml', presentation, `${CONTENT_PREFIX}presentation.main+xml`)
  put('ppt/_rels/presentation.xml.rels', relationships(presentationRels))
  put(
    'ppt/slideMasters/slideMaster1.xml',
    `<p:sldMaster ${NS}><p:cSld>${TREE}</p:cSld><p:clrMap ${COLOR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    `${CONTENT_PREFIX}slideMaster+xml`
  )
  put(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    relationships([
      { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: 'theme', target: '../theme/theme1.xml' }
    ])
  )
  put(
    'ppt/slideLayouts/slideLayout1.xml',
    `<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    `${CONTENT_PREFIX}slideLayout+xml`
  )
  put(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    relationships([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }])
  )
  if (noteCount) {
    put(
      'ppt/notesMasters/notesMaster1.xml',
      `<p:notesMaster ${NS}><p:cSld>${TREE}</p:cSld><p:clrMap ${COLOR_MAP}/><p:notesStyle/></p:notesMaster>`,
      `${CONTENT_PREFIX}notesMaster+xml`
    )
    put(
      'ppt/notesMasters/_rels/notesMaster1.xml.rels',
      relationships([{ id: 'rId1', type: 'theme', target: '../theme/theme1.xml' }])
    )
  }
  const scheme = [
    'dk1',
    'lt1',
    'dk2',
    'lt2',
    'accent1',
    'accent2',
    'accent3',
    'accent4',
    'accent5',
    'accent6',
    'hlink',
    'folHlink'
  ]
    .map(
      (name, index) =>
        `<a:${name}><a:srgbClr val="${index % 2 ? 'FFFFFF' : '000000'}"/></a:${name}>`
    )
    .join('')
  const placeholderFill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  const styleList = (name: string, content: string): string =>
    `<a:${name}>${content.repeat(3)}</a:${name}>`
  put(
    'ppt/theme/theme1.xml',
    `<a:theme xmlns:a="${DRAWINGML_NS}" name="HHC"><a:themeElements><a:clrScheme name="HHC">${scheme}</a:clrScheme><a:fontScheme name="HHC"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="HHC">${styleList('fillStyleLst', placeholderFill)}${styleList('lnStyleLst', `<a:ln w="0">${placeholderFill}<a:prstDash val="solid"/></a:ln>`)}${styleList('effectStyleLst', '<a:effectStyle><a:effectLst/></a:effectStyle>')}${styleList('bgFillStyleLst', placeholderFill)}</a:fmtScheme></a:themeElements></a:theme>`,
    'application/vnd.openxmlformats-officedocument.theme+xml'
  )
  put('[Content_Types].xml', types)
  return zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  })
}
