import type { EditablePresentationDocument } from './editable-presentation'

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid portable presentation document')
}

function orderedMap(order: unknown, values: unknown, limit: number): void {
  requireValid(record(values) && Array.isArray(order))
  requireValid(order.length <= limit && Object.keys(values).length === order.length)
  requireValid(new Set(order).size === order.length)
  for (const id of order) {
    requireValid(typeof id === 'string' && id.length > 0 && Object.hasOwn(values, id))
  }
}

function dimension(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100000
}

function coordinate(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000000
}

function color(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    /^(?:#[\da-f]{3,8}|[a-z]+|(?:rgba?|hsla?)\([\d\s.,%+\-/deg]+\))$/i.test(value)
  )
}

function textStyle(value: unknown): void {
  requireValid(record(value))
  requireValid(
    typeof value.fontFamily === 'string' &&
      value.fontFamily.trim() &&
      value.fontFamily.length <= 512 &&
      !/[;{}<>\\:]/.test(value.fontFamily) &&
      Array.from(value.fontFamily).every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
      )
  )
  requireValid(dimension(value.fontSize) && color(value.color))
  for (const field of ['bold', 'italic', 'underline'])
    requireValid(typeof value[field] === 'boolean')
  if (value.strikethrough !== undefined) requireValid(typeof value.strikethrough === 'boolean')
  if (value.baseline !== undefined)
    requireValid(
      typeof value.baseline === 'string' &&
        ['normal', 'superscript', 'subscript'].includes(value.baseline)
    )
  if (value.characterSpacing !== undefined) requireValid(coordinate(value.characterSpacing))
  if (value.highlightColor != null) requireValid(color(value.highlightColor))
}

function runs(value: unknown): void {
  requireValid(Array.isArray(value) && value.length <= 100000)
  for (const run of value) {
    textStyle(run)
    requireValid(typeof run.text === 'string')
  }
}

function alignment(value: unknown): void {
  requireValid(typeof value === 'string' && ['left', 'center', 'right', 'justify'].includes(value))
}

function background(value: unknown): void {
  if (value === undefined) return
  requireValid(record(value))
  if (value.type === 'solid' || value.type === 'color') {
    requireValid(color(value.color))
    return
  }
  requireValid(value.type === 'gradient')
  if (value.stops === undefined) {
    requireValid(color(value.from) && color(value.to))
    return
  }
  requireValid(Array.isArray(value.stops) && value.stops.length <= 1000 && coordinate(value.angle))
  for (const stop of value.stops) {
    requireValid(
      record(stop) &&
        color(stop.color) &&
        coordinate(stop.position) &&
        coordinate(stop.transparency) &&
        coordinate(stop.brightness)
    )
  }
}

function textElement(value: Record<string, unknown>): void {
  textStyle(value)
  requireValid(typeof value.text === 'string' && dimension(value.lineHeight))
  alignment(value.align)
  if (value.verticalAlign !== undefined)
    requireValid(['top', 'center', 'bottom'].includes(String(value.verticalAlign)))
  if (value.textInsets !== undefined) {
    requireValid(record(value.textInsets))
    for (const side of ['top', 'right', 'bottom', 'left'])
      requireValid(coordinate(value.textInsets[side]) && Number(value.textInsets[side]) >= 0)
  }
  if (value.runs !== undefined) runs(value.runs)
  if (value.paragraphs !== undefined) {
    requireValid(Array.isArray(value.paragraphs) && value.paragraphs.length <= 100000)
    for (const paragraph of value.paragraphs) {
      requireValid(record(paragraph))
      runs(paragraph.runs)
      alignment(paragraph.align)
      requireValid(coordinate(paragraph.marginLeft) && coordinate(paragraph.textIndent))
      const spacing = paragraph.lineSpacing
      requireValid(
        record(spacing) &&
          (spacing.kind === 'multiple'
            ? dimension(spacing.value)
            : spacing.kind === 'exact' && dimension(spacing.points))
      )
      if (paragraph.typingStyle !== undefined) textStyle(paragraph.typingStyle)
      if (paragraph.typingStyleCaret !== undefined)
        requireValid(
          Number.isSafeInteger(paragraph.typingStyleCaret) &&
            Number(paragraph.typingStyleCaret) >= 0
        )
      if (paragraph.list != null) {
        const list = paragraph.list
        requireValid(
          record(list) &&
            Number.isInteger(list.level) &&
            Number(list.level) >= 0 &&
            Number(list.level) <= 100
        )
        requireValid(
          list.kind === 'bullet'
            ? typeof list.char === 'string'
            : list.kind === 'number' && typeof list.format === 'string'
        )
        if (list.startAt !== undefined)
          requireValid(Number.isSafeInteger(list.startAt) && Number(list.startAt) >= 0)
      }
    }
  }
}

function validateImage(mimeType: unknown, dataUrl: unknown): void {
  requireValid(typeof mimeType === 'string' && typeof dataUrl === 'string')
  const prefix = `data:${mimeType};base64,`
  requireValid(dataUrl.startsWith(prefix))
  const encoded = dataUrl.slice(prefix.length)
  requireValid(encoded.length <= 4 * Math.ceil((20 * 1024 * 1024) / 3))
  const data = atob(encoded)
  requireValid(data.length > 0 && data.length <= 20 * 1024 * 1024 && btoa(data) === encoded)
  switch (mimeType) {
    case 'image/png':
      requireValid(data.startsWith('\x89PNG\r\n\x1a\n'))
      break
    case 'image/jpeg':
      requireValid(data.startsWith('\xff\xd8\xff'))
      break
    case 'image/gif':
      requireValid(data.startsWith('GIF87a') || data.startsWith('GIF89a'))
      break
    case 'image/bmp':
      requireValid(data.startsWith('BM'))
      break
    case 'image/webp':
      requireValid(
        data.length >= 16 &&
          data.startsWith('RIFF') &&
          data.slice(8, 12) === 'WEBP' &&
          data.slice(12, 15) === 'VP8'
      )
      break
    default:
      throw new Error('Unsupported portable presentation image')
  }
}

// Keep graph, image and geometry limits aligned with asset-api ValidatePersonalDeck.
export function validatePortablePresentation(
  document: Partial<EditablePresentationDocument>
): void {
  requireValid(record(document))
  if (document.schemaVersion !== undefined && document.schemaVersion !== 1) {
    throw new Error('Unsupported presentation schema version')
  }
  requireValid(typeof document.id === 'string' && document.id.trim())
  requireValid(typeof document.name === 'string' && document.name.trim())
  requireValid(dimension(document.width) && dimension(document.height))
  background(document.defaultSlideBackground)
  orderedMap(document.slideOrder, document.slides, 2000)
  const themes = document.themes ?? {}
  const assets = document.assets ?? {}
  requireValid(record(themes) && Object.keys(themes).length <= 2000)
  requireValid(record(assets) && Object.keys(assets).length <= 10000)
  requireValid(!document.defaultThemeId || Object.hasOwn(themes, document.defaultThemeId))
  let totalElements = 0
  for (const [id, slide] of Object.entries(document.slides ?? {})) {
    requireValid(record(slide) && slide.id === id)
    background(slide.background)
    requireValid(!slide.themeId || Object.hasOwn(themes, slide.themeId))
    orderedMap(slide.elementOrder, slide.elements, 10000)
    totalElements += slide.elementOrder.length
    requireValid(totalElements <= 100000)
    for (const [elementId, element] of Object.entries(slide.elements)) {
      requireValid(record(element) && element.id === elementId)
      requireValid(coordinate(element.x) && coordinate(element.y) && coordinate(element.rotation))
      requireValid(
        typeof element.opacity === 'number' &&
          Number.isFinite(element.opacity) &&
          element.opacity >= 0 &&
          element.opacity <= 1
      )
      if (element.type === 'line') {
        requireValid(coordinate(element.width) && coordinate(element.height))
      } else {
        requireValid(dimension(element.width) && dimension(element.height))
      }
      requireValid(['text', 'image', 'shape', 'line', 'locked'].includes(element.type))
      if (element.type === 'text') textElement(element)
      if (element.type === 'shape')
        requireValid(['rectangle', 'ellipse'].includes(element.shape) && color(element.fillColor))
      if (element.type === 'line' || element.type === 'shape')
        requireValid(
          color(element.strokeColor) && coordinate(element.strokeWidth) && element.strokeWidth >= 0
        )
      if (element.type === 'image' && element.borderColor !== undefined)
        requireValid(color(element.borderColor))
      if (element.type === 'image') requireValid(Object.hasOwn(assets, element.assetId))
    }
  }
  for (const [id, theme] of Object.entries(themes)) {
    requireValid(record(theme) && theme.id === id && record(theme.colorScheme))
    textStyle(theme.defaultTextStyle)
    for (const value of Object.values(theme.colorScheme)) requireValid(color(value))
  }
  for (const [id, asset] of Object.entries(assets)) {
    requireValid(id && record(asset) && asset.id === id)
    validateImage(asset.mimeType, asset.dataUrl)
  }
}
