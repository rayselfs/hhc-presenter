import {
  getSortedGradientStops,
  normalizeSlideBackground,
  type EditablePresentationDocument,
  type EditablePresentationElement,
  type EditableTextElement,
  type EditableTextRun,
  type EditableTextStyle
} from './editable-presentation'
import { normalizeTextParagraphs, resolveParagraphListNumbers } from './presentation-rich-text'

export const DRAWINGML_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
export const PRESENTATIONML_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
export const OFFICE_RELATIONSHIPS_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'

export interface PptxExportDiagnostic {
  code: 'unsupported-content' | 'invalid-value' | 'source-conflict' | 'package-limit'
  message: string
  slideId?: string
  elementId?: string
}

export class PptxExportError extends Error {
  constructor(
    public readonly diagnostics: PptxExportDiagnostic[],
    options?: ErrorOptions
  ) {
    super(diagnostics.map((entry) => entry.message).join('\n'), options)
    this.name = 'PptxExportError'
  }
}

type Attributes = Record<string, string | number>

export function writeSlideDrawingMl(
  document: EditablePresentationDocument,
  slideId: string,
  imageRelationshipIds: ReadonlyMap<string, string>
): XMLDocument {
  let elementId: string | undefined
  const fail = (message: string, code: PptxExportDiagnostic['code'] = 'invalid-value'): never => {
    throw new PptxExportError([{ code, message, slideId, elementId }])
  }
  const slide = document.slides[slideId]
  if (!slide) fail('The slide is missing')
  const xml = globalThis.document.implementation.createDocument(PRESENTATIONML_NS, 'p:sld')
  const root = xml.documentElement
  for (const [prefix, uri] of [
    ['p', PRESENTATIONML_NS],
    ['a', DRAWINGML_NS],
    ['r', OFFICE_RELATIONSHIPS_NS]
  ]) {
    root.setAttributeNS(XMLNS_NS, `xmlns:${prefix}`, uri)
  }
  const add = (parent: Element, name: string, attributes: Attributes = {}): Element => {
    const node = xml.createElementNS(name.startsWith('p:') ? PRESENTATIONML_NS : DRAWINGML_NS, name)
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value))
    parent.appendChild(node)
    return node
  }
  const integer = (value: number, scale = 1): number => {
    const result = Math.round(value * scale)
    if (!Number.isFinite(value) || !Number.isSafeInteger(result))
      fail('A numeric property cannot be exported')
    return result
  }
  const emu = (value: number): number => integer(value, 9525)
  const angle = (value: number): number => integer(((value % 360) + 360) % 360, 60000)
  const fraction = (value: number): number => {
    if (!Number.isFinite(value) || value < 0 || value > 1)
      fail('An opacity or crop fraction is out of range')
    return integer(value, 100000)
  }
  const safeText = (value: string): string => {
    for (const character of value) {
      const point = character.codePointAt(0)!
      if (
        (point < 32 && point !== 9 && point !== 10 && point !== 13) ||
        (point >= 0xd800 && point <= 0xdfff) ||
        point === 0xfffe ||
        point === 0xffff
      ) {
        fail('Text contains a character that XML cannot represent')
      }
    }
    return value
  }
  const color = (value: string): { channels: number[]; alpha: number } => {
    if (!value || /currentcolor|\b(?:inherit|initial|unset|revert)\b|var\(|env\(/i.test(value)) {
      fail(`The color "${value}" cannot be resolved for PPTX export`)
    }
    const probe = globalThis.document.createElement('span')
    probe.style.color = value
    if (!probe.style.color) fail(`The color "${value}" is invalid`)
    globalThis.document.body.appendChild(probe)
    let resolved: string
    try {
      resolved = getComputedStyle(probe).color
    } finally {
      probe.remove()
    }
    const match = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(
      resolved
    )
    if (!match) return fail(`The color "${value}" cannot be represented as RGB`)
    return {
      channels: match.slice(1, 4).map(Number),
      alpha: match[4] === undefined ? 1 : Number(match[4])
    }
  }
  const colorNode = (parent: Element, value: string, opacity = 1, brightness = 0): void => {
    const parsed = color(value)
    const channels = parsed.channels.map((channel) =>
      Math.round(
        brightness >= 0
          ? channel + ((255 - channel) * brightness) / 100
          : channel * (1 + brightness / 100)
      )
    )
    const node = add(parent, 'a:srgbClr', {
      val: channels
        .map((channel) => channel.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()
    })
    const alpha = fraction(parsed.alpha * opacity)
    if (alpha !== 100000) add(node, 'a:alpha', { val: alpha })
  }
  const fill = (parent: Element, value: string, opacity = 1): void => {
    colorNode(add(parent, 'a:solidFill'), value, opacity)
  }
  const outline = (parent: Element, value: string, width: number, opacity: number): void => {
    if (width < 0) fail('Outline width cannot be negative')
    const line = add(parent, 'a:ln', { w: emu(width) })
    if (width === 0) add(line, 'a:noFill')
    else fill(line, value, opacity)
    add(line, 'a:prstDash', { val: 'solid' })
  }
  const transform = (parent: Element, element: EditablePresentationElement): void => {
    if (element.width < 0 || element.height < 0) fail('Element dimensions cannot be negative')
    fraction(element.opacity)
    const xfrm = add(parent, 'a:xfrm', { rot: angle(element.rotation) })
    add(xfrm, 'a:off', { x: emu(element.x), y: emu(element.y) })
    add(xfrm, 'a:ext', { cx: emu(element.width), cy: emu(element.height) })
  }
  // Adapted property ordering from DeckCraft v0.5.0 write/dml.rs rpr; see THIRD_PARTY_NOTICES.md.
  const runProperties = (
    parent: Element,
    name: string,
    style: EditableTextRun | EditableTextStyle,
    opacity: number
  ): void => {
    if (style.fontSize <= 0 || style.fontSize * 75 > 400000)
      fail('Font size exceeds the PowerPoint limit')
    const node = add(parent, name, {
      sz: integer(style.fontSize, 75),
      b: style.bold ? 1 : 0,
      i: style.italic ? 1 : 0,
      u: style.underline ? 'sng' : 'none',
      strike: style.strikethrough ? 'sngStrike' : 'noStrike',
      spc: integer(style.characterSpacing ?? 0, 75),
      baseline:
        style.baseline === 'superscript' ? 30000 : style.baseline === 'subscript' ? -25000 : 0
    })
    if (/\bTC\b/.test(style.fontFamily)) node.setAttribute('lang', 'zh-TW')
    else if (/\bSC\b/.test(style.fontFamily)) node.setAttribute('lang', 'zh-CN')
    fill(node, style.color, opacity)
    if (style.highlightColor) colorNode(add(node, 'a:highlight'), style.highlightColor, opacity)
    for (const kind of ['latin', 'ea', 'cs'])
      add(node, `a:${kind}`, { typeface: safeText(style.fontFamily) })
  }
  const textBody = (parent: Element, element: EditableTextElement): void => {
    const body = add(parent, 'p:txBody')
    const insets = element.textInsets ?? { top: 0, right: 0, bottom: 0, left: 0 }
    const properties = add(body, 'a:bodyPr', {
      wrap: element.autoWidth ? 'none' : 'square',
      anchor:
        element.verticalAlign === 'center' ? 'ctr' : element.verticalAlign === 'bottom' ? 'b' : 't',
      lIns: emu(insets.left),
      rIns: emu(insets.right),
      tIns: emu(insets.top),
      bIns: emu(insets.bottom)
    })
    add(properties, element.autoSize === 'content' ? 'a:spAutoFit' : 'a:noAutofit')
    add(body, 'a:lstStyle')
    const paragraphs = normalizeTextParagraphs(element)
    const listNumbers = resolveParagraphListNumbers(paragraphs)
    for (const [index, paragraph] of paragraphs.entries()) {
      const para = add(body, 'a:p')
      const properties = add(para, 'a:pPr', {
        algn:
          paragraph.align === 'justify'
            ? 'just'
            : paragraph.align === 'center'
              ? 'ctr'
              : paragraph.align === 'right'
                ? 'r'
                : 'l',
        marL: emu(paragraph.marginLeft),
        indent: emu(paragraph.textIndent),
        lvl: paragraph.list?.level ?? 0
      })
      const spacing = add(properties, 'a:lnSpc')
      if (paragraph.lineSpacing.kind === 'exact')
        add(spacing, 'a:spcPts', { val: integer(paragraph.lineSpacing.points, 100) })
      else add(spacing, 'a:spcPct', { val: integer(paragraph.lineSpacing.value, 100000) })
      if (!paragraph.list) add(properties, 'a:buNone')
      else if (paragraph.list.kind === 'bullet') {
        if (paragraph.list.font)
          add(properties, 'a:buFont', { typeface: safeText(paragraph.list.font) })
        add(properties, 'a:buChar', { char: safeText(paragraph.list.char || '•') })
      } else {
        const start = listNumbers[index]!
        if (start < 1 || start > 32767) fail('List numbering exceeds the PowerPoint limit')
        // The current editor renders decimal markers regardless of the imported numbering format.
        add(properties, 'a:buAutoNum', { type: 'arabicPeriod', startAt: start })
      }
      for (const run of paragraph.runs) {
        const node = add(para, 'a:r')
        runProperties(node, 'a:rPr', run, element.opacity)
        const text = add(node, 'a:t')
        text.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
        text.textContent = safeText(run.text)
      }
      if (paragraph.typingStyle)
        runProperties(para, 'a:endParaRPr', paragraph.typingStyle, element.opacity)
    }
  }
  const common = add(root, 'p:cSld', { name: safeText(slide.name) })
  const background = normalizeSlideBackground(slide.background)
  const bg = add(add(common, 'p:bg'), 'p:bgPr')
  if (background.type === 'solid') fill(bg, background.color, 1 - background.transparency / 100)
  else if (background.type === 'gradient' && 'stops' in background) {
    const gradient = add(bg, 'a:gradFill', { rotWithShape: 1 })
    const stops = add(gradient, 'a:gsLst')
    for (const stop of getSortedGradientStops(background.stops)) {
      const node = add(stops, 'a:gs', { pos: integer(stop.position, 1000) })
      colorNode(node, stop.color, 1 - stop.transparency / 100, stop.brightness)
    }
    add(gradient, 'a:lin', { ang: angle(background.angle - 90), scaled: 1 })
  } else fail('The background cannot be exported', 'unsupported-content')
  add(bg, 'a:effectLst')
  const tree = add(common, 'p:spTree')
  const group = add(tree, 'p:nvGrpSpPr')
  add(group, 'p:cNvPr', { id: 1, name: '' })
  add(group, 'p:cNvGrpSpPr')
  add(group, 'p:nvPr')
  const groupTransform = add(add(tree, 'p:grpSpPr'), 'a:xfrm')
  add(groupTransform, 'a:off', { x: 0, y: 0 })
  add(groupTransform, 'a:ext', { cx: 0, cy: 0 })
  add(groupTransform, 'a:chOff', { x: 0, y: 0 })
  add(groupTransform, 'a:chExt', { cx: 0, cy: 0 })
  for (const [index, id] of slide.elementOrder.entries()) {
    elementId = id
    const element = slide.elements[id]
    if (!element) fail('An ordered element is missing')
    if (element.type === 'locked')
      fail(`Unsupported editable object: ${element.label}`, 'unsupported-content')
    const image = element.type === 'image'
    const node = add(tree, image ? 'p:pic' : 'p:sp')
    const nonVisual = add(node, image ? 'p:nvPicPr' : 'p:nvSpPr')
    add(nonVisual, 'p:cNvPr', { id: index + 2, name: safeText(id) })
    add(
      nonVisual,
      image ? 'p:cNvPicPr' : 'p:cNvSpPr',
      image ? {} : { txBox: element.type === 'text' ? 1 : 0 }
    )
    add(nonVisual, 'p:nvPr')
    if (element.type === 'image') {
      const relationship = imageRelationshipIds.get(element.assetId)
      if (!relationship) return fail('The image relationship is missing')
      const imageFill = add(node, 'p:blipFill')
      const blip = add(imageFill, 'a:blip')
      blip.setAttributeNS(OFFICE_RELATIONSHIPS_NS, 'r:embed', relationship)
      if (element.opacity !== 1) add(blip, 'a:alphaModFix', { amt: fraction(element.opacity) })
      if (element.crop)
        add(imageFill, 'a:srcRect', {
          t: fraction(element.crop.top),
          r: fraction(element.crop.right),
          b: fraction(element.crop.bottom),
          l: fraction(element.crop.left)
        })
      add(add(imageFill, 'a:stretch'), 'a:fillRect')
    }
    const properties = add(node, 'p:spPr')
    transform(properties, element)
    add(
      add(properties, 'a:prstGeom', {
        prst:
          element.type === 'shape' && element.shape === 'ellipse'
            ? 'ellipse'
            : element.type === 'line'
              ? 'line'
              : 'rect'
      }),
      'a:avLst'
    )
    if (element.type === 'shape') {
      fill(properties, element.fillColor, element.opacity)
      outline(properties, element.strokeColor, element.strokeWidth, element.opacity)
    } else if (element.type === 'line') {
      add(properties, 'a:noFill')
      outline(properties, element.strokeColor, element.strokeWidth, element.opacity)
    } else if (element.type === 'text') {
      add(properties, 'a:noFill')
      outline(properties, 'transparent', 0, 1)
      textBody(node, element)
    } else if (element.type === 'image') {
      outline(
        properties,
        element.borderColor ?? '#ffffff',
        element.borderWidth ?? 0,
        element.opacity
      )
      if (element.shadow && element.shadow !== 'none') {
        const medium = element.shadow === 'medium'
        const shadow = add(add(properties, 'a:effectLst'), 'a:outerShdw', {
          blurRad: emu(medium ? 32 : 20),
          dist: emu(medium ? 14 : 8),
          dir: 5400000,
          algn: 'ctr',
          rotWithShape: 0
        })
        colorNode(shadow, '#000000', (medium ? 0.32 : 0.22) * element.opacity)
      }
    }
  }
  add(add(root, 'p:clrMapOvr'), 'a:masterClrMapping')
  return xml
}
