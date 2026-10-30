import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import {
  createPresentationDraft,
  getPresentationDraft,
  isReadonlyPresentationSource
} from './presentation-drafts'
import { getBlobId } from './blob-identity'
import { openFileExplorerDB } from './file-explorer-db'
import { EDITABLE_PRESENTATION_MIME_TYPE } from './presentation-media'
import { readPresentationArrayBuffer } from './presentation-source'
import { persistEditablePresentationCreation } from './editable-presentation-creation'
import { normalizeTextParagraphs, resolveParagraphListNumbers } from './presentation-rich-text'
import {
  validatePortablePresentation,
  serializePortablePresentation,
  assertPortablePresentationSize
} from './portable-presentation'
import { readPptxNotes } from './pptx-notes'
import { validatePptxSource } from './pptx-source'
import {
  assertEditablePptxDocument,
  assertEditablePptxFeatures,
  assertEditablePptxPackage,
  PptxCompatibilityError,
  locatePptxCompatibilityError
} from './pptx-compatibility'
import { FOLDER_DURATION_MS, type FileItemRecord } from '@shared/types/folder'
import type { PlaceholderInfo, PresentationData } from '@aiden0z/pptx-renderer'
import type { SlideData, SlideNode } from '@aiden0z/pptx-renderer'
import type { PicNodeData, ShapeNodeData, ThemeData } from '@aiden0z/pptx-renderer'

export const EDITABLE_PRESENTATION_DOCUMENT_KIND = 'editable-presentation-document'

export type EditablePresentationElementType = 'text' | 'image' | 'shape' | 'line' | 'locked'
export type EditableTextAlign = 'left' | 'center' | 'right' | 'justify'
export type EditableShapeKind = 'rectangle' | 'ellipse'
export type EditableGradientDirection = 'left-right' | 'top-bottom' | 'diagonal'
export type EditableGradientType = 'linear'
export type EditableImageShadow = 'none' | 'soft' | 'medium'

export interface EditableGradientStop {
  color: string
  position: number
  transparency: number
  brightness: number
}

export type EditableSlideBackground =
  | { type: 'solid'; color: string; transparency: number }
  | {
      type: 'gradient'
      gradientType: EditableGradientType
      direction: EditableGradientDirection
      angle: number
      stops: EditableGradientStop[]
    }
  | { type: 'gradient'; from: string; to: string; direction: EditableGradientDirection }
  | { type: 'color'; color: string }

export interface EditablePresentationAsset {
  id: string
  name: string
  mimeType: string
  dataUrl: string
}

export interface EditableTextInsertFrame {
  x: number
  y: number
  width: number
  height: number
  autoSize: EditableTextAutoSize
  autoWidth: boolean
}

export interface EditableImageInsertInput {
  assetId: string
  slideWidth: number
  slideHeight: number
  sourceWidth: number
  sourceHeight: number
}

export interface PptxSource {
  version: 1
  base64: string
  sha256: string
}

export interface PptxSourceNode {
  id: string
  role: 'geometry' | 'text' | 'image'
}

interface EditableElementBase {
  id: string
  type: EditablePresentationElementType
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
  locked?: boolean
  pptxSourceNode?: PptxSourceNode
}

export interface EditableTextElement extends EditableElementBase {
  type: 'text'
  autoWidth?: boolean
  verticalAlign?: 'top' | 'center' | 'bottom'
  textInsets?: { top: number; right: number; bottom: number; left: number }
  autoSize?: EditableTextAutoSize
  text: string
  runs?: EditableTextRun[]
  fontFamily: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  strikethrough?: boolean
  baseline?: 'normal' | 'superscript' | 'subscript'
  characterSpacing?: number
  color: string
  highlightColor?: string | null
  align: EditableTextAlign
  lineHeight: number
  paragraphs?: EditableTextParagraph[]
}

export interface EditableTextRun {
  text: string
  fontFamily: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  color: string
  strikethrough?: boolean
  baseline?: 'normal' | 'superscript' | 'subscript'
  characterSpacing?: number
  highlightColor?: string | null
}

export type EditableLineSpacing =
  | { kind: 'multiple'; value: number }
  | { kind: 'exact'; points: number }

export type EditableListStyle =
  | { kind: 'bullet'; level: number; char: string; font?: string }
  | {
      kind: 'number'
      level: number
      format: string
      startAt?: number
      sequenceId?: string
    }

export interface EditableTextParagraph {
  runs: EditableTextRun[]
  typingStyle?: EditableTextStyle
  typingStyleCaret?: number
  align: EditableTextAlign
  lineSpacing: EditableLineSpacing
  list: EditableListStyle | null
  marginLeft: number
  textIndent: number
}

export interface EditableTextStyle {
  fontFamily: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  strikethrough: boolean
  baseline: 'normal' | 'superscript' | 'subscript'
  characterSpacing: number
  color: string
  highlightColor: string | null
}

export type EditableThemeColorSlot =
  | 'dk1'
  | 'dk2'
  | 'lt1'
  | 'lt2'
  | 'accent1'
  | 'accent2'
  | 'accent3'
  | 'accent4'
  | 'accent5'
  | 'accent6'
  | 'hlink'
  | 'folHlink'

export interface EditablePresentationTheme {
  id: string
  defaultTextStyle: EditableTextStyle
  colorScheme: Record<EditableThemeColorSlot, string>
}

export interface EditableImageElement extends EditableElementBase {
  type: 'image'
  assetId: string
  crop?: { top: number; right: number; bottom: number; left: number }
  borderColor?: string
  borderWidth?: number
  shadow?: EditableImageShadow
}

export interface EditableShapeElement extends EditableElementBase {
  type: 'shape'
  shape: EditableShapeKind
  fillColor: string
  strokeColor: string
  strokeWidth: number
}

export interface EditableLineElement extends EditableElementBase {
  type: 'line'
  strokeColor: string
  strokeWidth: number
}

export interface EditableLockedElement extends EditableElementBase {
  type: 'locked'
  label: string
}

export type EditablePresentationElement =
  | EditableTextElement
  | EditableImageElement
  | EditableShapeElement
  | EditableLineElement
  | EditableLockedElement

export interface EditablePresentationSlide {
  pptxSourcePart?: string
  id: string
  name: string
  background: EditableSlideBackground
  elementOrder: string[]
  elements: Record<string, EditablePresentationElement>
  notes: string
  themeId?: string
}

export interface EditablePresentationDocument {
  schemaVersion?: 1 | 2
  pptxSource?: PptxSource
  id: string
  name: string
  sourceItemId?: string
  sourceBlobId?: string
  width: number
  height: number
  defaultSlideBackground?: EditableSlideBackground
  slideOrder: string[]
  slides: Record<string, EditablePresentationSlide>
  assets: Record<string, EditablePresentationAsset>
  themes?: Record<string, EditablePresentationTheme>
  defaultThemeId?: string
  createdAt: number
  updatedAt: number
}

type EditablePresentationSource = Pick<FileItemRecord, 'id' | 'url' | 'name'>

export interface EditablePresentationSnapshot {
  document: EditablePresentationDocument
  revision: number
}

const DEFAULT_WIDTH = 1920
const DEFAULT_HEIGHT = 1080
const DEFAULT_FONT_FAMILY = 'Inter Variable'
export const DEFAULT_SLIDE_BACKGROUND_COLOR = '#ffffff'
const DEFAULT_FOREGROUND_COLOR = '#111827'
export const DEFAULT_PRESENTATION_THEME_ID = 'office-default'
export type EditableTextAutoSize = 'content' | 'fixed'

export function hasContentHeight(
  element: Pick<EditableTextElement, 'autoSize' | 'autoWidth'>
): boolean {
  return (
    element.autoSize === 'content' || (element.autoSize === undefined && element.autoWidth === true)
  )
}

export const INSERTED_TEXT_FONT_SIZE_POINTS = 24
export const INSERTED_TEXT_CLICK_SIZE = { width: 24, height: 32 } as const
export const INSERTED_TEXT_DRAG_MIN_SIZE = { width: 80, height: 40 } as const
export const CONTENT_HEIGHT_TEXT_PADDING_X = 8
export const CONTENT_HEIGHT_TEXT_PADDING_Y = 4
export const INSERTED_IMAGE_MAX_SLIDE_RATIO = 0.6
const EMU_PER_INCH = 914400
const CSS_PX_PER_INCH = 96
const RAW_EMU_THRESHOLD = 100000
const POWERPOINT_STANDARD_WIDTH_POINTS = 960

export function presentationPointsToCanvasPx(points: number, documentWidth: number): number {
  return (points * documentWidth) / POWERPOINT_STANDARD_WIDTH_POINTS
}

export function presentationCanvasPxToPoints(px: number, documentWidth: number): number {
  return (px * POWERPOINT_STANDARD_WIDTH_POINTS) / documentWidth
}

export function createDefaultPresentationTheme(
  documentWidth = DEFAULT_WIDTH
): EditablePresentationTheme {
  return {
    id: DEFAULT_PRESENTATION_THEME_ID,
    defaultTextStyle: {
      fontFamily: DEFAULT_FONT_FAMILY,
      fontSize: presentationPointsToCanvasPx(INSERTED_TEXT_FONT_SIZE_POINTS, documentWidth),
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
      baseline: 'normal',
      characterSpacing: 0,
      color: DEFAULT_FOREGROUND_COLOR,
      highlightColor: null
    },
    colorScheme: {
      dk1: '#000000',
      dk2: '#44546a',
      lt1: '#ffffff',
      lt2: '#e7e6e6',
      accent1: '#4472c4',
      accent2: '#ed7d31',
      accent3: '#a5a5a5',
      accent4: '#ffc000',
      accent5: '#5b9bd5',
      accent6: '#70ad47',
      hlink: '#0563c1',
      folHlink: '#954f72'
    }
  }
}

type XmlNode = ShapeNodeData['source']

type TextShapeFrame = {
  x: number
  y: number
  width: number
  height: number
}

type TextShapeStyle = Pick<
  EditableTextStyle,
  'strikethrough' | 'baseline' | 'characterSpacing' | 'highlightColor'
> & {
  fontFamily: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  color: string
  align: EditableTextAlign
  lineHeight: number
}

type PlaceholderEntryCandidate = {
  node: XmlNode
  absoluteXfrm?: {
    position: { x: number; y: number }
    size: { w: number; h: number }
  }
}

type MasterPlaceholderSource = {
  placeholderEntries?: readonly PlaceholderEntryCandidate[]
  placeholders: readonly XmlNode[]
}

export const DEFAULT_GRADIENT_BACKGROUND: Extract<
  EditableSlideBackground,
  { type: 'gradient'; stops: EditableGradientStop[] }
> = {
  type: 'gradient',
  gradientType: 'linear',
  direction: 'top-bottom',
  angle: 180,
  stops: [
    { color: DEFAULT_SLIDE_BACKGROUND_COLOR, position: 0, transparency: 0, brightness: 0 },
    { color: '#dbeafe', position: 100, transparency: 0, brightness: 0 }
  ]
}

export function createDefaultSlideBackground(): EditableSlideBackground {
  return { type: 'solid', color: DEFAULT_SLIDE_BACKGROUND_COLOR, transparency: 0 }
}

export function normalizeSlideBackground(
  background: EditableSlideBackground | undefined
): EditableSlideBackground {
  if (!background) return createDefaultSlideBackground()
  if (background.type === 'color')
    return { type: 'solid', color: background.color, transparency: 0 }
  if (background.type === 'solid')
    return { ...background, transparency: background.transparency ?? 0 }
  if ('from' in background) {
    return {
      type: 'gradient',
      gradientType: 'linear',
      direction: background.direction,
      angle: getGradientAngleFromDirection(background.direction),
      stops: [
        { color: background.from, position: 0, transparency: 0, brightness: 0 },
        { color: background.to, position: 100, transparency: 0, brightness: 0 }
      ]
    }
  }
  return background
}

export function cloneSlideBackground(background: EditableSlideBackground): EditableSlideBackground {
  const normalized = normalizeSlideBackground(background)
  if (normalized.type === 'gradient' && 'stops' in normalized) {
    return { ...normalized, stops: normalized.stops.map((stop) => ({ ...stop })) }
  }
  if (normalized.type === 'solid') return { ...normalized }
  return { ...normalized }
}

export function getGradientAngleFromDirection(direction: EditableGradientDirection): number {
  return {
    'left-right': 90,
    'top-bottom': 180,
    diagonal: 135
  }[direction]
}

export function getSortedGradientStops(stops: EditableGradientStop[]): EditableGradientStop[] {
  return [...stops]
    .map((stop) => ({
      color: stop.color,
      position: clampPercentage(stop.position),
      transparency: clampPercentage(stop.transparency),
      brightness: Math.max(-100, Math.min(100, stop.brightness))
    }))
    .sort((a, b) => a.position - b.position)
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function colorWithTransparency(color: string, transparency: number): string {
  const rgb = parseHexColor(color)
  if (!rgb) return color
  const opacity = 1 - clampPercentage(transparency) / 100
  const blend = (value: number): number => Math.round(value * opacity + 255 * (1 - opacity))
  return rgbToHex(blend(rgb.red), blend(rgb.green), blend(rgb.blue))
}

function applyBrightness(color: string, brightness: number): string {
  const rgb = parseHexColor(color)
  if (!rgb || brightness === 0) return color
  const amount = Math.max(-100, Math.min(100, brightness)) / 100
  const adjust = (value: number): number => {
    const next = amount >= 0 ? value + (255 - value) * amount : value * (1 + amount)
    return Math.round(Math.max(0, Math.min(255, next)))
  }
  return rgbToHex(adjust(rgb.red), adjust(rgb.green), adjust(rgb.blue))
}

function parseHexColor(color: string): { red: number; green: number; blue: number } | null {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color.trim())
  if (!match) return null
  return {
    red: parseInt(match[1], 16),
    green: parseInt(match[2], 16),
    blue: parseInt(match[3], 16)
  }
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

export function getSlideBackgroundOutline(
  background: EditableSlideBackground
): 'light' | 'dark' | 'mixed' {
  const normalized = normalizeSlideBackground(background)
  const colors =
    normalized.type === 'gradient' && 'stops' in normalized
      ? normalized.stops.map((stop) =>
          colorWithTransparency(applyBrightness(stop.color, stop.brightness), stop.transparency)
        )
      : [getSlideBackgroundCss(normalized)]
  const outlines = new Set(
    colors.map((color) => {
      const rgb = parseHexColor(color)
      if (!rgb) return 'mixed'
      const linear = [rgb.red, rgb.green, rgb.blue].map((value) => {
        const channel = value / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 < 0.179 ? 'light' : 'dark'
    })
  )
  return outlines.size === 1 ? [...outlines][0] : 'mixed'
}

export function getSlideBackgroundPrimaryColor(background: EditableSlideBackground): string {
  const normalized = normalizeSlideBackground(background)
  if (normalized.type !== 'gradient') return normalized.color
  if ('stops' in normalized) return normalized.stops[0]?.color ?? '#ffffff'
  return normalized.from
}

export function getSlideBackgroundCss(background: EditableSlideBackground): string {
  const normalized = normalizeSlideBackground(background)
  if (normalized.type !== 'gradient') {
    if (normalized.type !== 'solid') return DEFAULT_SLIDE_BACKGROUND_COLOR
    return colorWithTransparency(normalized.color, normalized.transparency)
  }
  const modern = 'stops' in normalized ? normalized : normalizeSlideBackground(normalized)
  if (modern.type !== 'gradient' || !('stops' in modern)) return '#ffffff'
  const stops = getSortedGradientStops(modern.stops)
    .map(
      (stop) =>
        `${colorWithTransparency(applyBrightness(stop.color, stop.brightness), stop.transparency)} ${stop.position}%`
    )
    .join(', ')
  return `linear-gradient(${modern.angle}deg, ${stops})`
}

export function createBlankEditablePresentationDocument(
  name: string,
  id = crypto.randomUUID()
): EditablePresentationDocument {
  const slideId = crypto.randomUUID()
  const now = Date.now()
  const theme = createDefaultPresentationTheme()
  return {
    id,
    name,
    schemaVersion: 1,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    defaultSlideBackground: createDefaultSlideBackground(),
    slideOrder: [slideId],
    slides: {
      [slideId]: {
        id: slideId,
        name: 'Slide 1',
        background: createDefaultSlideBackground(),
        elementOrder: [],
        elements: {},
        notes: '',
        themeId: theme.id
      }
    },
    assets: {},
    themes: { [theme.id]: theme },
    defaultThemeId: theme.id,
    createdAt: now,
    updatedAt: now
  }
}

export function createTextElement(
  input: Partial<Omit<EditableTextElement, 'id' | 'type'>> = {}
): EditableTextElement {
  const autoSize: EditableTextAutoSize =
    input.autoSize ??
    (input.autoWidth === true || (input.autoWidth === undefined && input.width == null)
      ? 'content'
      : 'fixed')
  const fontSize =
    input.fontSize ?? presentationPointsToCanvasPx(INSERTED_TEXT_FONT_SIZE_POINTS, DEFAULT_WIDTH)
  const lineHeight = input.lineHeight ?? 1.15
  return {
    id: crypto.randomUUID(),
    type: 'text',
    autoWidth: input.autoWidth ?? autoSize === 'content',
    autoSize,
    x: input.x ?? 260,
    y: input.y ?? 220,
    width: input.width ?? (autoSize === 'content' ? INSERTED_TEXT_CLICK_SIZE.width : 220),
    height: input.height ?? Math.ceil(fontSize * lineHeight),
    rotation: input.rotation ?? 0,
    opacity: input.opacity ?? 1,
    text: input.text ?? '',
    runs: input.runs,
    paragraphs: input.paragraphs,
    fontFamily: input.fontFamily ?? DEFAULT_FONT_FAMILY,
    fontSize,
    bold: input.bold ?? false,
    italic: input.italic ?? false,
    underline: input.underline ?? false,
    strikethrough: input.strikethrough ?? false,
    baseline: input.baseline ?? 'normal',
    characterSpacing: input.characterSpacing ?? 0,
    color: input.color ?? DEFAULT_FOREGROUND_COLOR,
    highlightColor: input.highlightColor ?? null,
    align: input.align ?? 'left',
    lineHeight
  }
}

export function createShapeElement(
  shape: EditableShapeKind,
  input: Partial<Omit<EditableShapeElement, 'id' | 'type' | 'shape'>> = {}
): EditableShapeElement {
  return {
    id: crypto.randomUUID(),
    type: 'shape',
    shape,
    x: input.x ?? 360,
    y: input.y ?? 280,
    width: input.width ?? 360,
    height: input.height ?? 220,
    rotation: input.rotation ?? 0,
    opacity: input.opacity ?? 1,
    fillColor: input.fillColor ?? '#2563eb',
    strokeColor: input.strokeColor ?? DEFAULT_FOREGROUND_COLOR,
    strokeWidth: input.strokeWidth ?? 0
  }
}

export function createLineElement(
  input: Partial<Omit<EditableLineElement, 'id' | 'type'>> = {}
): EditableLineElement {
  return {
    id: crypto.randomUUID(),
    type: 'line',
    x: input.x ?? 360,
    y: input.y ?? 360,
    width: input.width ?? 520,
    height: input.height ?? 0,
    rotation: input.rotation ?? 0,
    opacity: input.opacity ?? 1,
    strokeColor: input.strokeColor ?? DEFAULT_FOREGROUND_COLOR,
    strokeWidth: input.strokeWidth ?? 4
  }
}

export function createImageElement(input: EditableImageInsertInput): EditableImageElement {
  const sourceWidth = Math.max(1, input.sourceWidth)
  const sourceHeight = Math.max(1, input.sourceHeight)
  const maxWidth = input.slideWidth * INSERTED_IMAGE_MAX_SLIDE_RATIO
  const maxHeight = input.slideHeight * INSERTED_IMAGE_MAX_SLIDE_RATIO
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1)
  const width = Math.round(sourceWidth * scale)
  const height = Math.round(sourceHeight * scale)

  return {
    id: crypto.randomUUID(),
    type: 'image',
    assetId: input.assetId,
    x: Math.round((input.slideWidth - width) / 2),
    y: Math.round((input.slideHeight - height) / 2),
    width,
    height,
    rotation: 0,
    opacity: 1
  }
}

export function addElementToSlide(
  document: EditablePresentationDocument,
  slideId: string,
  element: EditablePresentationElement
): EditablePresentationDocument {
  const slide = document.slides[slideId]
  if (!slide) return document
  return {
    ...document,
    slides: {
      ...document.slides,
      [slideId]: {
        ...slide,
        elementOrder: [...slide.elementOrder, element.id],
        elements: { ...slide.elements, [element.id]: element }
      }
    },
    updatedAt: Date.now()
  }
}

export function updateElementInSlide(
  document: EditablePresentationDocument,
  slideId: string,
  elementId: string,
  updates: Partial<EditablePresentationElement>
): EditablePresentationDocument {
  const slide = document.slides[slideId]
  const element = slide?.elements[elementId]
  if (!slide || !element) return document
  if (!hasElementPatchChanges(element, updates)) return document
  return {
    ...document,
    slides: {
      ...document.slides,
      [slideId]: {
        ...slide,
        elements: {
          ...slide.elements,
          [elementId]: { ...element, ...updates } as EditablePresentationElement
        }
      }
    },
    updatedAt: Date.now()
  }
}

function hasElementPatchChanges(
  element: EditablePresentationElement,
  updates: Partial<EditablePresentationElement>
): boolean {
  return Object.entries(updates).some(([key, value]) => {
    if (key !== 'crop') return !Object.is(element[key as keyof EditablePresentationElement], value)
    if (element.type !== 'image') return true
    const current = normalizeImageCrop(element.crop)
    const next = normalizeImageCrop(
      value as Extract<EditablePresentationElement, { type: 'image' }>['crop']
    )
    return (
      current.top !== next.top ||
      current.right !== next.right ||
      current.bottom !== next.bottom ||
      current.left !== next.left
    )
  })
}

export function reorderElementInSlide(
  document: EditablePresentationDocument,
  slideId: string,
  elementId: string,
  action: 'bring-forward' | 'bring-to-front' | 'send-backward' | 'send-to-back'
): EditablePresentationDocument {
  const slide = document.slides[slideId]
  if (!slide || !slide.elements[elementId]) return document
  const currentIndex = slide.elementOrder.indexOf(elementId)
  if (currentIndex === -1) return document

  const elementOrder = [...slide.elementOrder]
  elementOrder.splice(currentIndex, 1)
  const nextIndex = (() => {
    if (action === 'bring-to-front') return elementOrder.length
    if (action === 'send-to-back') return 0
    if (action === 'bring-forward') return Math.min(elementOrder.length, currentIndex + 1)
    return Math.max(0, currentIndex - 1)
  })()

  elementOrder.splice(nextIndex, 0, elementId)
  return {
    ...document,
    slides: {
      ...document.slides,
      [slideId]: {
        ...slide,
        elementOrder
      }
    },
    updatedAt: Date.now()
  }
}

export function removeElementFromSlide(
  document: EditablePresentationDocument,
  slideId: string,
  elementId: string
): EditablePresentationDocument {
  const slide = document.slides[slideId]
  if (!slide?.elements[elementId]) return document
  const { [elementId]: _removed, ...elements } = slide.elements
  return {
    ...document,
    slides: {
      ...document.slides,
      [slideId]: {
        ...slide,
        elementOrder: slide.elementOrder.filter((id) => id !== elementId),
        elements
      }
    },
    updatedAt: Date.now()
  }
}

export function duplicateElementInSlide(
  document: EditablePresentationDocument,
  slideId: string,
  elementId: string
): { document: EditablePresentationDocument; elementId: string } {
  const slide = document.slides[slideId]
  const element = slide?.elements[elementId]
  if (!slide || !element) return { document, elementId }
  const nextElement = {
    ...element,
    id: crypto.randomUUID(),
    x: element.x + 24,
    y: element.y + 24
  } as EditablePresentationElement
  delete nextElement.pptxSourceNode
  return {
    document: addElementToSlide(document, slideId, nextElement),
    elementId: nextElement.id
  }
}

export function moveEditableSlide(
  document: EditablePresentationDocument,
  slideId: string,
  direction: -1 | 1
): EditablePresentationDocument {
  const index = document.slideOrder.indexOf(slideId)
  const nextIndex = index + direction
  if (index === -1 || nextIndex < 0 || nextIndex >= document.slideOrder.length) return document
  const slideOrder = [...document.slideOrder]
  const [moved] = slideOrder.splice(index, 1)
  slideOrder.splice(nextIndex, 0, moved)
  return { ...document, slideOrder, updatedAt: Date.now() }
}

export function duplicateEditableSlide(
  document: EditablePresentationDocument,
  slideId: string
): EditablePresentationDocument {
  const index = document.slideOrder.indexOf(slideId)
  if (index === -1) return document
  return duplicateEditableSlides(document, [slideId], index + 1).document
}

function cloneEditableSlide(slide: EditablePresentationSlide): {
  slide: EditablePresentationSlide
  slideId: string
} {
  const nextSlideId = crypto.randomUUID()
  const elementIdMap = new Map<string, string>()
  const elements: Record<string, EditablePresentationElement> = {}
  for (const sourceId of slide.elementOrder) {
    const element = slide.elements[sourceId]
    if (!element) continue
    const nextId = crypto.randomUUID()
    elementIdMap.set(sourceId, nextId)
    elements[nextId] = { ...element, id: nextId } as EditablePresentationElement
    delete elements[nextId].pptxSourceNode
  }
  const nextSlide: EditablePresentationSlide = {
    ...slide,
    id: nextSlideId,
    name: `${slide.name} Copy`,
    elementOrder: slide.elementOrder
      .map((sourceId) => elementIdMap.get(sourceId))
      .filter((id): id is string => Boolean(id)),
    elements
  }
  delete nextSlide.pptxSourcePart
  return { slide: nextSlide, slideId: nextSlideId }
}

export function duplicateEditableSlides(
  document: EditablePresentationDocument,
  slideIds: string[],
  targetIndex: number
): { document: EditablePresentationDocument; slideIds: string[] } {
  const requestedIds = new Set(slideIds)
  const sourceIds = document.slideOrder.filter((sourceId) => requestedIds.has(sourceId))
  if (sourceIds.length === 0) return { document, slideIds: [] }

  const safeIndex = Math.max(0, Math.min(targetIndex, document.slideOrder.length))
  const slides = { ...document.slides }
  const insertedSlideIds: string[] = []

  for (const sourceId of sourceIds) {
    const sourceSlide = document.slides[sourceId]
    if (!sourceSlide) continue
    const cloned = cloneEditableSlide(sourceSlide)
    slides[cloned.slideId] = cloned.slide
    insertedSlideIds.push(cloned.slideId)
  }

  const slideOrder = [
    ...document.slideOrder.slice(0, safeIndex),
    ...insertedSlideIds,
    ...document.slideOrder.slice(safeIndex)
  ]

  return {
    document: { ...document, slideOrder, slides, updatedAt: Date.now() },
    slideIds: insertedSlideIds
  }
}

export function addBlankEditableSlide(
  document: EditablePresentationDocument
): EditablePresentationDocument {
  const slideId = crypto.randomUUID()
  const background = cloneSlideBackground(
    document.defaultSlideBackground ?? createDefaultSlideBackground()
  )
  return {
    ...document,
    slideOrder: [...document.slideOrder, slideId],
    slides: {
      ...document.slides,
      [slideId]: {
        id: slideId,
        name: `Slide ${document.slideOrder.length + 1}`,
        background,
        elementOrder: [],
        elements: {},
        notes: ''
      }
    },
    updatedAt: Date.now()
  }
}

export function insertBlankEditableSlide(
  document: EditablePresentationDocument,
  targetIndex: number
): { document: EditablePresentationDocument; slideId: string } {
  const slideId = crypto.randomUUID()
  const background = cloneSlideBackground(
    document.defaultSlideBackground ?? createDefaultSlideBackground()
  )
  const safeIndex = Math.max(0, Math.min(targetIndex, document.slideOrder.length))
  return {
    document: {
      ...document,
      slideOrder: [
        ...document.slideOrder.slice(0, safeIndex),
        slideId,
        ...document.slideOrder.slice(safeIndex)
      ],
      slides: {
        ...document.slides,
        [slideId]: {
          id: slideId,
          name: `Slide ${document.slideOrder.length + 1}`,
          background,
          elementOrder: [],
          elements: {},
          notes: ''
        }
      },
      updatedAt: Date.now()
    },
    slideId
  }
}

export function updateSlideBackground(
  document: EditablePresentationDocument,
  slideId: string,
  background: EditableSlideBackground
): EditablePresentationDocument {
  const slide = document.slides[slideId]
  if (!slide) return document
  return {
    ...document,
    slides: {
      ...document.slides,
      [slideId]: {
        ...slide,
        background: cloneSlideBackground(background)
      }
    },
    updatedAt: Date.now()
  }
}

export function applySlideBackgroundToAllSlides(
  document: EditablePresentationDocument,
  background: EditableSlideBackground
): EditablePresentationDocument {
  const normalized = cloneSlideBackground(background)
  const slides: Record<string, EditablePresentationSlide> = {}
  for (const [slideId, slide] of Object.entries(document.slides)) {
    slides[slideId] = { ...slide, background: cloneSlideBackground(normalized) }
  }
  return {
    ...document,
    defaultSlideBackground: cloneSlideBackground(normalized),
    slides,
    updatedAt: Date.now()
  }
}

export function resetSlideBackground(
  document: EditablePresentationDocument,
  slideId: string
): EditablePresentationDocument {
  return updateSlideBackground(document, slideId, createDefaultSlideBackground())
}

export function updateSlideNotes(
  document: EditablePresentationDocument,
  slideId: string,
  notes: string
): EditablePresentationDocument {
  const slide = document.slides[slideId]
  if (!slide || slide.notes === notes) return document
  return {
    ...document,
    slides: {
      ...document.slides,
      [slideId]: { ...slide, notes }
    },
    updatedAt: Date.now()
  }
}

export function removeEditableSlide(
  document: EditablePresentationDocument,
  slideId: string
): EditablePresentationDocument {
  if (document.slideOrder.length <= 1) return document
  const { [slideId]: _removed, ...slides } = document.slides
  return {
    ...document,
    slideOrder: document.slideOrder.filter((id) => id !== slideId),
    slides,
    updatedAt: Date.now()
  }
}

export function removeEditableSlides(
  document: EditablePresentationDocument,
  slideIds: string[]
): EditablePresentationDocument {
  if (document.slideOrder.length <= 1) return document
  const requestedIds = new Set(slideIds)
  if (requestedIds.size === 0) return document
  if (document.slideOrder.every((id) => requestedIds.has(id))) {
    requestedIds.delete(document.slideOrder[0])
  }
  const slideOrder = document.slideOrder.filter((id) => !requestedIds.has(id))
  const slides = Object.fromEntries(
    Object.entries(document.slides).filter(([id]) => !requestedIds.has(id))
  )
  return {
    ...document,
    slideOrder,
    slides,
    updatedAt: Date.now()
  }
}

export async function createEditablePresentation(
  name: string,
  parentId: string
): Promise<FileItemRecord> {
  const itemId = crypto.randomUUID()
  const normalizedName = name.trim() || 'Untitled Presentation'
  const document = createBlankEditablePresentationDocument(normalizedName, itemId)
  return createEditablePresentationItem(document, parentId)
}

export async function convertPptxBytesToEditableDocument(
  bytes: ArrayBuffer,
  source: FileItemRecord
): Promise<EditablePresentationDocument> {
  const { parseZip, buildPresentation, materializeAllSlideNodes, RECOMMENDED_ZIP_LIMITS } =
    await import('@aiden0z/pptx-renderer')
  await assertEditablePptxPackage(bytes)
  const files = await parseZip(bytes, RECOMMENDED_ZIP_LIMITS)
  const presentation = buildPresentation(files)
  assertEditablePptxFeatures(files, presentation)
  materializeAllSlideNodes(presentation)
  const document = convertPresentationData(
    source,
    presentation,
    undefined,
    await readPptxNotes(bytes, presentation)
  )
  assertEditablePptxDocument(document, presentation)
  return document
}

export async function convertPptxToEditablePresentation(
  item: FileItemRecord
): Promise<FileItemRecord> {
  const ownerId = usePersonalSyncStore.getState().activeOwnerId
  const buffer = await readPresentationArrayBuffer(item)
  const document = await convertPptxBytesToEditableDocument(buffer, item)
  if (ownerId !== usePersonalSyncStore.getState().activeOwnerId)
    throw new Error('Personal account changed')
  if (await isReadonlyPresentationSource(item)) return createPresentationDraft(item, document)
  return createEditablePresentationItem(document, item.parentId)
}

export async function createEditablePresentationItem(
  document: EditablePresentationDocument,
  parentId: string,
  catalogName = document.name
): Promise<FileItemRecord> {
  const ownerId = usePersonalSyncStore.getState().activeOwnerId
  const blob = createDocumentBlob(document)
  await validatePptxSource(document)
  if (usePersonalSyncStore.getState().activeOwnerId !== ownerId)
    throw new Error('Personal account changed')
  const itemId = document.id
  const db = await openFileExplorerDB()
  const parent = await db.get('folder-records', parentId)
  const siblings = (await db.getAllFromIndex('folder-items', 'by-parent', parentId)).filter(
    (item) => item.deletedAt == null
  )
  const now = Date.now()
  const item: FileItemRecord = {
    id: itemId,
    ...(parent?.personalOwnerId ? { personalOwnerId: parent.personalOwnerId } : {}),
    parentId,
    type: 'file',
    sortIndex: Math.max(-1, ...siblings.map((item) => item.sortIndex)) + 1,
    createdAt: now,
    expiresAt: parentId === 'file-root' ? now + FOLDER_DURATION_MS['1day'] : null,
    name: catalogName,
    url: `blob:${itemId}`,
    size: blob.size,
    mimeType: EDITABLE_PRESENTATION_MIME_TYPE
  }
  await persistEditablePresentationCreation({
    item,
    blob,
    thumbnail: generateEditablePresentationThumbnail(document)
  })
  return item
}

export function convertPresentationData(
  source: FileItemRecord,
  presentation: PresentationData,
  pptxSource?: PptxSource,
  notesBySlide: ReadonlyMap<string, string> = new Map()
): EditablePresentationDocument {
  const documentId = crypto.randomUUID()
  const now = Date.now()
  const slides: Record<string, EditablePresentationSlide> = {}
  const slideOrder: string[] = []
  const assets: Record<string, EditablePresentationAsset> = {}
  const assetIdsByMediaPath = new Map<string, string>()
  const width = normalizeCanvasLength(presentation.width, DEFAULT_WIDTH)
  const themes = convertPresentationThemes(presentation, width)
  const defaultThemeId = Object.keys(themes)[0] ?? DEFAULT_PRESENTATION_THEME_ID

  for (const [slideIndex, slide] of presentation.slides.entries()) {
    const slideId = crypto.randomUUID()
    let convertedSlide: Omit<EditablePresentationSlide, 'id' | 'name'>
    try {
      convertedSlide = convertSlide(
        slide,
        presentation,
        assets,
        assetIdsByMediaPath,
        Boolean(pptxSource)
      )
    } catch (error) {
      throw locatePptxCompatibilityError(error, {
        slideNumber: slideIndex + 1,
        sourcePart: slide.slidePath
      })
    }
    slides[slideId] = {
      ...convertedSlide,
      notes: notesBySlide.get(slide.slidePath) ?? '',
      id: slideId,
      name: `Slide ${slide.index + 1}`,
      themeId: resolveSlideThemeId(slide, presentation) ?? defaultThemeId
    }
    slideOrder.push(slideId)
  }

  return {
    id: documentId,
    schemaVersion: pptxSource ? 2 : 1,
    ...(pptxSource ? { pptxSource } : {}),
    name: `${stripPresentationExtension(source.name)} Editable`,
    sourceItemId: source.id,
    sourceBlobId: getBlobId(source),
    width,
    height: normalizeCanvasLength(presentation.height, DEFAULT_HEIGHT),
    defaultSlideBackground: createDefaultSlideBackground(),
    slideOrder,
    slides,
    assets,
    themes,
    defaultThemeId,
    createdAt: now,
    updatedAt: now
  }
}

function convertPresentationThemes(
  presentation: PresentationData,
  documentWidth: number
): Record<string, EditablePresentationTheme> {
  const result: Record<string, EditablePresentationTheme> = {}
  for (const [id, theme] of presentation.themes ?? []) {
    const fallback = createDefaultPresentationTheme(documentWidth)
    result[id] = {
      id,
      defaultTextStyle: {
        ...fallback.defaultTextStyle,
        fontFamily: theme.minorFont.latin || theme.minorFont.ea || DEFAULT_FONT_FAMILY
      },
      colorScheme: {
        ...fallback.colorScheme,
        ...Object.fromEntries(
          [...theme.colorScheme].map(([slot, color]) => [slot, normalizeThemeColor(color)])
        )
      }
    }
  }
  if (Object.keys(result).length === 0) {
    const fallback = createDefaultPresentationTheme(documentWidth)
    result[fallback.id] = fallback
  }
  return result
}

function normalizeThemeColor(color: string): string {
  return color.startsWith('#') ? color : `#${color}`
}

function resolveSlideThemeId(slide: SlideData, presentation: PresentationData): string | undefined {
  const layoutId = presentation.slideToLayout?.get(slide.index) ?? slide.layoutIndex
  const masterId = presentation.layoutToMaster?.get(layoutId)
  return masterId ? presentation.masterToTheme?.get(masterId) : undefined
}

function convertSlide(
  slide: SlideData,
  presentation: PresentationData,
  assets: Record<string, EditablePresentationAsset>,
  assetIdsByMediaPath: Map<string, string>,
  preserveSource: boolean
): Omit<EditablePresentationSlide, 'id' | 'name'> {
  const elementOrder: string[] = []
  const elements: Record<string, EditablePresentationElement> = {}
  const layout = presentation.layouts.get(slide.layoutIndex)
  const masterId = presentation.layoutToMaster.get(slide.layoutIndex)
  const master = masterId ? presentation.masters.get(masterId) : undefined
  if (slide.showMasterSp !== false) {
    for (const [sourcePart, tree] of [
      [slide.layoutIndex, layout?.spTree],
      ...(layout?.showMasterSp !== false ? [[masterId, master?.spTree] as const] : [])
    ] as const) {
      for (const child of tree?.children() ?? []) {
        if (
          ['nvGrpSpPr', 'grpSpPr', 'extLst'].includes(child.localName) ||
          readPlaceholderInfo(child) ||
          ['nvSpPr', 'nvPicPr', 'nvGraphicFramePr', 'nvCxnSpPr', 'nvGrpSpPr'].some((property) =>
            isXmlTrue(child.child(property).child('cNvPr').attr('hidden'))
          )
        )
          continue
        throw new PptxCompatibilityError(
          { code: 'layout', sourcePart },
          'Unsupported PowerPoint layout or master decoration'
        )
      }
    }
  }

  for (const [objectIndex, node] of slide.nodes.entries()) {
    let converted: EditablePresentationElement[]
    try {
      if (!preserveSource) {
        assertPptxNodeVisualCompatibility(node)
        if (node.nodeType === 'shape') assertPptxTextCompatibility(node, slide, presentation)
      }
      converted = convertNode(node, slide, presentation, assets, assetIdsByMediaPath)
      if (!preserveSource && converted.some((element) => element.type === 'locked'))
        throw new PptxCompatibilityError(
          { code: 'unsupported-object' },
          'This PowerPoint object cannot yet be edited'
        )
    } catch (error) {
      throw locatePptxCompatibilityError(error, {
        objectNumber: objectIndex + 1,
        objectId: node.id
      })
    }
    for (const element of converted) {
      if (preserveSource && element.type !== 'locked') {
        element.pptxSourceNode = {
          id: node.id,
          role: element.type === 'text' ? 'text' : element.type === 'image' ? 'image' : 'geometry'
        }
      }
      elementOrder.push(element.id)
      elements[element.id] = element
    }
  }

  return {
    ...(preserveSource ? { pptxSourcePart: slide.slidePath } : {}),
    background: resolveSlideBackground(slide, presentation),
    elementOrder,
    elements,
    notes: ''
  }
}

function resolveSlideBackground(
  slide: SlideData,
  presentation: PresentationData
): EditableSlideBackground {
  const layout = presentation.layouts.get(slide.layoutIndex)
  const masterId = presentation.layoutToMaster.get(slide.layoutIndex)
  const master = masterId ? presentation.masters.get(masterId) : undefined
  const theme = getSlideTheme(slide, presentation)
  for (const [sourcePart, background] of [
    [slide.slidePath, slide.background],
    [slide.layoutIndex, layout?.background],
    [masterId, master?.background]
  ] as const) {
    if (!background?.exists()) continue
    try {
      const properties = background.child('bgPr')
      const color = readTextColor(properties, theme)
      if (color) {
        const fill = properties.child('solidFill')
        const alpha =
          fill.child('srgbClr').child('alpha').numAttr('val') ??
          fill.child('schemeClr').child('alpha').numAttr('val') ??
          100000
        return { type: 'solid', color, transparency: 100 - alpha / 1000 }
      }
      const gradient = properties.child('gradFill')
      if (gradient.exists()) {
        const linear = gradient.child('lin')
        if (!linear.exists() || gradient.child('path').exists())
          throw new PptxCompatibilityError(
            { code: 'background' },
            'Unsupported PowerPoint background fill: non-linear gradient'
          )
        const angle = ((linear.numAttr('ang') ?? 0) / 60000 + 90) % 360
        const stops = gradient
          .child('gsLst')
          .children('gs')
          .map((stop) => {
            const color = readTextColor(stop, theme)
            const position = stop.numAttr('pos')
            if (!color || position === undefined || position < 0 || position > 100000)
              throw new PptxCompatibilityError(
                { code: 'background' },
                'Invalid PowerPoint gradient stop'
              )
            return {
              color,
              position: position / 1000,
              transparency: 100 - readColorAlpha(stop) * 100,
              brightness: 0
            }
          })
        if (stops.length < 2 || stops.length > 1000)
          throw new PptxCompatibilityError(
            { code: 'background' },
            'Invalid PowerPoint gradient stops'
          )
        return {
          type: 'gradient',
          gradientType: 'linear',
          direction: angle === 90 ? 'left-right' : angle === 180 ? 'top-bottom' : 'diagonal',
          angle,
          stops
        }
      }
      throw new PptxCompatibilityError(
        { code: 'background' },
        'Unsupported PowerPoint background fill'
      )
    } catch (error) {
      throw locatePptxCompatibilityError(error, { sourcePart }, 'background')
    }
  }
  return createDefaultSlideBackground()
}

function convertNode(
  node: SlideNode,
  slide: SlideData,
  presentation: PresentationData,
  assets: Record<string, EditablePresentationAsset>,
  assetIdsByMediaPath: Map<string, string>
): EditablePresentationElement[] {
  if (node.nodeType === 'shape') return convertShapeNode(node, slide, presentation)
  if (node.nodeType === 'picture')
    return convertPictureNode(node, slide, presentation, assets, assetIdsByMediaPath)
  return [createLockedElement(node, `${node.nodeType} object`)]
}

function convertShapeNode(
  node: ShapeNodeData,
  slide: SlideData,
  presentation: PresentationData
): EditablePresentationElement[] {
  const elements: EditablePresentationElement[] = []
  const text = getShapeText(node)
  const theme = getSlideTheme(slide, presentation)
  const shape = getEditableShapeKind(node.presetGeometry)
  if (
    node.customGeometry?.exists() ||
    (node.presetGeometry && !['rect', 'ellipse', 'oval', 'line'].includes(node.presetGeometry))
  )
    throw new PptxCompatibilityError({ code: 'shape' }, 'Unsupported PowerPoint shape geometry')
  if (
    ['gradFill', 'pattFill', 'blipFill', 'grpFill'].some((fill) => node.fill?.child(fill).exists())
  )
    throw new PptxCompatibilityError({ code: 'shape' }, 'Unsupported PowerPoint shape fill')
  const fillColor = readPaintColor(node.fill, theme) ?? 'transparent'
  const strokeColor = readPaintColor(node.line, theme) ?? '#000000'
  const rawStrokeWidth = node.line?.attr('w')
  const sourceStrokeWidth = rawStrokeWidth === undefined ? undefined : Number(rawStrokeWidth)
  if (
    sourceStrokeWidth !== undefined &&
    (!Number.isFinite(sourceStrokeWidth) || sourceStrokeWidth < 0)
  )
    throw new PptxCompatibilityError({ code: 'shape' }, 'Invalid PowerPoint outline width')
  const strokeWidth =
    !node.line?.exists() || node.line.child('noFill').exists()
      ? 0
      : sourceStrokeWidth === undefined
        ? 1
        : emuToPx(sourceStrokeWidth)

  const isInvisibleTextBox =
    isXmlTrue(node.source.child('nvSpPr').child('cNvSpPr').attr('txBox')) &&
    node.source.child('spPr').child('noFill').exists() &&
    strokeWidth === 0
  if (
    shape &&
    !isInvisibleTextBox &&
    (node.presetGeometry || fillColor !== 'transparent' || strokeWidth > 0)
  ) {
    const frame = resolveTextShapeFrame(node, slide, presentation)
    if (!frame) throw new Error(`Shape placeholder frame is missing: ${node.name}`)
    elements.push({
      id: crypto.randomUUID(),
      type: 'shape',
      shape,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      rotation: node.rotation,
      opacity: 1,
      fillColor,
      strokeColor,
      strokeWidth
    })
  }

  if (node.presetGeometry === 'line') {
    elements.push({
      id: crypto.randomUUID(),
      type: 'line',
      x: node.position.x,
      y: node.position.y,
      width: node.size.w,
      height: node.size.h,
      rotation: node.rotation,
      opacity: 1,
      strokeColor,
      strokeWidth: node.line?.exists() ? strokeWidth : 1
    })
  }

  if (
    text ||
    (node.textBody && isXmlTrue(node.source.child('nvSpPr').child('cNvSpPr').attr('txBox')))
  ) {
    const frame = resolveTextShapeFrame(node, slide, presentation)
    if (!frame)
      throw new PptxCompatibilityError(
        { code: 'text' },
        `Text placeholder frame is missing: ${node.name}`
      )
    const style = resolveTextShapeStyle(node, slide, presentation, theme)
    const runs = resolveTextRuns(node, slide, presentation, theme)
    const paragraphs = resolveTextParagraphs(node, slide, presentation, theme)
    const fontScale =
      (node.textBody?.bodyProperties?.child('normAutofit').numAttr('fontScale') ?? 100000) / 100000
    if (!Number.isFinite(fontScale) || fontScale <= 0 || fontScale > 1)
      throw new PptxCompatibilityError({ code: 'text' }, 'Invalid PowerPoint text scale')
    style.fontSize *= fontScale
    for (const run of runs ?? []) run.fontSize *= fontScale
    for (const paragraph of paragraphs ?? []) {
      for (const run of paragraph.runs) run.fontSize *= fontScale
      if (!paragraph.runs.length && paragraph.typingStyle)
        paragraph.typingStyle.fontSize *= fontScale
    }
    elements.push({
      id: crypto.randomUUID(),
      type: 'text',
      autoWidth: false,
      autoSize: 'fixed',
      ...resolveTextBodyLayout(node, slide, presentation),
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      rotation: node.rotation,
      opacity: 1,
      text,
      runs,
      paragraphs,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      bold: style.bold,
      italic: style.italic,
      underline: style.underline,
      strikethrough: style.strikethrough,
      baseline: style.baseline,
      characterSpacing: style.characterSpacing,
      highlightColor: style.highlightColor,
      color: style.color,
      align: style.align,
      lineHeight: style.lineHeight
    })
  }

  if (elements.length === 0) return [createLockedElement(node, 'Shape')]
  return elements
}

function convertPictureNode(
  node: PicNodeData,
  slide: SlideData,
  presentation: PresentationData,
  assets: Record<string, EditablePresentationAsset>,
  assetIdsByMediaPath: Map<string, string>
): EditablePresentationElement[] {
  const theme = getSlideTheme(slide, presentation)
  const blip = node.source.child('blipFill').child('blip')
  const opacity = (blip.child('alphaModFix').numAttr('amt') ?? 100000) / 100000
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
    throw new PptxCompatibilityError({ code: 'image' }, 'Invalid PowerPoint image opacity')
  const borderWidth =
    node.line?.child('noFill').exists() || !node.line?.exists()
      ? 0
      : emuToPx(node.line.numAttr('w') ?? 9525)
  if (!Number.isFinite(borderWidth) || borderWidth < 0)
    throw new PptxCompatibilityError({ code: 'image' }, 'Invalid PowerPoint image outline')
  const borderColor = readPaintColor(node.line, theme, opacity || 1) ?? '#ffffff'
  const effectList = node.source.child('spPr').child('effectLst')
  const shadow = effectList.child('outerShdw')
  let imageShadow: EditableImageShadow | undefined
  if (shadow.exists()) {
    const blur = emuToPx(shadow.numAttr('blurRad') ?? 0)
    const distance = emuToPx(shadow.numAttr('dist') ?? 0)
    const alpha = readColorAlpha(shadow)
    const matches = (
      expectedBlur: number,
      expectedDistance: number,
      expectedAlpha: number
    ): boolean =>
      blur === expectedBlur &&
      distance === expectedDistance &&
      shadow.numAttr('dir') === 5400000 &&
      readTextColor(shadow, theme)?.toLowerCase() === '#000000' &&
      Math.abs(alpha - expectedAlpha * opacity) < 0.00001
    if (matches(20, 8, 0.22)) imageShadow = 'soft'
    else if (matches(32, 14, 0.32)) imageShadow = 'medium'
    else throw new PptxCompatibilityError({ code: 'image' }, 'Unsupported PowerPoint image shadow')
  }
  if (effectList.children().some((effect) => effect.localName !== 'outerShdw'))
    throw new PptxCompatibilityError({ code: 'image' }, 'Unsupported PowerPoint image effect')
  const asset = resolvePictureAsset(node, slide, presentation, assets, assetIdsByMediaPath)
  if (!asset) return [createLockedElement(node, 'Picture')]
  return [
    {
      id: crypto.randomUUID(),
      type: 'image',
      assetId: asset.id,
      x: node.position.x,
      y: node.position.y,
      width: node.size.w,
      height: node.size.h,
      rotation: node.rotation,
      opacity,
      crop: node.crop,
      ...(borderWidth > 0 ? { borderWidth, borderColor } : {}),
      ...(imageShadow ? { shadow: imageShadow } : {})
    }
  ]
}

function resolvePictureAsset(
  node: PicNodeData,
  slide: SlideData,
  presentation: PresentationData,
  assets: Record<string, EditablePresentationAsset>,
  assetIdsByMediaPath: Map<string, string>
): EditablePresentationAsset | null {
  if (!node.blipEmbed) return null
  const rel = slide.rels.get(node.blipEmbed)
  if (!rel || rel.targetMode) return null
  const mediaPath = resolveRelTarget(getDirname(slide.slidePath), rel.target)
  const entry = findMediaEntry(presentation, mediaPath)
  if (!entry) return null
  const [entryPath, bytes] = entry
  const existingId = assetIdsByMediaPath.get(entryPath)
  if (existingId) return assets[existingId]
  const assetId = crypto.randomUUID()
  const mimeType = getMimeTypeFromPath(mediaPath)
  const asset: EditablePresentationAsset = {
    id: assetId,
    name: mediaPath.split('/').at(-1) ?? 'image',
    mimeType,
    dataUrl: uint8ArrayToDataUrl(bytes, mimeType)
  }
  assets[assetId] = asset
  assetIdsByMediaPath.set(entryPath, assetId)
  return asset
}

function createLockedElement(node: SlideNode, label: string): EditableLockedElement {
  return {
    id: crypto.randomUUID(),
    type: 'locked',
    x: node.position.x,
    y: node.position.y,
    width: node.size.w,
    height: node.size.h,
    rotation: node.rotation,
    opacity: 1,
    locked: true,
    label
  }
}

function getShapeText(node: ShapeNodeData): string {
  return (
    node.textBody?.paragraphs
      .map((paragraph) => paragraph.runs.map((run) => run.text).join(''))
      .join('\n') ?? ''
  )
}

function getEditableShapeKind(presetGeometry: string | undefined): EditableShapeKind | null {
  if (!presetGeometry || ['rect', 'roundRect'].includes(presetGeometry)) return 'rectangle'
  if (['ellipse', 'oval'].includes(presetGeometry)) return 'ellipse'
  return null
}

function normalizeTextAlign(value: string | undefined): EditableTextAlign {
  if (value === 'ctr') return 'center'
  if (value === 'r') return 'right'
  if (value === 'just') return 'justify'
  return 'left'
}

function resolveTextShapeFrame(
  node: ShapeNodeData,
  slide: SlideData,
  presentation: PresentationData
): TextShapeFrame | null {
  const ownFrame = createTextShapeFrame(node.position.x, node.position.y, node.size.w, node.size.h)
  if (ownFrame) return ownFrame
  if (!node.placeholder) return null

  const layout = presentation.layouts.get(slide.layoutIndex)
  const layoutFrame = findPlaceholderFrame(layout?.placeholders, node.placeholder)
  if (layoutFrame) return layoutFrame

  const masterId = presentation.layoutToMaster.get(slide.layoutIndex)
  const master = masterId ? presentation.masters.get(masterId) : undefined
  return findPlaceholderFrame(getMasterPlaceholderEntries(master), node.placeholder)
}

function getMasterPlaceholderEntries(
  master: MasterPlaceholderSource | undefined
): readonly PlaceholderEntryCandidate[] {
  return master?.placeholderEntries ?? master?.placeholders.map((node) => ({ node })) ?? []
}

function findPlaceholderFrame(
  entries: readonly PlaceholderEntryCandidate[] | undefined,
  placeholder: PlaceholderInfo
): TextShapeFrame | null {
  for (const entry of entries ?? []) {
    if (!matchesPlaceholder(entry.node, placeholder)) continue
    const absoluteFrame = entry.absoluteXfrm
      ? createTextShapeFrame(
          entry.absoluteXfrm.position.x,
          entry.absoluteXfrm.position.y,
          entry.absoluteXfrm.size.w,
          entry.absoluteXfrm.size.h
        )
      : null
    if (absoluteFrame) return absoluteFrame

    const xfrmFrame = readXfrmFrame(entry.node)
    if (xfrmFrame) return xfrmFrame
  }
  return null
}

function matchesPlaceholder(node: XmlNode, target: PlaceholderInfo): boolean {
  const source = readPlaceholderInfo(node)
  if (!source) return false
  if (target.type && target.idx !== undefined) {
    return source.type === target.type && source.idx === target.idx
  }
  if (target.idx !== undefined) return source.idx === target.idx
  if (target.type) return source.type === target.type
  return false
}

function readPlaceholderInfo(node: XmlNode): PlaceholderInfo | null {
  for (const propertyName of ['nvSpPr', 'nvPicPr', 'nvGraphicFramePr', 'nvCxnSpPr'] as const) {
    const placeholder = node.child(propertyName).child('nvPr').child('ph')
    if (placeholder.exists()) {
      return { type: placeholder.attr('type'), idx: placeholder.numAttr('idx') }
    }
  }
  return null
}

function readXfrmFrame(node: XmlNode): TextShapeFrame | null {
  const xfrm = node.child('spPr').child('xfrm')
  if (!xfrm.exists()) return null
  const offset = xfrm.child('off')
  const extent = xfrm.child('ext')
  return createTextShapeFrame(
    offset.numAttr('x'),
    offset.numAttr('y'),
    extent.numAttr('cx'),
    extent.numAttr('cy')
  )
}

function createTextShapeFrame(
  rawX: number | undefined,
  rawY: number | undefined,
  rawWidth: number | undefined,
  rawHeight: number | undefined
): TextShapeFrame | null {
  const x = normalizeCanvasCoordinate(rawX)
  const y = normalizeCanvasCoordinate(rawY)
  const width = normalizeCanvasCoordinate(rawWidth)
  const height = normalizeCanvasCoordinate(rawHeight)
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
    return null
  }
  return { x, y, width, height }
}

function getSlideTheme(slide: SlideData, presentation: PresentationData): ThemeData | undefined {
  const themeId = resolveSlideThemeId(slide, presentation)
  const theme = themeId ? presentation.themes?.get(themeId) : undefined
  if (!theme) return undefined
  const layout = presentation.layouts.get(slide.layoutIndex)
  const masterId = presentation.layoutToMaster.get(slide.layoutIndex)
  const master = masterId ? presentation.masters.get(masterId) : undefined
  const colorScheme = new Map(theme.colorScheme)
  const aliases = new Map([
    ['bg1', 'lt1'],
    ['tx1', 'dk1'],
    ['bg2', 'lt2'],
    ['tx2', 'dk2']
  ])
  for (const [alias, slot] of master?.colorMap ?? []) aliases.set(alias, slot)
  for (const [alias, slot] of layout?.colorMapOverride ?? []) aliases.set(alias, slot)
  for (const [alias, slot] of aliases) {
    const color = theme.colorScheme.get(slot)
    if (color) colorScheme.set(alias, color)
  }
  return { ...theme, colorScheme }
}

function inheritedParagraphProperties(
  node: ShapeNodeData,
  slide: SlideData,
  presentation: PresentationData,
  level: number
): XmlNode[] {
  const layout = presentation.layouts.get(slide.layoutIndex)
  const masterId = presentation.layoutToMaster.get(slide.layoutIndex)
  const master = masterId ? presentation.masters.get(masterId) : undefined
  const placeholder = node.placeholder
  const layoutShape = placeholder
    ? layout?.placeholders.find((entry) => matchesPlaceholder(entry.node, placeholder))?.node
    : undefined
  const masterShape = placeholder
    ? master?.placeholders.find((entry) => matchesPlaceholder(entry, placeholder))
    : undefined
  const category =
    placeholder?.type === 'title' || placeholder?.type === 'ctrTitle'
      ? 'titleStyle'
      : placeholder?.type === 'body'
        ? 'bodyStyle'
        : 'otherStyle'
  return [
    node.textBody?.listStyle,
    layoutShape?.child('txBody').child('lstStyle'),
    masterShape?.child('txBody').child('lstStyle'),
    master?.textStyles?.[category],
    master?.defaultTextStyle,
    presentation.defaultTextStyle
  ].flatMap((style) => (style ? [style.child(`lvl${level + 1}pPr`), style.child('defPPr')] : []))
}

function resolveTextBodyLayout(
  node: ShapeNodeData,
  slide: SlideData,
  presentation: PresentationData
): Pick<EditableTextElement, 'textInsets' | 'verticalAlign'> {
  const layout = presentation.layouts.get(slide.layoutIndex)
  const masterId = presentation.layoutToMaster.get(slide.layoutIndex)
  const master = masterId ? presentation.masters.get(masterId) : undefined
  const placeholder = node.placeholder
  const layoutShape = placeholder
    ? layout?.placeholders.find((entry) => matchesPlaceholder(entry.node, placeholder))?.node
    : undefined
  const masterShape = placeholder
    ? master?.placeholders.find((entry) => matchesPlaceholder(entry, placeholder))
    : undefined
  const sources = [
    node.textBody?.bodyProperties,
    layoutShape?.child('txBody').child('bodyPr'),
    masterShape?.child('txBody').child('bodyPr')
  ]
  const attr = (name: string): string | undefined =>
    sources.map((source) => source?.attr(name)).find((value) => value !== undefined)
  const vertical = attr('vert')
  if (vertical && vertical !== 'horz')
    throw new PptxCompatibilityError({ code: 'text' }, 'Unsupported PowerPoint vertical text')
  const anchor = attr('anchor')
  if (anchor && !['t', 'ctr', 'b'].includes(anchor))
    throw new PptxCompatibilityError({ code: 'text' }, 'Unsupported PowerPoint text anchor')
  if (Number(attr('numCol') ?? 1) > 1)
    throw new PptxCompatibilityError({ code: 'text' }, 'Unsupported PowerPoint text columns')
  return {
    verticalAlign: anchor === 'ctr' ? 'center' : anchor === 'b' ? 'bottom' : 'top',
    textInsets: {
      left: emuToPx(Number(attr('lIns') ?? 91440)),
      right: emuToPx(Number(attr('rIns') ?? 91440)),
      top: emuToPx(Number(attr('tIns') ?? 45720)),
      bottom: emuToPx(Number(attr('bIns') ?? 45720))
    }
  }
}

function resolveTextShapeStyle(
  node: ShapeNodeData,
  slide: SlideData,
  presentation: PresentationData,
  theme?: ThemeData
): TextShapeStyle {
  const firstParagraph = node.textBody?.paragraphs[0]
  const firstRun = firstParagraph?.runs[0]
  return resolveTextStyle(
    firstRun?.properties,
    firstParagraph?.endParaRPr,
    firstParagraph?.properties,
    theme,
    inheritedParagraphProperties(node, slide, presentation, firstParagraph?.level ?? 0)
  )
}

function resolveTextRuns(
  node: ShapeNodeData,
  slide: SlideData,
  presentation: PresentationData,
  theme?: ThemeData
): EditableTextRun[] | undefined {
  const runs: EditableTextRun[] = []
  for (const [paragraphIndex, paragraph] of (node.textBody?.paragraphs ?? []).entries()) {
    const inherited = inheritedParagraphProperties(node, slide, presentation, paragraph.level ?? 0)
    if (paragraphIndex > 0 && paragraph.runs.length === 0) {
      const style = resolveTextStyle(
        undefined,
        paragraph.endParaRPr,
        paragraph.properties,
        theme,
        inherited
      )
      const { align: _align, lineHeight: _lineHeight, ...runStyle } = style
      runs.push({ ...runStyle, text: '\n' })
    }
    for (const [runIndex, run] of paragraph.runs.entries()) {
      const style = resolveTextStyle(
        run.properties,
        paragraph.endParaRPr,
        paragraph.properties,
        theme,
        inherited
      )
      const { align: _align, lineHeight: _lineHeight, ...runStyle } = style
      runs.push({
        ...runStyle,
        text: `${paragraphIndex > 0 && runIndex === 0 ? '\n' : ''}${run.text}`
      })
    }
  }
  return runs.length ? runs : undefined
}

function assertPptxNodeVisualCompatibility(node: SlideNode): void {
  if (node.nodeType !== 'shape' && node.nodeType !== 'picture') return
  const properties = node.source.child('spPr')
  const transform = properties.child('xfrm')
  const code = node.nodeType === 'picture' ? 'image' : 'shape'
  if (isXmlTrue(transform.attr('flipH')) || isXmlTrue(transform.attr('flipV')))
    throw new PptxCompatibilityError({ code }, 'PowerPoint reflection cannot yet be edited')
  if (
    properties.child('effectDag').exists() ||
    (node.nodeType === 'shape' && properties.child('effectLst').children().length > 0)
  )
    throw new PptxCompatibilityError({ code }, 'PowerPoint shape effects cannot yet be edited')
}

function assertPptxTextCompatibility(
  node: ShapeNodeData,
  slide: SlideData,
  presentation: PresentationData
): void {
  for (const paragraph of node.textBody?.paragraphs ?? []) {
    const sources = [
      paragraph.properties,
      ...inheritedParagraphProperties(node, slide, presentation, paragraph.level ?? 0)
    ]
    const listProperties = sources.find((source) =>
      ['buNone', 'buChar', 'buAutoNum', 'buBlip'].some((kind) => source?.child(kind).exists())
    )
    for (const spacing of ['spcBef', 'spcAft']) {
      const value = sources
        .map((source) => source?.child(spacing))
        .find((source) => source?.exists())
      if (value && value.children().some((entry) => entry.numAttr('val') !== 0))
        throw new PptxCompatibilityError(
          { code: 'text' },
          'PowerPoint paragraph spacing cannot yet be edited'
        )
    }
    if (listProperties?.child('buBlip').exists())
      throw new PptxCompatibilityError(
        { code: 'text' },
        'PowerPoint picture bullets cannot yet be edited'
      )
    const numbering = listProperties?.child('buAutoNum')
    if (numbering?.exists() && (numbering.attr('type') ?? 'arabicPeriod') !== 'arabicPeriod')
      throw new PptxCompatibilityError(
        { code: 'text' },
        'PowerPoint numbering format cannot yet be edited'
      )
    if (!listProperties || listProperties.child('buNone').exists()) continue
    if (
      ['marL', 'indent'].some((attribute) => {
        const value = sources
          .map((source) => source?.numAttr(attribute))
          .find((value) => value !== undefined)
        return value === undefined || !Number.isFinite(value)
      })
    )
      throw new PptxCompatibilityError(
        { code: 'text' },
        'PowerPoint list indentation cannot be resolved for editable import'
      )
  }
}

function resolveTextParagraphs(
  node: ShapeNodeData,
  slide: SlideData,
  presentation: PresentationData,
  theme?: ThemeData
): EditableTextParagraph[] | undefined {
  const numberingSequences = new Map<number, string>()
  const paragraphs = node.textBody?.paragraphs.map((paragraph, paragraphIndex) => {
    const runs = paragraph.runs.map((run) => {
      const style = resolveTextStyle(
        run.properties,
        paragraph.endParaRPr,
        paragraph.properties,
        theme,
        inheritedParagraphProperties(node, slide, presentation, paragraph.level ?? 0)
      )
      return {
        text: run.text,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        color: style.color,
        strikethrough: style.strikethrough,
        baseline: style.baseline,
        characterSpacing: style.characterSpacing,
        highlightColor: style.highlightColor
      }
    })
    const sources = [
      paragraph.properties,
      ...inheritedParagraphProperties(node, slide, presentation, paragraph.level ?? 0)
    ]
    const align = sources.map((source) => source?.attr('algn')).find((value) => value !== undefined)
    const lineSpacing = sources
      .map((source) => source?.child('lnSpc'))
      .find((value) => value?.exists())
    const exactPoints = lineSpacing?.child('spcPts').numAttr('val')
    const multiple = lineSpacing?.child('spcPct').numAttr('val')
    const listProperties = sources.find((source) =>
      ['buNone', 'buChar', 'buAutoNum', 'buBlip'].some((kind) => source?.child(kind).exists())
    )
    const bullet = listProperties?.child('buChar')
    const number = listProperties?.child('buAutoNum')
    const list: EditableListStyle | null = bullet?.exists()
      ? {
          kind: 'bullet',
          level: paragraph.level,
          char: bullet.attr('char') ?? '•',
          font: sources
            .map((source) => source?.child('buFont').attr('typeface'))
            .find((value) => value !== undefined)
        }
      : number?.exists()
        ? {
            kind: 'number',
            level: paragraph.level,
            format: number.attr('type') ?? 'arabicPeriod',
            startAt: number.numAttr('startAt')
          }
        : null
    if (list?.kind === 'number') {
      if (list.startAt !== undefined || !numberingSequences.has(list.level))
        numberingSequences.set(list.level, `pptx:${node.id}:${paragraphIndex}`)
      list.sequenceId = numberingSequences.get(list.level)
    } else numberingSequences.clear()
    const {
      align: _align,
      lineHeight: _lineHeight,
      ...typingStyle
    } = resolveTextStyle(
      undefined,
      paragraph.endParaRPr,
      paragraph.properties,
      theme,
      inheritedParagraphProperties(node, slide, presentation, paragraph.level ?? 0)
    )
    return {
      runs,
      typingStyle: runs.at(-1) ?? typingStyle,
      align: normalizeTextAlign(align),
      lineSpacing:
        exactPoints !== undefined
          ? { kind: 'exact' as const, points: exactPoints / 100 }
          : { kind: 'multiple' as const, value: multiple !== undefined ? multiple / 100000 : 1 },
      list,
      marginLeft: emuToPx(
        sources.map((source) => source?.numAttr('marL')).find((value) => value !== undefined) ?? 0
      ),
      textIndent: emuToPx(
        sources.map((source) => source?.numAttr('indent')).find((value) => value !== undefined) ?? 0
      )
    }
  })
  return paragraphs?.length ? paragraphs : undefined
}

function resolveTextStyle(
  runProperties: XmlNode | undefined,
  paragraphEndProperties: XmlNode | undefined,
  paragraphProperties: XmlNode | undefined,
  theme?: ThemeData,
  inherited: XmlNode[] = []
): TextShapeStyle {
  const sources = [
    runProperties,
    paragraphProperties?.child('defRPr'),
    ...inherited.map((properties) => properties.child('defRPr')),
    paragraphEndProperties
  ]
  const attr = (name: string): string | undefined =>
    sources.map((source) => source?.attr(name)).find((value) => value !== undefined)
  const baseline = Number(attr('baseline') ?? 0)
  const highlight = sources
    .map((source) => source?.child('highlight'))
    .find((node) => node?.exists())
  const highlightRgb = highlight?.child('srgbClr').attr('val')
  const highlightScheme = highlight?.child('schemeClr').attr('val')
  return {
    strikethrough: isStrikeEnabled(attr('strike')),
    baseline: baseline > 0 ? 'superscript' : baseline < 0 ? 'subscript' : 'normal',
    characterSpacing: characterSpacingToPx(Number(attr('spc') ?? 0)),
    highlightColor: highlightRgb
      ? `#${highlightRgb}`
      : highlightScheme && theme?.colorScheme.has(highlightScheme)
        ? normalizeThemeColor(theme.colorScheme.get(highlightScheme)!)
        : null,
    fontFamily:
      sources.map((source) => readFontFamily(source, theme)).find(Boolean) ?? DEFAULT_FONT_FAMILY,
    fontSize: fontSizeToPx(Number(attr('sz') ?? 3200)),
    bold: isXmlTrue(attr('b')),
    italic: isXmlTrue(attr('i')),
    underline: isUnderlineEnabled(attr('u')),
    color:
      sources.map((source) => readPaintColor(source, theme)).find(Boolean) ??
      DEFAULT_FOREGROUND_COLOR,
    align: normalizeTextAlign(
      [paragraphProperties, ...inherited]
        .map((source) => source?.attr('algn'))
        .find((value) => value !== undefined)
    ),
    lineHeight: 1.15
  }
}

function normalizeCanvasLength(value: number, fallback: number): number {
  const normalized = normalizeCanvasCoordinate(value)
  return normalized !== null && normalized > 0 ? normalized : fallback
}

function normalizeCanvasCoordinate(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return Math.abs(value) > RAW_EMU_THRESHOLD ? emuToPx(value) : value
}

function emuToPx(emu: number): number {
  return (emu / EMU_PER_INCH) * CSS_PX_PER_INCH
}

function fontSizeToPx(hundredthsOfPoint: number): number {
  return (hundredthsOfPoint / 100) * (CSS_PX_PER_INCH / 72)
}

function characterSpacingToPx(hundredthsOfPoint: number): number {
  return (hundredthsOfPoint / 100) * (CSS_PX_PER_INCH / 72)
}

function isXmlTrue(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

function isUnderlineEnabled(value: string | undefined): boolean {
  return Boolean(value && value !== 'none')
}

function isStrikeEnabled(value: string | undefined): boolean {
  return Boolean(value && value !== 'noStrike')
}

function readFontFamily(node: XmlNode | undefined, theme?: ThemeData): string | null {
  const value = node?.child('latin').attr('typeface') ?? node?.child('ea').attr('typeface')
  if (!value) return null
  if (value.startsWith('+mj')) return theme?.majorFont.latin || theme?.majorFont.ea || null
  if (value.startsWith('+mn')) return theme?.minorFont.latin || theme?.minorFont.ea || null
  return value
}

function colorRoot(node: XmlNode | undefined): XmlNode | undefined {
  return node?.child('solidFill').exists() ? node.child('solidFill') : node
}

function readColorAlpha(node: XmlNode | undefined): number {
  const root = colorRoot(node)
  const alpha =
    root?.child('srgbClr').child('alpha').numAttr('val') ??
    root?.child('schemeClr').child('alpha').numAttr('val') ??
    100000
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 100000)
    throw new Error('Invalid PowerPoint color alpha')
  return alpha / 100000
}

function readPaintColor(node: XmlNode | undefined, theme?: ThemeData, opacity = 1): string | null {
  const color = readTextColor(node, theme)
  if (!color) return null
  const alpha = readColorAlpha(node) / opacity
  if (alpha >= 1) return color
  const rgb = parseHexColor(color)
  if (!rgb) throw new Error('Invalid PowerPoint paint color')
  return `rgba(${rgb.red}, ${rgb.green}, ${rgb.blue}, ${alpha})`
}

function readTextColor(node: XmlNode | undefined, theme?: ThemeData): string | null {
  const root = colorRoot(node)
  const rgb = root?.child('srgbClr')
  const scheme = root?.child('schemeClr')
  const direct = rgb?.attr('val')
  const slot = scheme?.attr('val')
  const base = direct ?? (slot ? theme?.colorScheme.get(slot) : undefined)
  const properties = direct ? rgb : scheme
  if (!base || !properties) return null
  const tint = properties.child('tint').numAttr('val')
  const shade = properties.child('shade').numAttr('val')
  const luminance = properties.child('lumMod').numAttr('val')
  const offset = properties.child('lumOff').numAttr('val')
  let color = normalizeThemeColor(base)
  if (tint !== undefined) color = applyBrightness(color, 100 - tint / 1000)
  if (shade !== undefined) color = applyBrightness(color, shade / 1000 - 100)
  if (luminance !== undefined) color = applyBrightness(color, luminance / 1000 - 100)
  if (offset !== undefined) color = applyBrightness(color, offset / 1000)
  return color
}

function resolveRelTarget(basePath: string, target: string): string {
  const parts = `${basePath}/${target}`.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      resolved.pop()
    } else {
      resolved.push(part)
    }
  }
  return resolved.join('/')
}

function getDirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function findMediaEntry(
  presentation: PresentationData,
  mediaPath: string
): [string, Uint8Array] | undefined {
  for (const path of [mediaPath, mediaPath.replace(/^ppt\//, '')]) {
    const bytes = presentation.media.get(path)
    if (bytes) return [path, bytes]
  }
  const basename = mediaPath.split('/').at(-1)
  if (!basename) return undefined
  for (const [key, value] of presentation.media) {
    if (key.split('/').at(-1) === basename) return [key, value]
  }
  return undefined
}

function getMimeTypeFromPath(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase()
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'bmp') return 'image/bmp'
  if (extension === 'png') return 'image/png'
  if (extension === 'svg') return 'image/svg+xml'
  throw new Error('Unsupported PowerPoint image format')
}

function uint8ArrayToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = ''
  const chunkSize = 8192
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize))
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}

function stripPresentationExtension(name: string): string {
  return name.replace(/\.(pptx|lpdeck)$/i, '')
}

export async function loadEditablePresentationSnapshot(
  source: EditablePresentationSource
): Promise<EditablePresentationSnapshot> {
  const draft = await getPresentationDraft(source.id)
  if (draft) return { document: draft.document, revision: draft.revision }
  const blobId = getBlobId(source)
  const db = await openFileExplorerDB()
  const record = await db.get('file-blobs', blobId)
  if (!record || (!record.blob && record.storage !== 'native-fs')) {
    throw new Error(`Editable presentation source is missing: ${source.id}`)
  }
  const catalog = await db.get('folder-items', source.id)
  const personalName =
    catalog?.type === 'file' && catalog.personalOwnerId
      ? stripPresentationExtension(catalog.name)
      : undefined
  const cacheKey = `${source.id}:${blobId}:${record.revision ?? `size-${record.blob?.size ?? record.size}`}:${personalName ?? ''}`
  const cached = editableDocumentCache.get(cacheKey)
  if (cached) {
    editableDocumentCache.delete(cacheKey)
    editableDocumentCache.set(cacheKey, cached)
    return { document: cached, revision: record.revision ?? 0 }
  }
  assertPortablePresentationSize(record.blob?.size ?? record.size ?? 0)
  const body = record.blob
    ? await readBlobText(record.blob)
    : new TextDecoder('utf-8', { fatal: true }).decode(
        await readPresentationArrayBuffer({ ...source, mimeType: EDITABLE_PRESENTATION_MIME_TYPE })
      )
  const document = { ...(await parseEditablePresentation(body)), id: source.id }
  if (personalName !== undefined) document.name = personalName
  editableDocumentCache.set(cacheKey, document)
  while (editableDocumentCache.size > EDITABLE_DOCUMENT_CACHE_LIMIT) {
    const oldestKey = editableDocumentCache.keys().next().value
    if (!oldestKey) break
    editableDocumentCache.delete(oldestKey)
  }
  return { document, revision: record.revision ?? 0 }
}

export async function loadEditablePresentation(
  source: EditablePresentationSource
): Promise<EditablePresentationDocument> {
  return (await loadEditablePresentationSnapshot(source)).document
}

const EDITABLE_DOCUMENT_CACHE_LIMIT = 12
const editableDocumentCache = new Map<string, EditablePresentationDocument>()

export function clearEditablePresentationCache(): void {
  editableDocumentCache.clear()
}

export function generateEditablePresentationThumbnail(
  document: EditablePresentationDocument
): string {
  const slideId = document.slideOrder[0]
  const slide = slideId ? document.slides[slideId] : null
  const elements = slide
    ? slide.elementOrder
        .map((elementId) => slide.elements[elementId])
        .filter((element): element is EditablePresentationElement => Boolean(element))
    : []
  const body = elements.map((element) => renderElementSvg(element, document.assets)).join('')
  const background = renderBackgroundSvg(slide?.background)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${document.width}" height="${document.height}" viewBox="0 0 ${document.width} ${document.height}">${background}${body}</svg>`
  return `data:image/svg+xml;base64,${stringToBase64(svg)}`
}

function stringToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  const chunkSize = 8192
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize))
  }
  return btoa(binary)
}

function renderBackgroundSvg(background: EditableSlideBackground | undefined): string {
  const normalized = normalizeSlideBackground(background)
  if (normalized.type !== 'gradient') {
    if (normalized.type !== 'solid') {
      return `<rect width="100%" height="100%" fill="${DEFAULT_SLIDE_BACKGROUND_COLOR}"/>`
    }
    return `<rect width="100%" height="100%" fill="${escapeXml(colorWithTransparency(normalized.color, normalized.transparency))}"/>`
  }
  const modern = 'stops' in normalized ? normalized : normalizeSlideBackground(normalized)
  if (modern.type !== 'gradient' || !('stops' in modern)) {
    return `<rect width="100%" height="100%" fill="${DEFAULT_SLIDE_BACKGROUND_COLOR}"/>`
  }

  const coordinates = {
    'left-right': { x1: '0%', y1: '0%', x2: '100%', y2: '0%' },
    'top-bottom': { x1: '0%', y1: '0%', x2: '0%', y2: '100%' },
    diagonal: { x1: '0%', y1: '0%', x2: '100%', y2: '100%' }
  } satisfies Record<EditableGradientDirection, { x1: string; y1: string; x2: string; y2: string }>

  const { x1, y1, x2, y2 } = coordinates[modern.direction]
  const stops = getSortedGradientStops(modern.stops)
    .map(
      (stop) =>
        `<stop offset="${stop.position}%" stop-color="${escapeXml(colorWithTransparency(applyBrightness(stop.color, stop.brightness), stop.transparency))}"/>`
    )
    .join('')
  return `<defs><linearGradient id="slide-bg" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient></defs><rect width="100%" height="100%" fill="url(#slide-bg)"/>`
}

function renderElementSvg(
  element: EditablePresentationElement,
  assets: Record<string, EditablePresentationAsset>
): string {
  const transform = `rotate(${element.rotation} ${element.x + element.width / 2} ${element.y + element.height / 2})`
  if (element.type === 'text') {
    return renderTextElementForeignObject(element, transform)
  }
  if (element.type === 'shape') {
    if (element.shape === 'ellipse') {
      return `<ellipse cx="${element.x + element.width / 2}" cy="${element.y + element.height / 2}" rx="${element.width / 2}" ry="${element.height / 2}" fill="${escapeXml(element.fillColor)}" stroke="${escapeXml(element.strokeColor)}" stroke-width="${element.strokeWidth}" opacity="${element.opacity}" transform="${transform}"/>`
    }
    return `<rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" fill="${escapeXml(element.fillColor)}" stroke="${escapeXml(element.strokeColor)}" stroke-width="${element.strokeWidth}" opacity="${element.opacity}" transform="${transform}"/>`
  }
  if (element.type === 'image') {
    return renderImageElementSvg(element, assets[element.assetId])
  }
  if (element.type === 'line') {
    return `<line x1="${element.x}" y1="${element.y}" x2="${element.x + element.width}" y2="${element.y + element.height}" stroke="${escapeXml(element.strokeColor)}" stroke-width="${element.strokeWidth}" opacity="${element.opacity}" transform="${transform}"/>`
  }
  return ''
}

function renderTextElementForeignObject(element: EditableTextElement, transform: string): string {
  const paragraphs = normalizeTextParagraphs(element)
  const listNumbers = resolveParagraphListNumbers(paragraphs)
  const body = paragraphs
    .map((paragraph, paragraphIndex) => {
      const marker =
        paragraph.list?.kind === 'bullet'
          ? `${paragraph.list.char} `
          : paragraph.list?.kind === 'number'
            ? `${listNumbers[paragraphIndex]}. `
            : ''
      const runs = paragraph.runs
        .map((run) => {
          const decorations = [run.underline && 'underline', run.strikethrough && 'line-through']
            .filter(Boolean)
            .join(' ')
          const verticalAlign =
            run.baseline === 'superscript'
              ? 'super'
              : run.baseline === 'subscript'
                ? 'sub'
                : 'baseline'
          return `<span style="color:${escapeXml(run.color)};background-color:${escapeXml(run.highlightColor ?? 'transparent')};font-family:${escapeXml(run.fontFamily)};font-size:${run.fontSize}px;font-weight:${run.bold ? 700 : 400};font-style:${run.italic ? 'italic' : 'normal'};text-decoration:${decorations || 'none'};vertical-align:${verticalAlign};letter-spacing:${run.characterSpacing ?? 0}px">${escapeXml(run.text)}</span>`
        })
        .join('')
      const lineHeight =
        paragraph.lineSpacing.kind === 'multiple'
          ? String(paragraph.lineSpacing.value)
          : `${paragraph.lineSpacing.points}pt`
      return `<div style="flex-shrink:0;min-height:1em;text-align:${paragraph.align};text-align-last:${paragraph.align === 'justify' ? 'left' : 'auto'};line-height:${lineHeight};margin-left:${paragraph.marginLeft}px;text-indent:${paragraph.textIndent}px">${escapeXml(marker)}${runs}</div>`
    })
    .join('')
  const insets = element.textInsets
  const layout = insets
    ? `box-sizing:border-box;padding:${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px;`
    : ''
  const alignment = element.verticalAlign
    ? `display:flex;flex-direction:column;justify-content:${element.verticalAlign === 'center' ? 'center' : element.verticalAlign === 'bottom' ? 'flex-end' : 'flex-start'};`
    : ''
  return `<foreignObject x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" opacity="${element.opacity}" transform="${transform}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;overflow:hidden;white-space:pre-wrap;overflow-wrap:break-word;${layout}${alignment}">${body}</div></foreignObject>`
}

function renderImageElementSvg(
  element: EditableImageElement,
  asset: EditablePresentationAsset | undefined
): string {
  if (!asset) return ''
  const crop = normalizeImageCrop(element.crop)
  const visibleWidth = Math.max(1, 100 - crop.left - crop.right)
  const visibleHeight = Math.max(1, 100 - crop.top - crop.bottom)
  const imageX = element.x - element.width * (crop.left / visibleWidth)
  const imageY = element.y - element.height * (crop.top / visibleHeight)
  const imageWidth = element.width * (100 / visibleWidth)
  const imageHeight = element.height * (100 / visibleHeight)
  const transform = `rotate(${element.rotation} ${element.x + element.width / 2} ${element.y + element.height / 2})`
  const clipId = `clip-${element.id.replaceAll(/[^a-zA-Z0-9_-]/g, '')}`
  const border =
    element.borderWidth && element.borderWidth > 0
      ? `<rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" fill="none" stroke="${escapeXml(element.borderColor ?? '#ffffff')}" stroke-width="${element.borderWidth}" opacity="${element.opacity}" transform="${transform}"/>`
      : ''
  const shadowFilter = getImageShadowFilter(element.shadow, element.id)
  const shadowFilterId = shadowFilter ? `filter="url(#shadow-${element.id})"` : ''

  return `${shadowFilter ?? ''}<defs><clipPath id="${clipId}"><rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}"/></clipPath></defs><image href="${escapeXml(asset.dataUrl)}" x="${imageX}" y="${imageY}" width="${imageWidth}" height="${imageHeight}" opacity="${element.opacity}" transform="${transform}" clip-path="url(#${clipId})" ${shadowFilterId}/>${border}`
}

function normalizeImageCrop(
  crop: EditableImageElement['crop']
): NonNullable<EditableImageElement['crop']> {
  return {
    top: crop?.top ?? 0,
    right: crop?.right ?? 0,
    bottom: crop?.bottom ?? 0,
    left: crop?.left ?? 0
  }
}

function getImageShadowFilter(
  shadow: EditableImageElement['shadow'],
  elementId: string
): string | null {
  if (!shadow || shadow === 'none') return null
  const blur = shadow === 'medium' ? 12 : 8
  const offset = shadow === 'medium' ? 8 : 5
  return `<filter id="shadow-${escapeXml(elementId)}" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${offset}" stdDeviation="${blur}" flood-color="#000000" flood-opacity="0.28"/></filter>`
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function createDocumentBlob(document: EditablePresentationDocument): Blob {
  return new Blob([serializePortablePresentation(document)], {
    type: EDITABLE_PRESENTATION_MIME_TYPE
  })
}

async function parseEditablePresentation(value: string): Promise<EditablePresentationDocument> {
  assertPortablePresentationSize(new Blob([value]).size)
  const parsed = JSON.parse(value) as EditablePresentationDocument
  validatePortablePresentation(parsed)
  await validatePptxSource(parsed)
  if (
    !parsed.id ||
    !parsed.name ||
    typeof parsed.width !== 'number' ||
    typeof parsed.height !== 'number' ||
    !Array.isArray(parsed.slideOrder) ||
    typeof parsed.slides !== 'object' ||
    !parsed.slides
  ) {
    throw new Error('Invalid editable presentation document')
  }
  const fallbackTheme = createDefaultPresentationTheme(parsed.width)
  const themes = parsed.themes ?? { [fallbackTheme.id]: fallbackTheme }
  const defaultThemeId = parsed.defaultThemeId ?? fallbackTheme.id
  if (!themes[defaultThemeId]) themes[defaultThemeId] = fallbackTheme
  const slides: Record<string, EditablePresentationSlide> = {}
  for (const [slideId, slide] of Object.entries(
    parsed.slides as Record<string, EditablePresentationSlide>
  )) {
    slides[slideId] = {
      ...slide,
      background: normalizeSlideBackground(slide.background),
      themeId: slide.themeId ?? defaultThemeId
    }
  }
  return {
    id: parsed.id,
    schemaVersion: parsed.schemaVersion ?? 1,
    ...(parsed.pptxSource ? { pptxSource: parsed.pptxSource } : {}),
    name: parsed.name,
    width: parsed.width,
    height: parsed.height,
    defaultSlideBackground: normalizeSlideBackground(
      parsed.defaultSlideBackground ?? createDefaultSlideBackground()
    ),
    slideOrder: parsed.slideOrder,
    slides,
    assets: parsed.assets ?? {},
    themes,
    defaultThemeId,
    createdAt: parsed.createdAt ?? Date.now(),
    updatedAt: parsed.updatedAt ?? Date.now()
  }
}

function readBlobText(blob: Blob): Promise<string> {
  if ('text' in blob && typeof blob.text === 'function') return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () =>
      reject(reader.error ?? new Error('Failed to read editable presentation document'))
    reader.readAsText(blob)
  })
}
