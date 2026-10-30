import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createShapeElement,
  duplicateElementInSlide,
  removeElementFromSlide,
  reorderElementInSlide,
  updateElementInSlide
} from '../editable-presentation'
import { describe, expect, it } from 'vitest'
import type {
  EditablePresentationDocument,
  EditablePresentationElement,
  EditablePresentationSlide
} from '../editable-presentation'
import {
  alignElements,
  distributeElements,
  nudgeElements,
  reorderSelectedSlides,
  selectElementsInBounds,
  snapElementPosition
} from '../presentation-editor-commands'

function element(
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 80,
  locked = false
): EditablePresentationElement {
  return {
    id,
    type: 'shape',
    shape: 'rectangle',
    x,
    y,
    width,
    height,
    rotation: 0,
    opacity: 1,
    locked,
    fillColor: '#ffffff',
    strokeColor: '#000000',
    strokeWidth: 1
  }
}

function makeDocument(elements: EditablePresentationElement[] = []): EditablePresentationDocument {
  const slide = makeSlide(elements)
  return {
    id: 'deck-1',
    name: 'Deck',
    width: 1000,
    height: 600,
    slideOrder: ['slide-a', 'slide-b', 'slide-c', 'slide-d'],
    slides: {
      'slide-a': slide,
      'slide-b': { ...makeSlide([]), id: 'slide-b' },
      'slide-c': { ...makeSlide([]), id: 'slide-c' },
      'slide-d': { ...makeSlide([]), id: 'slide-d' }
    },
    assets: {},
    createdAt: 1,
    updatedAt: 1
  }
}

function makeSlide(elements: EditablePresentationElement[]): EditablePresentationSlide {
  return {
    id: 'slide-a',
    name: 'Slide',
    background: { type: 'solid', color: '#000000', transparency: 0 },
    elementOrder: elements.map((entry) => entry.id),
    elements: Object.fromEntries(elements.map((entry) => [entry.id, entry])),
    notes: ''
  }
}

describe('presentation editor commands', () => {
  it('reorders selected slides as one stable block', () => {
    const document = makeDocument()

    const movedToEnd = reorderSelectedSlides(document, ['slide-b', 'slide-c'], 4)
    const movedToStart = reorderSelectedSlides(document, ['slide-b', 'slide-c'], 0)

    expect(movedToEnd.slideOrder).toEqual(['slide-a', 'slide-d', 'slide-b', 'slide-c'])
    expect(movedToStart.slideOrder).toEqual(['slide-b', 'slide-c', 'slide-a', 'slide-d'])
    expect(document.slideOrder).toEqual(['slide-a', 'slide-b', 'slide-c', 'slide-d'])
  })

  it('selects unlocked elements intersecting the marquee in z-order', () => {
    const slide = makeSlide([
      element('outside', 500, 400),
      element('inside', 100, 100),
      element('crossing', 180, 180),
      element('locked', 120, 120, 50, 50, true)
    ])

    expect(selectElementsInBounds(slide, { x: 80, y: 80, width: 180, height: 180 })).toEqual([
      'inside',
      'crossing'
    ])
  })

  it('nudges selected elements together beyond the slide edges', () => {
    const document = makeDocument([element('a', 10, 10), element('b', 200, 100)])

    const nudged = nudgeElements(document, 'slide-a', ['a', 'b'], -30, -20)

    expect(nudged.slides['slide-a'].elements.a).toMatchObject({ x: -20, y: -10 })
    expect(nudged.slides['slide-a'].elements.b).toMatchObject({ x: 170, y: 80 })
  })

  it('aligns selected elements to their collective bounds', () => {
    const document = makeDocument([element('a', 100, 40, 80, 40), element('b', 260, 120, 120, 60)])

    const left = alignElements(document, 'slide-a', ['a', 'b'], 'left')
    const middle = alignElements(document, 'slide-a', ['a', 'b'], 'middle')

    expect(left.slides['slide-a'].elements.b.x).toBe(100)
    expect(middle.slides['slide-a'].elements.a.y).toBe(90)
    expect(middle.slides['slide-a'].elements.b.y).toBe(80)
  })

  it('distributes three or more elements while keeping the outer elements fixed', () => {
    const document = makeDocument([
      element('a', 0, 0, 100, 50),
      element('b', 140, 80, 100, 50),
      element('c', 400, 240, 100, 50)
    ])

    const horizontal = distributeElements(document, 'slide-a', ['a', 'b', 'c'], 'horizontal')
    const vertical = distributeElements(document, 'slide-a', ['a', 'b', 'c'], 'vertical')

    expect(horizontal.slides['slide-a'].elements.a.x).toBe(0)
    expect(horizontal.slides['slide-a'].elements.b.x).toBe(200)
    expect(horizontal.slides['slide-a'].elements.c.x).toBe(400)
    expect(vertical.slides['slide-a'].elements.b.y).toBe(120)
  })

  it('snaps an element to slide centers within tolerance and reports guides', () => {
    const result = snapElementPosition(
      element('a', 446, 258, 100, 80),
      { width: 1000, height: 600 },
      6
    )

    expect(result).toEqual({
      x: 450,
      y: 260,
      verticalGuide: 500,
      horizontalGuide: 300
    })
  })
})

describe('adjusted v3 shape document commands', () => {
  it('retains creation parameters and avoids an equivalent adjustment edit', () => {
    const source = createBlankEditablePresentationDocument('Geometry')
    source.schemaVersion = 3
    const shape = createShapeElement('rightArrow', { adjustments: [25000, 75000] })
    expect(shape.adjustments).toEqual([25000, 75000])
    const slideId = source.slideOrder[0]
    const document = addElementToSlide(source, slideId, shape)
    expect(updateElementInSlide(document, slideId, shape.id, { adjustments: [25000, 75000] })).toBe(
      document
    )
  })

  it('preserves parameters across edit, duplicate, reorder and delete while detaching copied source identity', () => {
    const source = createBlankEditablePresentationDocument('Geometry')
    source.schemaVersion = 3
    const slideId = source.slideOrder[0]
    const shape = {
      ...createShapeElement('triangle'),
      adjustments: [25000],
      pptxSourceNode: { id: '2', role: 'geometry' as const }
    }
    const initial = addElementToSlide(source, slideId, shape)
    const edited = updateElementInSlide(initial, slideId, shape.id, { adjustments: [75000] })
    const duplicated = duplicateElementInSlide(edited, slideId, shape.id)
    const clone = duplicated.document.slides[slideId].elements[duplicated.elementId]
    expect(clone).toMatchObject({ shape: 'triangle', adjustments: [75000] })
    expect(clone).not.toHaveProperty('pptxSourceNode')
    expect(duplicated.document.slides[slideId].elements[shape.id]).toHaveProperty(
      'pptxSourceNode',
      shape.pptxSourceNode
    )
    const reordered = reorderElementInSlide(
      duplicated.document,
      slideId,
      duplicated.elementId,
      'send-to-back'
    )
    expect(reordered.slides[slideId].elementOrder).toEqual([duplicated.elementId, shape.id])
    const deleted = removeElementFromSlide(reordered, slideId, shape.id)
    expect(deleted.slides[slideId].elementOrder).toEqual([duplicated.elementId])
    expect(deleted.slides[slideId].elements[duplicated.elementId]).toMatchObject({
      adjustments: [75000]
    })
    expect(deleted.schemaVersion).toBe(3)
    expect(initial.slides[slideId].elements[shape.id]).toMatchObject({ adjustments: [25000] })
  })
})
