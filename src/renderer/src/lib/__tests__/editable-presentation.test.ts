import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildPresentation, materializeAllSlideNodes, parseZip } from '@aiden0z/pptx-renderer'
import type { PresentationData } from '@aiden0z/pptx-renderer'
import { openFileExplorerDB, resetFileExplorerDBForTests } from '../file-explorer-db'
import { getDerivedAsset, putDerivedAsset, resetMediaWorkDBForTests } from '../media-work-db'
import { resetThumbnailDBForTests } from '../thumbnail-db'
import {
  EDITABLE_PRESENTATION_DOCUMENT_KIND,
  addBlankEditableSlide,
  addElementToSlide,
  applySlideBackgroundToAllSlides,
  clearEditablePresentationCache,
  createBlankEditablePresentationDocument,
  createEditablePresentation,
  createImageElement,
  createTextElement,
  DEFAULT_PRESENTATION_THEME_ID,
  convertPresentationData,
  duplicateEditableSlide,
  duplicateEditableSlides,
  duplicateElementInSlide,
  generateEditablePresentationThumbnail,
  getSlideBackgroundCss,
  getSlideBackgroundOutline,
  insertBlankEditableSlide,
  loadEditablePresentation,
  loadEditablePresentationSnapshot,
  moveEditableSlide,
  presentationCanvasPxToPoints,
  presentationPointsToCanvasPx,
  removeElementFromSlide,
  resetSlideBackground,
  removeEditableSlides,
  updateSlideBackground,
  type EditableTextElement
} from '../editable-presentation'
import { persistEditablePresentationRevision } from '../editable-presentation-persistence'
import { EDITABLE_PRESENTATION_MIME_TYPE, PPTX_MIME_TYPE } from '../presentation-media'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import type { FileItemRecord } from '@shared/types/folder'

const TEXT_PLACEHOLDER_FIXTURE = resolve(
  process.cwd(),
  'src/renderer/src/lib/__fixtures__/pptx/text-placeholder-layout.pptx'
)

const TEXT_PLACEHOLDER_SNIPPETS = [
  '主愛永不止息',
  'Amazing grace',
  '耶穌基督是主',
  'Holy Spirit come',
  '祢信實何廣大',
  'Great is Thy faithfulness',
  '我要一生敬拜',
  'Here I am to worship',
  '祢愛拯救我',
  'Your love never fails',
  '在祢寶座前',
  'Worthy is the Lamb',
  '哈利路亞',
  'Hallelujah',
  '求祢更新我心',
  'Create in me a clean heart',
  '祢是道路真理生命',
  'You are the way',
  '天父我愛祢',
  'Father we love You',
  '願祢國降臨',
  'Let Your kingdom come'
] as const

describe('presentation point conversion', () => {
  it('maps PowerPoint points to the current canvas width and round-trips', () => {
    expect(presentationPointsToCanvasPx(72, 1920)).toBe(144)
    expect(presentationPointsToCanvasPx(72, 1280)).toBe(96)
    expect(presentationCanvasPxToPoints(144, 1920)).toBe(72)
    expect(presentationCanvasPxToPoints(96, 1280)).toBe(72)
  })
})

type MockXmlNodeInit = {
  attrs?: Record<string, string>
  children?: Record<string, MockXmlNodeInit>
}

type MockXmlNode = {
  child: (name: string) => MockXmlNode
  attr: (name: string) => string | undefined
  numAttr: (name: string) => number | undefined
  exists: () => boolean
}

const missingXmlNode: MockXmlNode = {
  child: () => missingXmlNode,
  attr: () => undefined,
  numAttr: () => undefined,
  exists: () => false
}

function mockXmlNode(init: MockXmlNodeInit = {}): MockXmlNode {
  const children = new Map(
    Object.entries(init.children ?? {}).map(([name, child]) => [name, mockXmlNode(child)])
  )
  return {
    child: (name) => children.get(name) ?? missingXmlNode,
    attr: (name) => init.attrs?.[name],
    numAttr: (name) => {
      const value = init.attrs?.[name]
      return value === undefined ? undefined : Number(value)
    },
    exists: () => true
  }
}

function mockSolidBackgroundSource(color: string): MockXmlNode {
  return mockXmlNode({
    children: {
      cSld: {
        children: {
          bg: {
            children: {
              bgPr: {
                children: {
                  solidFill: {
                    children: {
                      srgbClr: { attrs: { val: color } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  })
}

function mockCenteredWhiteTextShape(
  text: string,
  size: { w: number; h: number } = { w: 1920, h: 1080 }
): unknown {
  return {
    nodeType: 'shape',
    name: 'Title',
    presetGeometry: 'rect',
    position: { x: 0, y: 0 },
    size,
    rotation: 0,
    fill: missingXmlNode,
    line: missingXmlNode,
    source: mockXmlNode(),
    textBody: {
      paragraphs: [
        {
          properties: mockXmlNode({ attrs: { algn: 'ctr' } }),
          endParaRPr: missingXmlNode,
          runs: [
            {
              text,
              properties: mockXmlNode({
                attrs: { sz: '4400' },
                children: {
                  solidFill: {
                    children: {
                      srgbClr: { attrs: { val: 'FFFFFF' } }
                    }
                  }
                }
              })
            }
          ]
        }
      ]
    }
  }
}

function mockMixedStyleTextShape(): unknown {
  const runProperties = (
    attrs: Record<string, string>,
    typeface: string,
    color: string
  ): MockXmlNode =>
    mockXmlNode({
      attrs,
      children: {
        latin: { attrs: { typeface } },
        solidFill: { children: { srgbClr: { attrs: { val: color } } } }
      }
    })

  return {
    nodeType: 'shape',
    name: 'Mixed text',
    presetGeometry: 'rect',
    position: { x: 10, y: 20 },
    size: { w: 800, h: 200 },
    rotation: 0,
    fill: missingXmlNode,
    line: missingXmlNode,
    source: mockXmlNode(),
    textBody: {
      paragraphs: [
        {
          properties: mockXmlNode({ attrs: { algn: 'just' } }),
          endParaRPr: missingXmlNode,
          runs: [
            {
              text: 'Bold',
              properties: runProperties(
                { sz: '7200', b: '1', u: 'sng', spc: '1000' },
                'Arial',
                'FF0000'
              )
            },
            {
              text: ' italic',
              properties: runProperties({ sz: '3600', i: '1' }, 'Calibri', '0000FF')
            }
          ]
        },
        {
          properties: mockXmlNode({ attrs: { algn: 'ctr' } }),
          endParaRPr: missingXmlNode,
          runs: [
            {
              text: 'Second',
              properties: runProperties({ sz: '2400' }, 'Aptos', '00AA00')
            }
          ]
        }
      ]
    }
  }
}

function mockSlide(
  index: number,
  layoutIndex: number,
  source: MockXmlNode
): Record<string, unknown> {
  return {
    index,
    slidePath: `ppt/slides/slide${index + 1}.xml`,
    layoutIndex,
    rels: new Map(),
    source,
    nodes: [mockCenteredWhiteTextShape(`Centered ${index + 1}`)]
  }
}

function makePptxFileItem(overrides: Partial<FileItemRecord> = {}): FileItemRecord {
  return {
    id: 'pptx-source',
    parentId: 'file-root',
    type: 'file',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    name: 'Text Placeholder Layout.pptx',
    url: 'blob:pptx-source',
    size: 100,
    mimeType: PPTX_MIME_TYPE,
    ...overrides
  }
}

function getTextElements(documentSlideElements: Record<string, unknown>): EditableTextElement[] {
  return Object.values(documentSlideElements).filter(
    (element): element is EditableTextElement =>
      typeof element === 'object' &&
      element !== null &&
      'type' in element &&
      element.type === 'text'
  )
}

function decodeSvgDataUrl(dataUrl: string): string {
  const base64 = dataUrl.replace(/^data:image\/svg\+xml;base64,/, '')
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function createStoredBlob(value: string): Blob {
  return new NodeBlob([value], {
    type: EDITABLE_PRESENTATION_MIME_TYPE
  }) as unknown as Blob
}

beforeEach(async () => {
  clearEditablePresentationCache()
  await resetFileExplorerDBForTests()
  await resetMediaWorkDBForTests()
  await resetThumbnailDBForTests()
  useFileExplorerStore.setState({
    folders: {},
    items: {},
    _foldersArray: [],
    _itemsArray: [],
    _childFoldersByParent: {},
    _itemsByParent: {},
    loadedParents: new Set(),
    currentFolderId: 'file-root',
    isLoading: false,
    isInitialized: false
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('editable presentation documents', () => {
  it('creates a blank deck with one editable slide', () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]

    expect(document.name).toBe('Sunday')
    expect(document.width).toBe(1920)
    expect(document.height).toBe(1080)
    expect(document.slides[slideId].background).toEqual({
      type: 'solid',
      color: '#ffffff',
      transparency: 0
    })
    expect(document.slides[slideId].elementOrder).toEqual([])
    expect(document.defaultThemeId).toBe(DEFAULT_PRESENTATION_THEME_ID)
    expect(document.slides[slideId].themeId).toBe(DEFAULT_PRESENTATION_THEME_ID)
    expect(document.themes?.[DEFAULT_PRESENTATION_THEME_ID].defaultTextStyle).toMatchObject({
      fontFamily: 'Inter Variable',
      fontSize: 48,
      color: '#111827'
    })
  })

  it('adds blank slides with the same white default background', () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const updated = addBlankEditableSlide(document)
    const slideId = updated.slideOrder[1]

    expect(updated.slides[slideId].background).toEqual({
      type: 'solid',
      color: '#ffffff',
      transparency: 0
    })
  })

  it('inserts a blank slide after the focused slide', () => {
    const first = createBlankEditablePresentationDocument('Sunday')
    const second = addBlankEditableSlide(first)
    const result = insertBlankEditableSlide(second, 1)

    expect(result.document.slideOrder).toEqual([
      first.slideOrder[0],
      result.slideId,
      second.slideOrder[1]
    ])
    expect(result.document.slides[result.slideId].background).toEqual(second.defaultSlideBackground)
  })

  it('renders solid fill transparency against the white slide base', () => {
    expect(
      getSlideBackgroundCss({
        type: 'solid',
        color: '#800000',
        transparency: 50
      })
    ).toBe('#c08080')
  })

  it('updates, resets, and applies slide backgrounds with native-like fill controls', () => {
    const document = addBlankEditableSlide(createBlankEditablePresentationDocument('Sunday'))
    const firstSlideId = document.slideOrder[0]
    const secondSlideId = document.slideOrder[1]
    const withGradient = updateSlideBackground(document, firstSlideId, {
      type: 'gradient',
      gradientType: 'linear',
      direction: 'diagonal',
      angle: 45,
      stops: [
        { color: '#111827', position: 0, transparency: 10, brightness: -5 },
        { color: '#2563eb', position: 100, transparency: 20, brightness: 15 }
      ]
    })
    const applied = applySlideBackgroundToAllSlides(
      withGradient,
      withGradient.slides[firstSlideId].background
    )
    const reset = resetSlideBackground(applied, firstSlideId)

    expect(applied.slides[secondSlideId].background).toEqual({
      type: 'gradient',
      gradientType: 'linear',
      direction: 'diagonal',
      angle: 45,
      stops: [
        { color: '#111827', position: 0, transparency: 10, brightness: -5 },
        { color: '#2563eb', position: 100, transparency: 20, brightness: 15 }
      ]
    })
    expect(reset.slides[firstSlideId].background).toEqual({
      type: 'solid',
      color: '#ffffff',
      transparency: 0
    })
    const added = addBlankEditableSlide(reset)
    expect(added.slides[added.slideOrder[2]].background).toEqual(applied.defaultSlideBackground)
    const resetAll = applySlideBackgroundToAllSlides(reset, reset.slides[firstSlideId].background)
    expect(addBlankEditableSlide(resetAll).defaultSlideBackground).toEqual(
      reset.slides[firstSlideId].background
    )
    expect(reset.slides[secondSlideId].background).toEqual(applied.slides[secondSlideId].background)
  })

  it('uses the applied-all background as the default for new slides', () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const firstSlideId = document.slideOrder[0]
    const withBackground = updateSlideBackground(document, firstSlideId, {
      type: 'solid',
      color: '#800000',
      transparency: 25
    })
    const applied = applySlideBackgroundToAllSlides(
      withBackground,
      withBackground.slides[firstSlideId].background
    )
    const withNewSlide = addBlankEditableSlide(applied)
    const newSlideId = withNewSlide.slideOrder[1]

    expect(withNewSlide.slides[newSlideId].background).toEqual({
      type: 'solid',
      color: '#800000',
      transparency: 25
    })
  })

  it('renders gradient backgrounds in generated thumbnails against the white slide base', () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const updated = updateSlideBackground(document, slideId, {
      type: 'gradient',
      gradientType: 'linear',
      direction: 'top-bottom',
      angle: 180,
      stops: [
        { color: '#ffffff', position: 0, transparency: 0, brightness: 0 },
        { color: '#111827', position: 100, transparency: 50, brightness: 10 }
      ]
    })
    const dataUrl = generateEditablePresentationThumbnail(updated)
    const svg = decodeSvgDataUrl(dataUrl)

    expect(svg).toContain('<linearGradient')
    expect(svg).toContain('stop-color="#94979e"')
    expect(svg).not.toContain('stop-opacity=')
  })

  it('renders image crop and effects in generated thumbnails', () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const dataUrl = 'data:image/png;base64,AAA='
    const withAsset = {
      ...document,
      assets: {
        asset: {
          id: 'asset',
          name: 'photo.png',
          mimeType: 'image/png',
          dataUrl
        }
      }
    }
    const withImage = addElementToSlide(withAsset, slideId, {
      id: 'image-1',
      type: 'image',
      assetId: 'asset',
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      rotation: 0,
      opacity: 0.8,
      crop: { top: 10, right: 20, bottom: 0, left: 5 },
      borderColor: '#ff0000',
      borderWidth: 4,
      shadow: 'soft'
    })
    const svg = decodeSvgDataUrl(generateEditablePresentationThumbnail(withImage))

    expect(svg).toContain(`href="${dataUrl}"`)
    expect(svg).toContain('clipPath')
    expect(svg).toContain('stroke="#ff0000"')
    expect(svg).toContain('stroke-width="4"')
    expect(svg).toContain('feDropShadow')
  })

  it('renders rich text thumbnails through browser XHTML layout', () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Large & small',
      runs: [
        {
          text: 'Large &',
          fontFamily: 'Arial',
          fontSize: 72,
          bold: true,
          italic: false,
          underline: false,
          color: '#FF0000',
          highlightColor: '#FFFF00',
          characterSpacing: 2
        },
        {
          text: ' small',
          fontFamily: 'Calibri',
          fontSize: 36,
          bold: false,
          italic: true,
          underline: true,
          color: '#0000FF',
          strikethrough: true,
          baseline: 'superscript'
        }
      ]
    })
    const svg = decodeSvgDataUrl(
      generateEditablePresentationThumbnail(addElementToSlide(document, slideId, text))
    )

    expect(svg).toContain('<foreignObject')
    expect(svg).toContain('font-size:72px')
    expect(svg).toContain('font-family:Arial')
    expect(svg).toContain('font-weight:700')
    expect(svg).toContain('Large &amp;')
    expect(svg).toContain('background-color:#FFFF00')
    expect(svg).toContain('letter-spacing:2px')
    expect(svg).toContain('font-size:36px')
    expect(svg).toContain('font-family:Calibri')
    expect(svg).toContain('font-style:italic')
    expect(svg).toContain('text-decoration:underline line-through')
    expect(svg).toContain('vertical-align:super')
  })

  it('marks newly inserted text boxes as content auto-sized until a fixed width is provided', () => {
    const text = createTextElement({ text: 'New text' })

    expect(text).toMatchObject({
      type: 'text',
      autoWidth: true,
      autoSize: 'content',
      width: 24
    })
    expect(presentationCanvasPxToPoints(text.fontSize, 1920)).toBe(24)
    expect(text.height).toBeGreaterThanOrEqual(Math.ceil(text.fontSize * text.lineHeight))

    expect(createTextElement({ text: 'Imported text', width: 360 })).toMatchObject({
      type: 'text',
      width: 360,
      autoWidth: false,
      autoSize: 'fixed'
    })

    expect(createTextElement({ autoSize: 'content', autoWidth: false, width: 360 })).toMatchObject({
      autoWidth: false,
      autoSize: 'content',
      width: 360
    })
  })

  it('centers inserted images within 60 percent of the slide while preserving aspect ratio', () => {
    const wideImage = createImageElement({
      assetId: 'asset-wide',
      slideWidth: 1000,
      slideHeight: 500,
      sourceWidth: 2000,
      sourceHeight: 1000
    })
    const tallImage = createImageElement({
      assetId: 'asset-tall',
      slideWidth: 1000,
      slideHeight: 500,
      sourceWidth: 1000,
      sourceHeight: 2000
    })

    expect(wideImage).toMatchObject({
      type: 'image',
      assetId: 'asset-wide',
      x: 200,
      y: 100,
      width: 600,
      height: 300
    })
    expect(tallImage).toMatchObject({
      assetId: 'asset-tall',
      x: 425,
      y: 100,
      width: 150,
      height: 300
    })
  })

  it('persists inserted text and image edits across save, reload, and delete', async () => {
    vi.stubGlobal('Blob', NodeBlob)
    const document = createBlankEditablePresentationDocument(
      'Sunday',
      '00000000-0000-4000-8000-000000000003'
    )
    const slideId = document.slideOrder[0]
    const asset = {
      id: 'asset-1',
      name: 'photo.png',
      mimeType: 'image/png',
      dataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZaoAAAAASUVORK5CYII='
    }
    const text = createTextElement({
      x: 12,
      y: 34,
      width: 220,
      height: 40,
      autoWidth: false,
      text: 'Hello\nWorld'
    })
    const image = createImageElement({
      assetId: asset.id,
      slideWidth: document.width,
      slideHeight: document.height,
      sourceWidth: 800,
      sourceHeight: 400
    })
    const source = { id: document.id, url: `blob:${document.id}` }
    const db = await openFileExplorerDB()
    await db.put('folder-items', {
      id: document.id,
      parentId: 'file-root',
      type: 'file',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      name: 'Sunday',
      url: source.url,
      size: 0,
      mimeType: EDITABLE_PRESENTATION_MIME_TYPE
    })
    await db.put('file-blobs', {
      id: document.id,
      blob: new Blob([JSON.stringify(document)], { type: EDITABLE_PRESENTATION_MIME_TYPE }),
      size: 0,
      refCount: 1,
      revision: 0
    })
    const withAssets = { ...document, assets: { [asset.id]: asset } }
    const withElements = addElementToSlide(
      addElementToSlide(withAssets, slideId, text),
      slideId,
      image
    )

    await persistEditablePresentationRevision({
      itemId: source.id,
      sourceBlobId: document.id,
      revision: 1,
      document: withElements,
      catalogName: withElements.name
    })
    const reloaded = await loadEditablePresentation({ ...source, name: 'Sunday' })

    expect(reloaded.slides[slideId].elements[text.id]).toMatchObject({
      type: 'text',
      text: 'Hello\nWorld',
      x: 12,
      y: 34,
      width: 220,
      height: 40
    })
    expect(reloaded.slides[slideId].elements[image.id]).toMatchObject({
      type: 'image',
      assetId: asset.id,
      width: 800,
      height: 400
    })

    const withoutImage = removeElementFromSlide(reloaded, slideId, image.id)
    await persistEditablePresentationRevision({
      itemId: source.id,
      sourceBlobId: document.id,
      revision: 2,
      document: withoutImage,
      catalogName: withoutImage.name
    })
    const afterDelete = await loadEditablePresentation({ ...source, name: 'Sunday' })

    expect(afterDelete.slides[slideId].elements[image.id]).toBeUndefined()
    expect(afterDelete.assets[asset.id]).toEqual(asset)
  })

  it('loads the source document ahead of a stale derived mirror', async () => {
    const sourceDocument = createBlankEditablePresentationDocument(
      'Source',
      '00000000-0000-4000-8000-000000000005'
    )
    const staleDocument = { ...sourceDocument, name: 'Stale mirror' }
    const source = { id: 'deck-1', url: 'blob:deck-source', name: 'Deck' }
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'deck-source',
      blob: createStoredBlob(JSON.stringify(sourceDocument)),
      revision: 2
    })
    await putDerivedAsset({
      sourceBlobId: 'deck-source',
      kind: EDITABLE_PRESENTATION_DOCUMENT_KIND,
      variant: `document:${source.id}`,
      storage: 'indexed-db',
      mimeType: EDITABLE_PRESENTATION_MIME_TYPE,
      status: 'ready',
      blob: createStoredBlob(JSON.stringify(staleDocument)),
      metadata: {
        presentationDocumentJson: JSON.stringify(staleDocument),
        presentationRevision: 1
      }
    })

    const loaded = await loadEditablePresentation(source)

    expect(loaded.name).toBe('Source')
  })

  it('preserves legacy auto-width text without injecting autoSize on load', async () => {
    const document = createBlankEditablePresentationDocument('Legacy')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Legacy text', autoWidth: true })
    const contentHeightText = createTextElement({ text: 'Content height', autoSize: 'content' })
    delete text.autoSize
    delete contentHeightText.autoWidth
    const source = { id: 'deck-legacy', url: 'blob:deck-legacy', name: 'Legacy' }
    const stored = addElementToSlide(
      addElementToSlide(document, slideId, text),
      slideId,
      contentHeightText
    )
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'deck-legacy',
      blob: createStoredBlob(JSON.stringify(stored)),
      revision: 1
    })

    const loaded = await loadEditablePresentation(source)
    const loadedText = loaded.slides[slideId].elements[text.id]

    expect(loadedText).toMatchObject({ type: 'text', autoWidth: true })
    expect(loadedText.type === 'text' ? loadedText.autoSize : undefined).toBeUndefined()
    const loadedContentHeightText = loaded.slides[slideId].elements[contentHeightText.id]
    expect(loadedContentHeightText).toMatchObject({ type: 'text', autoSize: 'content' })
    expect(
      loadedContentHeightText.type === 'text' ? loadedContentHeightText.autoWidth : undefined
    ).toBeUndefined()
  })

  it('adds the default theme when loading a legacy document', async () => {
    const document = createBlankEditablePresentationDocument('Legacy theme')
    const slideId = document.slideOrder[0]
    delete document.themes
    delete document.defaultThemeId
    delete document.slides[slideId].themeId
    const source = { id: 'deck-legacy-theme', url: 'blob:deck-legacy-theme', name: 'Legacy theme' }
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'deck-legacy-theme',
      blob: createStoredBlob(JSON.stringify(document)),
      revision: 1
    })

    const loaded = await loadEditablePresentation(source)

    expect(loaded.defaultThemeId).toBe(DEFAULT_PRESENTATION_THEME_ID)
    expect(loaded.slides[slideId].themeId).toBe(DEFAULT_PRESENTATION_THEME_ID)
    expect(loaded.themes?.[DEFAULT_PRESENTATION_THEME_ID]).toBeDefined()
  })

  it('reuses parsed documents by source revision and invalidates on revision change', async () => {
    const firstDocument = createBlankEditablePresentationDocument(
      'Revision one',
      '00000000-0000-4000-8000-000000000015'
    )
    const source = { id: 'deck-cache', url: 'blob:deck-cache-source', name: 'Deck' }
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'deck-cache-source',
      blob: createStoredBlob(JSON.stringify(firstDocument)),
      revision: 1
    })

    const first = await loadEditablePresentation(source)
    const cached = await loadEditablePresentation(source)
    expect(cached).toBe(first)

    const secondDocument = { ...firstDocument, name: 'Revision two' }
    await db.put('file-blobs', {
      id: 'deck-cache-source',
      blob: createStoredBlob(JSON.stringify(secondDocument)),
      revision: 2
    })
    const refreshed = await loadEditablePresentation(source)

    expect(refreshed).not.toBe(first)
    expect(refreshed.name).toBe('Revision two')
  })

  it('loads the document and persisted revision from one source snapshot', async () => {
    const document = createBlankEditablePresentationDocument(
      'Sunday',
      '00000000-0000-4000-8000-000000000016'
    )
    const source = { id: 'deck-snapshot', url: 'blob:deck-snapshot-source', name: 'Deck' }
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'deck-snapshot-source',
      blob: createStoredBlob(JSON.stringify(document)),
      revision: 4
    })

    await expect(loadEditablePresentationSnapshot(source)).resolves.toMatchObject({
      revision: 4,
      document: { name: 'Sunday' }
    })
  })

  it('preserves the persisted default slide background when loading', async () => {
    const document = {
      ...createBlankEditablePresentationDocument('Sunday', '00000000-0000-4000-8000-000000000017'),
      defaultSlideBackground: {
        type: 'solid' as const,
        color: '#123456',
        transparency: 20
      }
    }
    const source = { id: 'deck-background', url: 'blob:deck-background-source', name: 'Deck' }
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'deck-background-source',
      blob: createStoredBlob(JSON.stringify(document)),
      revision: 1
    })

    const loaded = await loadEditablePresentation(source)

    expect(loaded.defaultSlideBackground).toEqual({
      type: 'solid',
      color: '#123456',
      transparency: 20
    })
  })

  it('rejects a derived-only document when its source is missing', async () => {
    const document = createBlankEditablePresentationDocument(
      'Derived only',
      '00000000-0000-4000-8000-000000000006'
    )
    const source = { id: 'deck-1', url: 'blob:missing-source', name: 'Deck' }
    await putDerivedAsset({
      sourceBlobId: 'missing-source',
      kind: EDITABLE_PRESENTATION_DOCUMENT_KIND,
      variant: `document:${source.id}`,
      storage: 'indexed-db',
      mimeType: EDITABLE_PRESENTATION_MIME_TYPE,
      status: 'ready',
      blob: createStoredBlob(JSON.stringify(document)),
      metadata: {
        presentationDocumentJson: JSON.stringify(document),
        presentationRevision: 1
      }
    })

    await expect(loadEditablePresentation(source)).rejects.toThrow(
      'Editable presentation source is missing'
    )
  })

  it('does not recreate a legacy derived mirror while loading canonical source', async () => {
    const document = createBlankEditablePresentationDocument(
      'Source revision',
      '00000000-0000-4000-8000-000000000007'
    )
    const source = { id: 'deck-1', url: 'blob:deck-source', name: 'Deck' }
    const db = await openFileExplorerDB()
    await db.put('file-blobs', {
      id: 'deck-source',
      blob: createStoredBlob(JSON.stringify(document)),
      revision: 3
    })

    const loaded = await loadEditablePresentation(source)

    expect(loaded.name).toBe('Source revision')
    await expect(
      getDerivedAsset('deck-source', EDITABLE_PRESENTATION_DOCUMENT_KIND, `document:${source.id}`)
    ).resolves.toBeUndefined()
  })

  it('duplicates slides without reusing element ids', () => {
    const blank = createBlankEditablePresentationDocument('Sunday')
    const slideId = blank.slideOrder[0]
    const text = createTextElement({ text: 'Welcome' })
    const withText = addElementToSlide(blank, slideId, text)
    const duplicated = duplicateEditableSlide(withText, slideId)
    const copiedSlideId = duplicated.slideOrder[1]
    const copiedElementId = duplicated.slides[copiedSlideId].elementOrder[0]

    expect(copiedSlideId).not.toBe(slideId)
    expect(copiedElementId).not.toBe(text.id)
    expect(duplicated.slides[copiedSlideId].elements[copiedElementId]).toMatchObject({
      type: 'text',
      text: 'Welcome'
    })
  })

  it('duplicates multiple selected slides into the requested insertion position', () => {
    const blank = createBlankEditablePresentationDocument('Sunday')
    const withSecond = addBlankEditableSlide(blank)
    const withThird = addBlankEditableSlide(withSecond)
    const text = createTextElement({ text: 'Welcome' })
    const firstSlideId = withThird.slideOrder[0]
    const thirdSlideId = withThird.slideOrder[2]
    const withText = addElementToSlide(withThird, firstSlideId, text)
    const duplicated = duplicateEditableSlides(withText, [thirdSlideId, firstSlideId], 1)

    expect(duplicated.slideIds).toHaveLength(2)
    expect(duplicated.document.slideOrder).toEqual([
      firstSlideId,
      duplicated.slideIds[0],
      duplicated.slideIds[1],
      withThird.slideOrder[1],
      thirdSlideId
    ])
    expect(duplicated.slideIds[0]).not.toBe(firstSlideId)
    expect(duplicated.document.slides[duplicated.slideIds[0]].elementOrder[0]).not.toBe(text.id)
  })

  it('removes multiple selected slides without deleting the last remaining slide', () => {
    const first = createBlankEditablePresentationDocument('Sunday')
    const second = addBlankEditableSlide(first)
    const third = addBlankEditableSlide(second)
    const removedMiddle = removeEditableSlides(third, [third.slideOrder[0], third.slideOrder[1]])
    const removedAll = removeEditableSlides(third, third.slideOrder)

    expect(removedMiddle.slideOrder).toEqual([third.slideOrder[2]])
    expect(removedAll.slideOrder).toHaveLength(1)
    expect(removedAll.slideOrder[0]).toBe(third.slideOrder[0])
  })

  it('moves slides and removes duplicated elements', () => {
    const blank = createBlankEditablePresentationDocument('Sunday')
    const firstSlideId = blank.slideOrder[0]
    const withSecondSlide = duplicateEditableSlide(blank, firstSlideId)
    const moved = moveEditableSlide(withSecondSlide, firstSlideId, 1)
    const text = createTextElement({ text: 'Welcome' })
    const withText = addElementToSlide(moved, firstSlideId, text)
    const duplicated = duplicateElementInSlide(withText, firstSlideId, text.id)
    const removed = removeElementFromSlide(duplicated.document, firstSlideId, text.id)

    expect(moved.slideOrder[1]).toBe(firstSlideId)
    expect(duplicated.elementId).not.toBe(text.id)
    expect(removed.slides[firstSlideId].elementOrder).toEqual([duplicated.elementId])
  })

  it('creates a file item with one canonical editable deck body', async () => {
    vi.stubGlobal('Blob', NodeBlob)
    const item = await createEditablePresentation('Sunday', 'file-root')
    const loaded = await loadEditablePresentation(item)
    const asset = await getDerivedAsset(
      item.id,
      EDITABLE_PRESENTATION_DOCUMENT_KIND,
      `document:${item.id}`
    )

    expect(item.mimeType).toBe(EDITABLE_PRESENTATION_MIME_TYPE)
    expect(item.url).toBe(`blob:${item.id}`)
    expect(loaded.name).toBe('Sunday')
    expect(asset).toBeUndefined()
  })

  it('imports the text-placeholder fixture as editable CSS-px text boxes', async () => {
    const fileBytes = await readFile(TEXT_PLACEHOLDER_FIXTURE)
    const buffer = await new Blob([fileBytes]).arrayBuffer()
    const files = await parseZip(buffer)
    const presentation = buildPresentation(files)
    materializeAllSlideNodes(presentation)

    const document = convertPresentationData(makePptxFileItem(), presentation)
    const allText = document.slideOrder
      .flatMap((slideId) => getTextElements(document.slides[slideId].elements))
      .map((element) => element.text)
      .join('\n')

    expect(document.slideOrder).toHaveLength(22)
    expect(document.width).toBeGreaterThan(0)
    expect(document.height).toBeGreaterThan(0)
    expect(document.width).toBeLessThan(4000)
    expect(document.height).toBeLessThan(4000)
    expect(document.width).not.toBe(12192000)
    expect(document.height).not.toBe(6858000)

    for (const slideId of document.slideOrder) {
      const textElements = getTextElements(document.slides[slideId].elements)

      expect(textElements.length).toBeGreaterThan(0)
      for (const element of textElements) {
        expect(element.width).toBeGreaterThan(0)
        expect(element.height).toBeGreaterThan(0)
        expect(element.width).toBeLessThan(4000)
        expect(element.height).toBeLessThan(4000)
        expect(element.autoWidth).toBe(false)
        expect(element.locked).not.toBe(true)
        expect(element.text).toContain('\n')
      }
    }
    for (const snippet of TEXT_PLACEHOLDER_SNIPPETS) {
      expect(allText).toContain(snippet)
    }
    expect(
      getTextElements(document.slides[document.slideOrder[0]].elements)[0].fontSize
    ).toBeCloseTo((88 * 96) / 72)
  })

  it('keeps imported fixed text frames at their resolved OOXML height', () => {
    const presentation = {
      width: 1920,
      height: 1080,
      slides: [
        {
          ...(mockSlide(0, 0, mockXmlNode()) as Record<string, unknown>),
          nodes: [mockCenteredWhiteTextShape('Line one\nLine two\nLine three', { w: 600, h: 40 })]
        }
      ],
      layouts: new Map(),
      masters: new Map(),
      layoutToMaster: new Map(),
      media: new Map()
    } as unknown as PresentationData

    const document = convertPresentationData(makePptxFileItem(), presentation)
    const text = getTextElements(document.slides[document.slideOrder[0]].elements)[0]

    expect(text.autoSize).toBe('fixed')
    expect(text.height).toBe(40)
  })

  it('preserves mixed PPTX run formatting and paragraph breaks', () => {
    const presentation = {
      width: 1920,
      height: 1080,
      slides: [
        {
          ...(mockSlide(0, 0, mockXmlNode()) as Record<string, unknown>),
          nodes: [mockMixedStyleTextShape()]
        }
      ],
      layouts: new Map(),
      masters: new Map(),
      layoutToMaster: new Map(),
      media: new Map()
    } as unknown as PresentationData

    const document = convertPresentationData(makePptxFileItem(), presentation)
    const text = getTextElements(document.slides[document.slideOrder[0]].elements)[0]

    expect(text.text).toBe('Bold italic\nSecond')
    expect(text.runs).toEqual([
      {
        text: 'Bold',
        fontFamily: 'Arial',
        fontSize: 96,
        bold: true,
        italic: false,
        underline: true,
        color: '#FF0000'
      },
      {
        text: ' italic',
        fontFamily: 'Calibri',
        fontSize: 48,
        bold: false,
        italic: true,
        underline: false,
        color: '#0000FF'
      },
      {
        text: '\nSecond',
        fontFamily: 'Aptos',
        fontSize: 32,
        bold: false,
        italic: false,
        underline: false,
        color: '#00AA00'
      }
    ])
    expect(text.paragraphs).toHaveLength(2)
    expect(text.paragraphs?.[0]).toMatchObject({
      align: 'justify',
      lineSpacing: { kind: 'multiple', value: 1 }
    })
    expect(text.paragraphs?.[0].runs[0].characterSpacing).toBeCloseTo(4 / 3)
    expect(text.paragraphs?.[0].runs.map((run) => run.text)).toEqual(['Bold', ' italic'])
  })

  it('preserves each imported slide theme identity and palette', () => {
    const makeTheme = (
      accent1: string,
      font: string
    ): {
      colorScheme: Map<string, string>
      majorFont: Record<string, string>
      minorFont: Record<string, string>
      fillStyles: never[]
      lineStyles: never[]
      effectStyles: never[]
    } => ({
      colorScheme: new Map([
        ['dk1', '000000'],
        ['lt1', 'FFFFFF'],
        ['accent1', accent1]
      ]),
      majorFont: { latin: font, ea: font, cs: font },
      minorFont: { latin: font, ea: font, cs: font },
      fillStyles: [],
      lineStyles: [],
      effectStyles: []
    })
    const presentation = {
      width: 1920,
      height: 1080,
      slides: [
        mockSlide(0, 'layout-a' as unknown as number, mockXmlNode()),
        mockSlide(1, 'layout-b' as unknown as number, mockXmlNode())
      ],
      layouts: new Map(),
      masters: new Map(),
      themes: new Map([
        ['theme-a', makeTheme('112233', 'Aptos')],
        ['theme-b', makeTheme('445566', 'Arial')]
      ]),
      slideToLayout: new Map([
        [0, 'layout-a'],
        [1, 'layout-b']
      ]),
      layoutToMaster: new Map([
        ['layout-a', 'master-a'],
        ['layout-b', 'master-b']
      ]),
      masterToTheme: new Map([
        ['master-a', 'theme-a'],
        ['master-b', 'theme-b']
      ]),
      media: new Map()
    } as unknown as PresentationData

    const document = convertPresentationData(makePptxFileItem(), presentation)

    expect(document.slides[document.slideOrder[0]].themeId).toBe('theme-a')
    expect(document.slides[document.slideOrder[1]].themeId).toBe('theme-b')
    expect(document.themes?.['theme-a'].colorScheme.accent1).toBe('#112233')
    expect(document.themes?.['theme-b'].defaultTextStyle.fontFamily).toBe('Arial')
  })

  it('preserves direct slide, layout, and master solid black backgrounds with centered white text', () => {
    const blackBackground = mockSolidBackgroundSource('000000').child('cSld').child('bg')
    const presentation = {
      width: 1920,
      height: 1080,
      slides: [
        { ...mockSlide(0, 0, mockXmlNode()), background: blackBackground },
        mockSlide(1, 1, mockXmlNode()),
        mockSlide(2, 2, mockXmlNode())
      ],
      layouts: new Map([
        [1, { background: blackBackground, placeholders: [] }],
        [2, { source: mockXmlNode(), placeholders: [] }]
      ]),
      masters: new Map([['master-1', { background: blackBackground, placeholders: [] }]]),
      layoutToMaster: new Map([[2, 'master-1']]),
      media: new Map()
    } as unknown as PresentationData

    const document = convertPresentationData(makePptxFileItem({ name: 'Black.pptx' }), presentation)

    for (const slideId of document.slideOrder) {
      const text = getTextElements(document.slides[slideId].elements)[0]

      expect(document.slides[slideId].background).toEqual({
        type: 'solid',
        color: '#000000',
        transparency: 0
      })
      expect(text).toMatchObject({
        color: '#FFFFFF',
        align: 'center',
        x: 0,
        y: 0,
        width: 1920,
        height: 1080
      })
    }
  })
})

it('chooses thumbnail outlines from the composited slide background', () => {
  expect(getSlideBackgroundOutline({ type: 'solid', color: '#ffffff', transparency: 0 })).toBe(
    'dark'
  )
  expect(getSlideBackgroundOutline({ type: 'solid', color: '#000000', transparency: 0 })).toBe(
    'light'
  )
  expect(getSlideBackgroundOutline({ type: 'solid', color: '#000000', transparency: 100 })).toBe(
    'dark'
  )
  expect(
    getSlideBackgroundOutline({
      type: 'gradient',
      from: '#000000',
      to: '#ffffff',
      direction: 'left-right'
    })
  ).toBe('mixed')
})
