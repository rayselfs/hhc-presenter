import { describe, expect, it } from 'vitest'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createImageElement,
  createShapeElement,
  insertBlankEditableSlide
} from '../editable-presentation'
import {
  createSlideClipboard,
  cutSlides,
  pasteSlideClipboard
} from '../presentation-slide-clipboard'

describe('presentation slide clipboard', () => {
  it('copies selected slides in document order with referenced assets only', () => {
    const first = createBlankEditablePresentationDocument('Source')
    const second = insertBlankEditableSlide(first, 1).document
    const asset = {
      id: 'asset',
      name: 'photo',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AA=='
    }
    const image = createImageElement({
      assetId: asset.id,
      slideWidth: 1920,
      slideHeight: 1080,
      sourceWidth: 10,
      sourceHeight: 10
    })
    const document = addElementToSlide(
      { ...second, assets: { asset, unused: { ...asset, id: 'unused' } } },
      second.slideOrder[1],
      image
    )

    const clipboard = createSlideClipboard(document, [second.slideOrder[1], second.slideOrder[0]])

    expect(clipboard.slides.map((slide) => slide.id)).toEqual(second.slideOrder)
    expect(Object.keys(clipboard.assets)).toEqual(['asset'])
  })

  it('pastes fresh slide and element ids at the requested index', () => {
    const source = createBlankEditablePresentationDocument('Source')
    const clipboard = createSlideClipboard(source, source.slideOrder)
    const destination = createBlankEditablePresentationDocument('Destination')

    const result = pasteSlideClipboard(destination, clipboard, 0)

    expect(result.slideIds[0]).not.toBe(source.slideOrder[0])
    expect(result.document.slideOrder[0]).toBe(result.slideIds[0])
    expect(destination.slideOrder).toHaveLength(1)
  })

  it('remaps conflicting asset and theme ids without changing destination content', () => {
    const source = createBlankEditablePresentationDocument('Source')
    const sourceSlideId = source.slideOrder[0]
    const sourceThemeId = source.slides[sourceSlideId].themeId!
    source.themes![sourceThemeId].colorScheme.accent1 = '#ff0000'
    source.assets.asset = {
      id: 'asset',
      name: 'source',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,SOURCE'
    }
    const image = createImageElement({
      assetId: 'asset',
      slideWidth: source.width,
      slideHeight: source.height,
      sourceWidth: 10,
      sourceHeight: 10
    })
    const sourceWithImage = addElementToSlide(source, sourceSlideId, image)
    const destination = createBlankEditablePresentationDocument('Destination')
    const destinationThemeId = destination.defaultThemeId!
    destination.themes![destinationThemeId] = {
      ...source.themes![sourceThemeId],
      id: destinationThemeId,
      colorScheme: { ...source.themes![sourceThemeId].colorScheme, accent1: '#0000ff' }
    }
    destination.assets.asset = {
      id: 'asset',
      name: 'destination',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,DESTINATION'
    }

    const result = pasteSlideClipboard(
      destination,
      createSlideClipboard(sourceWithImage, [sourceSlideId]),
      1
    )
    const pastedSlide = result.document.slides[result.slideIds[0]]
    const pastedImage = pastedSlide.elements[pastedSlide.elementOrder[0]]

    expect(result.document.assets.asset.name).toBe('destination')
    expect(pastedImage.type === 'image' ? pastedImage.assetId : null).not.toBe('asset')
    expect(result.document.themes![destinationThemeId].colorScheme.accent1).toBe('#0000ff')
    expect(pastedSlide.themeId).not.toBe(destinationThemeId)
  })

  it('leaves one empty slide when cutting every source slide', () => {
    const source = createBlankEditablePresentationDocument('Source')
    const result = cutSlides(source, source.slideOrder)

    expect(result.slideOrder).toHaveLength(1)
    expect(result.slides[result.slideOrder[0]].elementOrder).toEqual([])
    expect(result.slideOrder[0]).not.toBe(source.slideOrder[0])
  })
})

it('preserves adjusted v3 clipboard geometry and detaches source references', () => {
  const source = createBlankEditablePresentationDocument('Source')
  source.schemaVersion = 3
  const slideId = source.slideOrder[0]
  source.slides[slideId].pptxSourcePart = 'ppt/slides/slide1.xml'
  const shape = {
    ...createShapeElement('rightArrow'),
    adjustments: [25000, 75000],
    pptxSourceNode: { id: '2', role: 'geometry' as const }
  }
  const clipboard = createSlideClipboard(addElementToSlide(source, slideId, shape), [slideId])
  const destination = createBlankEditablePresentationDocument('Destination')
  destination.schemaVersion = 3
  const pasted = pasteSlideClipboard(destination, clipboard, 1)
  const slide = pasted.document.slides[pasted.slideIds[0]]
  const copied = slide.elements[slide.elementOrder[0]]
  expect(copied).toMatchObject({ shape: 'rightArrow', adjustments: [25000, 75000] })
  expect(copied.id).not.toBe(shape.id)
  expect(copied).not.toHaveProperty('pptxSourceNode')
  expect(slide).not.toHaveProperty('pptxSourcePart')
  expect(pasted.document.schemaVersion).toBe(3)
  expect(clipboard.slides[0].elements[shape.id]).toHaveProperty('pptxSourceNode')
})

it.each([1, 2] as const)(
  'rejects v3-only clipboard content in schema v%s without upgrading the destination',
  (version) => {
    const source = createBlankEditablePresentationDocument('Source')
    source.schemaVersion = 3
    const slideId = source.slideOrder[0]
    const clipboard = createSlideClipboard(
      addElementToSlide(source, slideId, createShapeElement('triangle')),
      [slideId]
    )
    const destination = createBlankEditablePresentationDocument('Destination')
    destination.schemaVersion = version
    expect(() => pasteSlideClipboard(destination, clipboard, 1)).toThrow(
      'Shape parameters require schema v3'
    )
    expect(destination.schemaVersion).toBe(version)
    expect(destination.slideOrder).toHaveLength(1)
  }
)
