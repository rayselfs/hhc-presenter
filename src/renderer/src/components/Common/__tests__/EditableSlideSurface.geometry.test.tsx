import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import EditableSlideSurface from '../EditableSlideSurface'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createShapeElement,
  createTextElement,
  updateElementInSlide,
  type EditableImageElement
} from '@renderer/lib/editable-presentation'
import {
  getSlideSurface,
  mockElementRect,
  withinResizeHandle,
  withinResizeHandleVisual,
  expectScreenHitTarget,
  mockHandleCenterTie,
  mockSurfaceScale
} from '@renderer/test/editable-slide-surface-harness'

describe('EditableSlideSurface geometry contract', () => {
  it('does not start moving a text box from inside the text content area', () => {
    const onTransformStart = vi.fn()
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Click text', width: 220, height: 40, autoWidth: false })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSlideSurface
        document={withText}
        slideId={slideId}
        editable
        selectedElementId={text.id}
        onTransformStart={onTransformStart}
        onUpdateElement={handleUpdate}
      />
    )

    const textBox = screen.getByText('Click text')
    mockElementRect(textBox, { left: 0, top: 0, width: 220, height: 40 })
    fireEvent.pointerDown(textBox, { clientX: 110, clientY: 20, pointerId: 1 })
    fireEvent.pointerMove(textBox, { clientX: 24, clientY: 18, pointerId: 1 })

    expect(handleUpdate).not.toHaveBeenCalled()
    expect(onTransformStart).not.toHaveBeenCalled()
  })

  it('renders selected text move edges separate from the editable content', () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Move frame', autoWidth: false })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSlideSurface
        document={withText}
        slideId={slideId}
        editable
        selectedElementId={text.id}
      />
    )

    expect(screen.getByTestId('text-frame-edge-left')).toHaveClass('cursor-move')
    expect(screen.getByTestId('text-frame-edge-right')).toHaveClass('cursor-move')
    expect(screen.getByTestId('text-frame-edge-top')).toHaveClass('cursor-move')
    expect(screen.getByTestId('text-frame-edge-bottom')).toHaveClass('cursor-move')
    expect(screen.getByRole('textbox')).toHaveClass('cursor-text')
  })

  it('keeps touch gestures owned by resize handles and text frame move edges', () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Touch frame', autoWidth: false })

    render(
      <EditableSlideSurface
        document={addElementToSlide(document, slideId, text)}
        slideId={slideId}
        editable
        selectedElementId={text.id}
      />
    )

    for (const target of [
      ...screen.getAllByLabelText(/Resize text box/),
      ...(['top', 'right', 'bottom', 'left'] as const).map((edge) =>
        screen.getByTestId(`text-frame-edge-${edge}`)
      )
    ]) {
      expect(target).toHaveStyle({ touchAction: 'none' })
    }
  })

  it('moves a text box when dragging from its dedicated frame edge', () => {
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Move frame',
      x: 100,
      y: 80,
      width: 220,
      height: 40,
      autoWidth: false
    })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSlideSurface
        document={withText}
        slideId={slideId}
        editable
        selectedElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )

    const leftEdge = screen.getByTestId('text-frame-edge-left')
    fireEvent.pointerDown(leftEdge, { clientX: 102, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(leftEdge, { clientX: 122, clientY: 112, pointerId: 1 })

    expect(handleUpdate).toHaveBeenCalledWith(
      slideId,
      text.id,
      expect.objectContaining({
        x: 120,
        y: 92
      })
    )
  })

  it('groups pointer previews into one transform transaction', () => {
    const onTransformStart = vi.fn(() => text)
    const onTransformPreview = vi.fn()
    const onTransformCommit = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Move once',
      x: 100,
      y: 80,
      width: 220,
      height: 40,
      autoWidth: false
    })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSlideSurface
        document={withText}
        slideId={slideId}
        editable
        selectedElementId={text.id}
        onTransformStart={onTransformStart}
        onTransformPreview={onTransformPreview}
        onTransformCommit={onTransformCommit}
      />
    )

    const leftEdge = screen.getByTestId('text-frame-edge-left')
    fireEvent.pointerDown(leftEdge, { clientX: 102, clientY: 100, pointerId: 1 })
    for (let index = 1; index <= 100; index += 1) {
      fireEvent.pointerMove(leftEdge, {
        clientX: 102 + index,
        clientY: 100 + index,
        pointerId: 1
      })
    }
    fireEvent.pointerUp(leftEdge, { clientX: 202, clientY: 200, pointerId: 1 })

    expect(onTransformStart).toHaveBeenCalledTimes(1)
    expect(onTransformPreview).toHaveBeenCalledTimes(100)
    expect(onTransformCommit).toHaveBeenCalledTimes(1)
  })

  it('aborts a transform when the current element no longer exists', () => {
    const onTransformStart = vi.fn(() => undefined)
    const onTransformPreview = vi.fn()
    const onTransformCommit = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Gone', x: 100, y: 80, autoWidth: false })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSlideSurface
        document={withText}
        slideId={slideId}
        editable
        selectedElementId={text.id}
        onTransformStart={onTransformStart}
        onTransformPreview={onTransformPreview}
        onTransformCommit={onTransformCommit}
      />
    )

    const leftEdge = screen.getByTestId('text-frame-edge-left')
    fireEvent.pointerDown(leftEdge, { clientX: 102, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(leftEdge, { clientX: 126, clientY: 124, pointerId: 1 })
    fireEvent.pointerUp(leftEdge, { clientX: 126, clientY: 124, pointerId: 1 })

    expect(onTransformStart).toHaveBeenCalledWith(text.id)
    expect(onTransformPreview).not.toHaveBeenCalled()
    expect(onTransformCommit).not.toHaveBeenCalled()
  })

  it('cancels a pointer transform without committing it', () => {
    const onTransformCommit = vi.fn()
    const onTransformCancel = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Cancel move',
      x: 100,
      y: 80,
      width: 220,
      height: 40,
      autoWidth: false
    })
    const onTransformStart = vi.fn(() => text)
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSlideSurface
        document={withText}
        slideId={slideId}
        editable
        selectedElementId={text.id}
        onTransformStart={onTransformStart}
        onTransformCancel={onTransformCancel}
        onTransformCommit={onTransformCommit}
      />
    )

    const leftEdge = screen.getByTestId('text-frame-edge-left')
    fireEvent.pointerDown(leftEdge, { clientX: 102, clientY: 100, pointerId: 1 })
    fireEvent.pointerCancel(leftEdge, { pointerId: 1 })

    expect(onTransformStart).toHaveBeenCalledTimes(1)
    expect(onTransformCancel).toHaveBeenCalledTimes(1)
    expect(onTransformCommit).not.toHaveBeenCalled()
  })

  it('cancels an explicit resize gesture without committing it', () => {
    const onTransformPreview = vi.fn()
    const onTransformCommit = vi.fn()
    const onTransformCancel = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Cancel resize',
      x: 100,
      y: 80,
      width: 220,
      height: 40,
      autoWidth: false
    })

    render(
      <EditableSlideSurface
        document={addElementToSlide(document, slideId, text)}
        slideId={slideId}
        editable
        selectedElementId={text.id}
        onTransformStart={() => text}
        onTransformPreview={onTransformPreview}
        onTransformCancel={onTransformCancel}
        onTransformCommit={onTransformCommit}
      />
    )

    const handle = screen.getByLabelText('Resize text box right')
    fireEvent.pointerDown(handle, { clientX: 320, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 344, clientY: 100, pointerId: 1 })
    fireEvent.pointerCancel(handle, { pointerId: 1 })

    expect(onTransformPreview).toHaveBeenCalled()
    expect(onTransformCancel).toHaveBeenCalledTimes(1)
    expect(onTransformCommit).not.toHaveBeenCalled()
  })

  it('renders selected text boxes with clearly visible square resize handles', () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Resize me' })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSlideSurface
        document={withText}
        slideId={slideId}
        editable
        selectedElementId={text.id}
      />
    )

    expect(screen.getAllByLabelText(/Resize text box/)).toHaveLength(6)
    const topLeft = screen.getByLabelText('Resize text box top left')
    expect(topLeft).toHaveClass('cursor-ew-resize')
    expect(withinResizeHandleVisual(topLeft)).toHaveClass('bg-white')
    expect(screen.getByLabelText('Resize text box right')).toBeInTheDocument()
    expect(screen.queryByLabelText('Resize text box top')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Resize text box bottom')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Resize element')).not.toBeInTheDocument()
  })

  it('keeps content-height boxes horizontal-only at every width', () => {
    mockSurfaceScale(1)
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Resize me', width: 60, autoSize: 'content' })
    const narrow = addElementToSlide(document, slideId, text)
    const { rerender } = render(
      <EditableSlideSurface
        document={narrow}
        slideId={slideId}
        editable
        selectedElementId={text.id}
      />
    )

    expect(screen.queryByLabelText('Resize text box top')).not.toBeInTheDocument()
    const wide = updateElementInSlide(narrow, slideId, text.id, { width: 220 })
    rerender(
      <EditableSlideSurface
        document={wide}
        slideId={slideId}
        editable
        selectedElementId={text.id}
      />
    )

    expect(screen.queryByLabelText('Resize text box top')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Resize text box bottom')).not.toBeInTheDocument()
  })

  it('preserves manual height resizing for imported fixed frames', () => {
    mockSurfaceScale(1)
    const onTransformPreview = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Resize me',
      x: 100,
      y: 80,
      width: 220,
      height: 40,
      autoSize: 'fixed',
      autoWidth: false
    })

    render(
      <EditableSlideSurface
        document={addElementToSlide(document, slideId, text)}
        slideId={slideId}
        editable
        selectedElementId={text.id}
        onTransformStart={() => text}
        onTransformPreview={onTransformPreview}
      />
    )
    fireEvent.keyDown(screen.getByLabelText('Resize text box top'), {
      key: 'ArrowUp',
      shiftKey: true
    })

    expect(onTransformPreview).toHaveBeenCalledWith(
      text.id,
      expect.objectContaining({ y: 70, height: 50, autoSize: 'fixed' })
    )
  })

  it.each([0.25, 1, 2])(
    'keeps text resize targets at 24 screen px and visual knobs at 10 px at scale %s',
    (scale) => {
      mockSurfaceScale(scale)
      const document = createBlankEditablePresentationDocument('Sunday')
      const slideId = document.slideOrder[0]
      const text = createTextElement({ text: 'Resize me' })
      const withText = addElementToSlide(document, slideId, text)

      render(
        <EditableSlideSurface
          document={withText}
          slideId={slideId}
          editable
          selectedElementId={text.id}
        />
      )

      const handle = screen.getByLabelText('Resize text box top left')
      const indicator = withinResizeHandle(handle)
      const visual = withinResizeHandleVisual(handle)
      const leftEdge = screen.getByTestId('text-frame-edge-left')
      const frame = screen.getByRole('textbox').closest('[data-slide-element]')
      const chrome = screen
        .getByLabelText('Resize text box top left')
        .closest('[data-selection-chrome]')
      if (!(frame instanceof HTMLElement)) throw new Error('text frame not found')
      if (!(chrome instanceof HTMLElement)) throw new Error('selection chrome not found')
      expect(Number.parseFloat(handle.style.width) * scale).toBeGreaterThanOrEqual(24)
      expect(Number.parseFloat(handle.style.height) * scale).toBeGreaterThanOrEqual(24)
      expect(Number.parseFloat(indicator.style.width) * scale).toBe(4)
      expect(Number.parseFloat(indicator.style.height) * scale).toBe(4)
      expect(indicator).toHaveClass('pointer-events-auto')
      expect(Number.parseFloat(visual.style.width) * scale).toBe(10)
      expect(Number.parseFloat(visual.style.height) * scale).toBe(10)
      expect(Number.parseFloat(visual.style.borderWidth) * scale).toBe(1)
      expect(Number.parseFloat(leftEdge.style.width) * scale).toBe(6)
      expect(Number.parseFloat(chrome.style.outlineWidth) * scale).toBe(1)
    }
  )

  it('keeps selection chrome outside the clipped slide-content layer', () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ x: 0, y: 0, text: 'Corner' })
    const { container } = render(
      <EditableSlideSurface
        document={addElementToSlide(document, slideId, text)}
        slideId={slideId}
        editable
        selectedElementId={text.id}
      />
    )

    const content = container.querySelector('[data-slide-content]')
    const chrome = container.querySelector('[data-selection-chrome]')
    const handle = screen.getByLabelText('Resize text box top left')
    expect(content).toHaveClass('overflow-hidden')
    expect(chrome).not.toBeNull()
    expect(content).not.toContainElement(handle)
    expect(chrome).toContainElement(handle)
  })

  it('resolves overlapping text targets from visual knob centers in stable handle order', () => {
    const onTransformStart = vi.fn(() => text)
    const onTransformPreview = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      x: 100,
      y: 100,
      width: 60,
      height: 24,
      text: 'Small',
      autoSize: 'fixed',
      autoWidth: false
    })
    const { container } = render(
      <EditableSlideSurface
        document={addElementToSlide(document, slideId, text)}
        slideId={slideId}
        editable
        selectedElementId={text.id}
        onTransformStart={onTransformStart}
        onTransformPreview={onTransformPreview}
      />
    )
    const surface = getSlideSurface(container)
    const topLeft = screen.getByLabelText('Resize text box top left')
    const bottomRight = screen.getByLabelText('Resize text box bottom right')
    mockHandleCenterTie(surface, topLeft, bottomRight)

    const paintedIndicator = withinResizeHandle(bottomRight)
    fireEvent.pointerDown(paintedIndicator, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(paintedIndicator, { clientX: 95, clientY: 95, pointerId: 1 })

    expect(onTransformPreview).toHaveBeenLastCalledWith(
      text.id,
      expect.objectContaining({ x: 80, y: 80, width: 80, height: 44 })
    )
  })

  it('keeps six-handle text ties in the stable subset order', () => {
    const onTransformStart = vi.fn(() => text)
    const onTransformPreview = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      x: 100,
      y: 100,
      width: 60,
      height: 24,
      text: 'Small',
      autoSize: 'content',
      autoWidth: false
    })
    const { container } = render(
      <EditableSlideSurface
        document={addElementToSlide(document, slideId, text)}
        slideId={slideId}
        editable
        selectedElementId={text.id}
        onTransformStart={onTransformStart}
        onTransformPreview={onTransformPreview}
      />
    )
    const surface = getSlideSurface(container)
    const topLeft = screen.getByLabelText('Resize text box top left')
    const right = screen.getByLabelText('Resize text box right')
    mockHandleCenterTie(surface, topLeft, right)

    const paintedIndicator = withinResizeHandle(right)
    fireEvent.pointerDown(paintedIndicator, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(paintedIndicator, { clientX: 95, clientY: 95, pointerId: 1 })

    expect(onTransformPreview).toHaveBeenLastCalledWith(
      text.id,
      expect.objectContaining({ x: 80, width: 80 })
    )
  })

  it.each([0.25, 1, 2])(
    'keeps image, crop, and generic resize targets at least 24 screen px at scale %s',
    (scale) => {
      mockSurfaceScale(scale)
      const source = createBlankEditablePresentationDocument('Sunday')
      const slideId = source.slideOrder[0]
      const image: EditableImageElement = {
        id: 'image-1',
        type: 'image',
        assetId: 'asset-1',
        x: 100,
        y: 100,
        width: 320,
        height: 180,
        rotation: 0,
        opacity: 1
      }
      const withImage = addElementToSlide(
        {
          ...source,
          assets: {
            'asset-1': {
              id: 'asset-1',
              name: 'photo.png',
              mimeType: 'image/png',
              dataUrl: 'data:image/png;base64,AAA='
            }
          }
        },
        slideId,
        image
      )
      const imageView = render(
        <EditableSlideSurface
          document={withImage}
          slideId={slideId}
          editable
          selectedElementId={image.id}
        />
      )
      const resizeHandle = screen.getByLabelText('Resize image right')
      expectScreenHitTarget(resizeHandle, scale)
      expect(resizeHandle).toHaveStyle({ touchAction: 'none' })
      imageView.rerender(
        <EditableSlideSurface
          document={withImage}
          slideId={slideId}
          editable
          selectedElementId={image.id}
          cropElementId={image.id}
        />
      )
      const cropHandle = screen.getByLabelText('Crop image right')
      expectScreenHitTarget(cropHandle, scale)
      expect(cropHandle).toHaveStyle({ touchAction: 'none' })
      imageView.unmount()

      const shape = createShapeElement('rectangle')
      render(
        <EditableSlideSurface
          document={addElementToSlide(source, slideId, shape)}
          slideId={slideId}
          editable
          selectedElementId={shape.id}
        />
      )
      const genericHandle = screen.getByLabelText('Resize element')
      expectScreenHitTarget(genericHandle, scale)
      expect(genericHandle).toHaveStyle({ touchAction: 'none' })
    }
  )

  it.each([0.25, 1, 2])(
    'keeps text targets outside the frame and visual handles on its boundary at scale %s',
    (scale) => {
      mockSurfaceScale(scale)
      const document = createBlankEditablePresentationDocument('Sunday')
      const slideId = document.slideOrder[0]
      const text = createTextElement({ text: 'Resize me', autoSize: 'fixed', autoWidth: false })
      const withText = addElementToSlide(document, slideId, text)

      render(
        <EditableSlideSurface
          document={withText}
          slideId={slideId}
          editable
          selectedElementId={text.id}
        />
      )

      const targetOffset = `${-25 / scale}px`
      const indicatorOffset = `${-2 / scale}px`
      const edgeOffset = `${-6 / scale}px`
      const expected = {
        'top left': {
          target: { top: targetOffset, left: targetOffset, transform: '' },
          indicator: { right: indicatorOffset, bottom: indicatorOffset, transform: '' }
        },
        top: {
          target: { top: targetOffset, left: '50%', transform: 'translateX(-50%)' },
          indicator: { left: '50%', bottom: indicatorOffset, transform: 'translateX(-50%)' }
        },
        'top right': {
          target: { top: targetOffset, right: targetOffset, transform: '' },
          indicator: { left: indicatorOffset, bottom: indicatorOffset, transform: '' }
        },
        right: {
          target: { top: '50%', right: targetOffset, transform: 'translateY(-50%)' },
          indicator: { top: '50%', left: indicatorOffset, transform: 'translateY(-50%)' }
        },
        'bottom right': {
          target: { right: targetOffset, bottom: targetOffset, transform: '' },
          indicator: { top: indicatorOffset, left: indicatorOffset, transform: '' }
        },
        bottom: {
          target: { bottom: targetOffset, left: '50%', transform: 'translateX(-50%)' },
          indicator: { top: indicatorOffset, left: '50%', transform: 'translateX(-50%)' }
        },
        'bottom left': {
          target: { bottom: targetOffset, left: targetOffset, transform: '' },
          indicator: { top: indicatorOffset, right: indicatorOffset, transform: '' }
        },
        left: {
          target: { top: '50%', left: targetOffset, transform: 'translateY(-50%)' },
          indicator: { top: '50%', right: indicatorOffset, transform: 'translateY(-50%)' }
        }
      }
      expect(screen.getAllByLabelText(/Resize text box/)).toHaveLength(8)
      for (const [label, styles] of Object.entries(expected)) {
        const target = screen.getByLabelText(`Resize text box ${label}`)
        expect(target).toHaveStyle(styles.target)
        expect(withinResizeHandle(target)).toHaveStyle(styles.indicator)
      }
      expect(screen.getByTestId('text-frame-edge-top')).toHaveStyle({ top: edgeOffset })
      expect(screen.getByTestId('text-frame-edge-right')).toHaveStyle({ right: edgeOffset })
      expect(screen.getByTestId('text-frame-edge-bottom')).toHaveStyle({ bottom: edgeOffset })
      expect(screen.getByTestId('text-frame-edge-left')).toHaveStyle({ left: edgeOffset })
    }
  )

  it.each([0, Number.POSITIVE_INFINITY])(
    'keeps selection geometry finite for document width %s',
    (width) => {
      mockSurfaceScale(1)
      const document = createBlankEditablePresentationDocument('Sunday')
      document.width = width
      const slideId = document.slideOrder[0]
      const text = createTextElement({ text: 'Resize me' })
      const withText = addElementToSlide(document, slideId, text)

      render(
        <EditableSlideSurface
          document={withText}
          slideId={slideId}
          editable
          selectedElementId={text.id}
        />
      )

      const handle = screen.getByLabelText('Resize text box top left')
      const edge = screen.getByTestId('text-frame-edge-left')
      const visual = withinResizeHandleVisual(handle)
      for (const value of [handle.style.width, visual.style.borderWidth, edge.style.width]) {
        expect(Number.parseFloat(value)).toBeGreaterThan(0)
        expect(Number.isFinite(Number.parseFloat(value))).toBe(true)
      }
    }
  )

  it('resizes content-height text box width without changing its height', () => {
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Resize me',
      width: 220,
      height: 40,
      autoSize: 'content',
      autoWidth: false
    })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSlideSurface
        document={withText}
        slideId={slideId}
        editable
        selectedElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )

    const rightHandle = screen.getByLabelText('Resize text box right')
    mockElementRect(rightHandle, { left: 0, top: 0, width: 25, height: 25 })
    fireEvent.pointerDown(rightHandle, { clientX: 12.5, clientY: 12.5, pointerId: 1 })
    fireEvent.pointerMove(rightHandle, { clientX: 36.5, clientY: 36.5, pointerId: 1 })

    expect(handleUpdate).toHaveBeenCalledWith(
      slideId,
      text.id,
      expect.objectContaining({
        width: 244,
        autoWidth: false,
        autoSize: 'content'
      })
    )
    const updates = handleUpdate.mock.calls[0]?.[2]
    expect(updates).not.toHaveProperty('height')
    expect(updates).not.toHaveProperty('y')
  })

  it('resizes fixed text frames by handle direction in one transaction per arrow key', () => {
    const onTransformStart = vi.fn(() => text)
    const onTransformPreview = vi.fn()
    const onTransformCommit = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Keyboard resize',
      x: 100,
      y: 80,
      width: 220,
      height: 40,
      autoSize: 'fixed',
      autoWidth: false
    })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSlideSurface
        document={withText}
        slideId={slideId}
        editable
        selectedElementId={text.id}
        onTransformStart={onTransformStart}
        onTransformPreview={onTransformPreview}
        onTransformCommit={onTransformCommit}
      />
    )

    fireEvent.keyDown(screen.getByLabelText('Resize text box right'), { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getByLabelText('Resize text box left'), { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getByLabelText('Resize text box top'), {
      key: 'ArrowUp',
      shiftKey: true
    })

    expect(onTransformStart).toHaveBeenCalledTimes(3)
    expect(onTransformPreview.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ width: 221 }),
      expect.objectContaining({ x: 101, width: 219 }),
      expect.objectContaining({ y: 70, height: 50 })
    ])
    expect(onTransformCommit).toHaveBeenCalledTimes(3)
  })

  it('cancels keyboard and pointer resize transactions clamped at the fixed text minimum', () => {
    const onTransformStart = vi.fn(() => text)
    const onTransformPreview = vi.fn(() => false)
    const onTransformCommit = vi.fn()
    const onTransformCancel = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Minimum frame',
      x: 100,
      y: 80,
      width: 60,
      height: 24,
      autoSize: 'fixed',
      autoWidth: false
    })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSlideSurface
        document={withText}
        slideId={slideId}
        editable
        selectedElementId={text.id}
        onTransformStart={onTransformStart}
        onTransformPreview={onTransformPreview}
        onTransformCommit={onTransformCommit}
        onTransformCancel={onTransformCancel}
      />
    )

    const leftHandle = screen.getByLabelText('Resize text box left')
    const keyboardEvent = createEvent.keyDown(leftHandle, { key: 'ArrowRight' })
    fireEvent(leftHandle, keyboardEvent)
    fireEvent.pointerDown(leftHandle, { clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(leftHandle, { clientX: 24, clientY: 0, pointerId: 1 })
    fireEvent.pointerUp(leftHandle, { clientX: 24, clientY: 0, pointerId: 1 })

    expect(keyboardEvent.defaultPrevented).toBe(true)
    expect(onTransformStart).toHaveBeenCalledTimes(2)
    expect(onTransformPreview).toHaveBeenCalledTimes(2)
    expect(onTransformCommit).not.toHaveBeenCalled()
    expect(onTransformCancel).toHaveBeenCalledTimes(2)
  })

  it('cancels a generic resize transaction clamped at the minimum size', () => {
    const onTransformStart = vi.fn(() => shape)
    const onTransformPreview = vi.fn(() => false)
    const onTransformCommit = vi.fn()
    const onTransformCancel = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const shape = createShapeElement('rectangle', { width: 20, height: 20 })

    render(
      <EditableSlideSurface
        document={addElementToSlide(document, slideId, shape)}
        slideId={slideId}
        editable
        selectedElementId={shape.id}
        onTransformStart={onTransformStart}
        onTransformPreview={onTransformPreview}
        onTransformCommit={onTransformCommit}
        onTransformCancel={onTransformCancel}
      />
    )

    const handle = screen.getByLabelText('Resize element')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })

    expect(onTransformPreview).toHaveBeenCalledTimes(1)
    expect(onTransformCommit).not.toHaveBeenCalled()
    expect(onTransformCancel).toHaveBeenCalledTimes(1)
  })

  it('keeps content-height keyboard resize horizontal-only', () => {
    const onTransformStart = vi.fn(() => text)
    const onTransformPreview = vi.fn()
    const onTransformCommit = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Content height',
      width: 220,
      height: 40,
      autoSize: 'content',
      autoWidth: false
    })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSlideSurface
        document={withText}
        slideId={slideId}
        editable
        selectedElementId={text.id}
        onTransformStart={onTransformStart}
        onTransformPreview={onTransformPreview}
        onTransformCommit={onTransformCommit}
      />
    )

    const handle = screen.getByLabelText('Resize text box top right')
    const vertical = createEvent.keyDown(handle, { key: 'ArrowUp' })
    fireEvent(handle, vertical)
    expect(vertical.defaultPrevented).toBe(false)
    expect(onTransformPreview).not.toHaveBeenCalled()

    const horizontal = createEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    fireEvent(handle, horizontal)
    expect(horizontal.defaultPrevented).toBe(true)
    expect(onTransformPreview).toHaveBeenCalledWith(
      text.id,
      expect.objectContaining({ width: 230, autoSize: 'content', autoWidth: false })
    )
    expect(onTransformPreview.mock.calls[0]?.[1]).not.toHaveProperty('height')
    expect(onTransformCommit).toHaveBeenCalledTimes(1)
  })

  it('applies arrow geometry to image resize, crop, and generic handles', () => {
    const handleUpdate = vi.fn()
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const image: EditableImageElement = {
      id: 'image-1',
      type: 'image',
      assetId: 'asset-1',
      x: 100,
      y: 100,
      width: 320,
      height: 180,
      rotation: 0,
      opacity: 1
    }
    const withImage = addElementToSlide(
      {
        ...source,
        assets: {
          'asset-1': {
            id: 'asset-1',
            name: 'photo.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,AAA='
          }
        }
      },
      slideId,
      image
    )
    const view = render(
      <EditableSlideSurface
        document={withImage}
        slideId={slideId}
        editable
        selectedElementId={image.id}
        onUpdateElement={handleUpdate}
      />
    )

    fireEvent.keyDown(screen.getByLabelText('Resize image right'), { key: 'ArrowRight' })
    expect(handleUpdate).toHaveBeenLastCalledWith(
      slideId,
      image.id,
      expect.objectContaining({ width: 321, height: 180 })
    )

    handleUpdate.mockClear()
    view.rerender(
      <EditableSlideSurface
        document={withImage}
        slideId={slideId}
        editable
        selectedElementId={image.id}
        cropElementId={image.id}
        onUpdateElement={handleUpdate}
      />
    )
    fireEvent.keyDown(screen.getByLabelText('Crop image left'), {
      key: 'ArrowRight',
      shiftKey: true
    })
    expect(handleUpdate).toHaveBeenLastCalledWith(
      slideId,
      image.id,
      expect.objectContaining({ crop: expect.objectContaining({ left: 3.125 }) })
    )
    view.unmount()

    handleUpdate.mockClear()
    const shape = createShapeElement('rectangle', { height: 220 })
    render(
      <EditableSlideSurface
        document={addElementToSlide(source, slideId, shape)}
        slideId={slideId}
        editable
        selectedElementId={shape.id}
        onUpdateElement={handleUpdate}
      />
    )
    fireEvent.keyDown(screen.getByLabelText('Resize element'), {
      key: 'ArrowDown',
      shiftKey: true
    })
    expect(handleUpdate).toHaveBeenLastCalledWith(
      slideId,
      shape.id,
      expect.objectContaining({ width: shape.width, height: 230 })
    )
  })

  it('renders eight resize handles for imported fixed text frames', () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Imported frame',
      width: 220,
      height: 40,
      autoSize: 'fixed',
      autoWidth: false
    })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSlideSurface
        document={withText}
        slideId={slideId}
        editable
        selectedElementId={text.id}
      />
    )

    expect(screen.getAllByLabelText(/Resize text box/)).toHaveLength(8)
    expect(screen.getByLabelText('Resize text box top')).toBeInTheDocument()
    expect(screen.getByLabelText('Resize text box bottom')).toBeInTheDocument()
  })

  it.each([true, false])(
    'keeps imported fixed text frames inset-free in %s shared-surface mode',
    (editable) => {
      const document = createBlankEditablePresentationDocument('Sunday')
      const slideId = document.slideOrder[0]
      const text = createTextElement({
        text: 'Imported frame',
        width: 220,
        height: 40,
        autoSize: 'fixed',
        autoWidth: false,
        runs: [
          {
            text: 'Imported ',
            fontFamily: 'Arial',
            fontSize: 24,
            bold: true,
            italic: false,
            underline: false,
            color: '#ff0000'
          },
          {
            text: 'frame',
            fontFamily: 'Arial',
            fontSize: 24,
            bold: false,
            italic: false,
            underline: false,
            color: '#0000ff'
          }
        ]
      })
      const withText = addElementToSlide(document, slideId, text)

      render(<EditableSlideSurface document={withText} slideId={slideId} editable={editable} />)

      const textContent = screen.getByRole('textbox')
      const frame = textContent.closest('[data-slide-element]')
      expect(textContent.style.padding).toBe('')
      expect(textContent.style.boxSizing).toBe('')
      expect(textContent).toHaveTextContent('Imported frame')
      expect(frame).toHaveStyle({ width: '220px', height: '40px' })
    }
  )

  it('renders selected images with native-like resize handles and applied effects', () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const image: EditableImageElement = {
      id: 'image-1',
      type: 'image',
      assetId: 'asset-1',
      x: 100,
      y: 100,
      width: 320,
      height: 180,
      rotation: 0,
      opacity: 0.5,
      borderColor: '#ff0000',
      borderWidth: 6,
      shadow: 'soft'
    }
    const withImage = addElementToSlide(
      {
        ...document,
        assets: {
          'asset-1': {
            id: 'asset-1',
            name: 'photo.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,AAA='
          }
        }
      },
      slideId,
      image
    )

    render(
      <EditableSlideSurface
        document={withImage}
        slideId={slideId}
        editable
        selectedElementId={image.id}
      />
    )

    expect(screen.getAllByLabelText(/Resize image/)).toHaveLength(8)
    const imageFrame = screen.getByAltText('photo.png').parentElement
    expect(imageFrame?.style.borderWidth).toBe('6px')
    expect(imageFrame?.style.borderStyle).toBe('solid')
    expect(imageFrame?.style.borderColor).toBe('rgb(255, 0, 0)')
  })

  it('updates image crop percentages from crop handles', () => {
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const image: EditableImageElement = {
      id: 'image-1',
      type: 'image',
      assetId: 'asset-1',
      x: 100,
      y: 100,
      width: 320,
      height: 180,
      rotation: 0,
      opacity: 1
    }
    const withImage = addElementToSlide(
      {
        ...document,
        assets: {
          'asset-1': {
            id: 'asset-1',
            name: 'photo.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,AAA='
          }
        }
      },
      slideId,
      image
    )

    render(
      <EditableSlideSurface
        document={withImage}
        slideId={slideId}
        editable
        selectedElementId={image.id}
        cropElementId={image.id}
        onUpdateElement={handleUpdate}
      />
    )

    const handle = screen.getByLabelText('Crop image left')
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 32, clientY: 0, pointerId: 1 })

    expect(handleUpdate).toHaveBeenCalledWith(
      slideId,
      image.id,
      expect.objectContaining({
        crop: expect.objectContaining({ left: 10 })
      })
    )
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
