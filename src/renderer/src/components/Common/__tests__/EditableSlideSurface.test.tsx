import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import EditableSlideSurface from '../EditableSlideSurface'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createTextElement,
  createShapeElement,
  type EditableShapeElement,
  type EditablePresentationDocument
} from '@renderer/lib/editable-presentation'
import {
  getSlideSurface,
  mockSurfaceRect,
  mockSurfaceScale
} from '@renderer/test/editable-slide-surface-harness'

describe('EditableSlideSurface interaction contract', () => {
  it.each([false, true])('only intercepts element clicks when editable=%s', async (editable) => {
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const document = addElementToSlide(
      source,
      slideId,
      createTextElement({ text: 'Current slide' })
    )
    const onClick = vi.fn()
    const onSelectElement = vi.fn()
    render(
      <div onClick={onClick}>
        <EditableSlideSurface
          document={document}
          slideId={slideId}
          editable={editable}
          onSelectElement={onSelectElement}
        />
      </div>
    )
    await act(async () => fireEvent.click(screen.getByText('Current slide')))
    expect(onClick).toHaveBeenCalledTimes(editable ? 0 : 1)
    expect(onSelectElement).toHaveBeenCalledTimes(editable ? 1 : 0)
  })

  it('preserves imported text insets and vertical alignment', () => {
    const source = createBlankEditablePresentationDocument('Imported')
    const slideId = source.slideOrder[0]
    const text = {
      ...createTextElement(),
      verticalAlign: 'center' as const,
      textInsets: { top: 10, right: 30, bottom: 40, left: 20 }
    }
    const document = addElementToSlide(source, slideId, text)
    const { container } = render(<EditableSlideSurface document={document} slideId={slideId} />)
    expect(container.querySelector('[data-text-content]')).toHaveStyle({
      padding: '10px 30px 40px 20px',
      justifyContent: 'center',
      display: 'flex',
      boxSizing: 'border-box'
    })
  })

  it('creates a compact auto-sized text box on click while text insert mode is active', () => {
    const handleInsertText = vi.fn()
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const { container } = render(
      <EditableSlideSurface
        document={source}
        slideId={slideId}
        editable
        isTextInsertMode
        onInsertText={handleInsertText}
      />
    )
    const surface = getSlideSurface(container)
    mockSurfaceRect(surface)

    fireEvent.pointerDown(surface, { clientX: 100, clientY: 50, pointerId: 1 })
    fireEvent.pointerUp(surface, { clientX: 100, clientY: 50, pointerId: 1 })

    expect(handleInsertText).toHaveBeenCalledWith({
      x: 200,
      y: 100,
      width: 24,
      height: 32,
      autoSize: 'content',
      autoWidth: true
    })
  })

  it('creates a minimum 80 x 40 content-height text box from a small drag while text insert mode is active', () => {
    const handleInsertText = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const { container } = render(
      <EditableSlideSurface
        document={document}
        slideId={slideId}
        editable
        isTextInsertMode
        onInsertText={handleInsertText}
      />
    )
    const surface = getSlideSurface(container)
    mockSurfaceRect(surface)

    fireEvent.pointerDown(surface, { clientX: 100, clientY: 50, pointerId: 1 })
    fireEvent.pointerMove(surface, { clientX: 120, clientY: 60, pointerId: 1 })
    fireEvent.pointerUp(surface, { clientX: 120, clientY: 60, pointerId: 1 })

    expect(handleInsertText).toHaveBeenCalledWith({
      x: 200,
      y: 100,
      width: 80,
      height: 40,
      autoSize: 'content',
      autoWidth: false
    })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

it.each([false, true])(
  'renders adjusted v3 geometry on the shared surface with editable=%s',
  (editable) => {
    const source = createBlankEditablePresentationDocument('Geometry')
    source.schemaVersion = 3
    const element = {
      ...createShapeElement('triangle', { width: 200, height: 100, rotation: 35 }),
      adjustments: [25000]
    }
    const slideId = source.slideOrder[0]
    const { container } = render(
      <EditableSlideSurface
        document={addElementToSlide(source, slideId, element)}
        slideId={slideId}
        editable={editable}
      />
    )
    const path = container.querySelector('svg[data-shape-kind="triangle"] path')
    expect(path).toHaveAttribute('d', 'M0 100 L50 0 L200 100 Z')
    expect(path).toHaveAttribute('fill', element.fillColor)
    expect(path).toHaveAttribute('stroke-width', String(element.strokeWidth))
    expect(path?.closest('[data-slide-element]')).toHaveStyle({ transform: 'rotate(35deg)' })
  }
)

describe('v3 preset adjustment interactions', () => {
  function fixture(
    adjustments: readonly number[] = [50000],
    rotation = 90
  ): {
    element: EditableShapeElement
    slideId: string
    document: EditablePresentationDocument
  } {
    const source = createBlankEditablePresentationDocument('Adjust')
    source.schemaVersion = 3
    const slideId = source.slideOrder[0]
    const element = {
      ...createShapeElement('triangle', { width: 200, height: 100, rotation }),
      adjustments
    }
    return { element, slideId, document: addElementToSlide(source, slideId, element) }
  }

  it('projects a rotated, half-scale drag into one adjustment transaction', () => {
    mockSurfaceScale(0.5)
    const { element, slideId, document } = fixture()
    const start = vi.fn(() => element)
    const preview = vi.fn()
    const commit = vi.fn()
    render(
      <EditableSlideSurface
        document={document}
        slideId={slideId}
        editable
        selectedElementId={element.id}
        onTransformStart={start}
        onTransformPreview={preview}
        onTransformCommit={commit}
      />
    )
    const handle = screen.getByRole('button', { name: 'Adjust apex position' })
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 })
    for (let index = 1; index <= 25; index++) {
      fireEvent.pointerMove(handle, { clientX: 100, clientY: 100 + index, pointerId: 1 })
    }
    fireEvent.pointerUp(handle, { clientX: 100, clientY: 125, pointerId: 1 })
    expect(preview).toHaveBeenLastCalledWith(element.id, { adjustments: [75000] })
    expect(start).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it.each(['Escape', 'pointercancel'])('cancels an adjustment on %s', (reason) => {
    const { element, slideId, document } = fixture()
    const cancel = vi.fn()
    const commit = vi.fn()
    render(
      <EditableSlideSurface
        document={document}
        slideId={slideId}
        editable
        selectedElementId={element.id}
        onTransformStart={() => element}
        onTransformPreview={() => true}
        onTransformCancel={cancel}
        onTransformCommit={commit}
      />
    )
    const handle = screen.getByRole('button', { name: 'Adjust apex position' })
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 100, clientY: 125, pointerId: 1 })
    if (reason === 'Escape') fireEvent.keyDown(window.document.body, { key: 'Escape' })
    else fireEvent.pointerCancel(handle, { pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
  })

  it('cancels the original transaction when the document changes mid-drag', () => {
    const { element, slideId, document } = fixture()
    const originalCancel = vi.fn()
    const nextCancel = vi.fn()
    const commit = vi.fn()
    const { rerender } = render(
      <EditableSlideSurface
        document={document}
        slideId={slideId}
        editable
        selectedElementId={element.id}
        onTransformStart={() => element}
        onTransformPreview={() => true}
        onTransformCancel={originalCancel}
        onTransformCommit={commit}
      />
    )
    const handle = screen.getByRole('button', { name: 'Adjust apex position' })
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 100, clientY: 125, pointerId: 1 })
    rerender(
      <EditableSlideSurface
        document={{ ...document, id: 'another-document' }}
        slideId={slideId}
        editable
        selectedElementId={element.id}
        onTransformCancel={nextCancel}
        onTransformCommit={commit}
      />
    )
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Adjust apex position' }), {
      pointerId: 1
    })
    expect(originalCancel).toHaveBeenCalledTimes(1)
    expect(nextCancel).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('does not create an undo transaction when dragging past an existing clamp', () => {
    const { element, slideId, document } = fixture([100000], 0)
    const cancel = vi.fn()
    const commit = vi.fn()
    render(
      <EditableSlideSurface
        document={document}
        slideId={slideId}
        editable
        selectedElementId={element.id}
        onTransformStart={() => element}
        onTransformPreview={() => undefined}
        onTransformCancel={cancel}
        onTransformCommit={commit}
      />
    )
    const handle = screen.getByRole('button', { name: 'Adjust apex position' })
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 140, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(commit).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('supports keyboard adjustment with the existing transform callbacks', () => {
    const { element, slideId, document } = fixture()
    const preview = vi.fn()
    const commit = vi.fn()
    render(
      <EditableSlideSurface
        document={document}
        slideId={slideId}
        editable
        selectedElementId={element.id}
        onTransformStart={() => element}
        onTransformPreview={preview}
        onTransformCommit={commit}
      />
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'Adjust apex position' }), {
      key: 'ArrowRight'
    })
    expect(preview).toHaveBeenCalledWith(element.id, { adjustments: [51000] })
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it.each(['legacy', 'read-only', 'locked'])('hides adjustment controls for %s shapes', (mode) => {
    const { element, slideId, document } = fixture()
    if (mode === 'legacy') document.schemaVersion = 2
    if (mode === 'locked')
      document.slides[slideId].elements[element.id] = { ...element, locked: true }
    render(
      <EditableSlideSurface
        document={document}
        slideId={slideId}
        editable={mode !== 'read-only'}
        selectedElementId={element.id}
      />
    )
    expect(screen.queryByRole('button', { name: 'Adjust apex position' })).not.toBeInTheDocument()
  })

  it.each([undefined, [], [2147483647]] as const)(
    'keeps original omitted or clamped raw parameters on an unchanged drag: %s',
    (adjustments) => {
      const { element, slideId, document } = fixture()
      document.slides[slideId].elements[element.id] = { ...element, adjustments }
      const original = document.slides[slideId].elements[element.id]
      const commit = vi.fn()
      const cancel = vi.fn()
      render(
        <EditableSlideSurface
          document={document}
          slideId={slideId}
          editable
          selectedElementId={element.id}
          onTransformStart={() => original}
          onTransformCommit={commit}
          onTransformCancel={cancel}
        />
      )
      const handle = screen.getByRole('button', { name: 'Adjust apex position' })
      fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 })
      fireEvent.pointerMove(handle, { clientX: 100, clientY: 100, pointerId: 1 })
      fireEvent.pointerUp(handle, { pointerId: 1 })
      expect(commit).not.toHaveBeenCalled()
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(document.slides[slideId].elements[element.id]).toBe(original)
    }
  )
})

it.each([
  'rectangle',
  'ellipse',
  'roundRect',
  'triangle',
  'rtTriangle',
  'diamond',
  'rightArrow',
  'leftArrow',
  'upArrow',
  'downArrow'
] as const)('renders the Office default line join for v3 %s', (kind) => {
  const source = createBlankEditablePresentationDocument('Outline')
  source.schemaVersion = 3
  const element = createShapeElement(kind, { strokeWidth: 4 })
  const slideId = source.slideOrder[0]
  const { container } = render(
    <EditableSlideSurface
      document={addElementToSlide(source, slideId, element)}
      slideId={slideId}
    />
  )
  const path = container.querySelector('svg[data-shape-kind="' + kind + '"] path')
  expect(path).toHaveAttribute(
    'stroke-linejoin',
    ['rightArrow', 'upArrow', 'downArrow'].includes(kind) ? 'miter' : 'round'
  )
  expect(path).toHaveAttribute('stroke-miterlimit', '8')
})
