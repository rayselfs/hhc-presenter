import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { useState } from 'react'
import type { ComponentProps, JSX } from 'react'
import EditableSlideSurface from '../EditableSlideSurface'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createShapeElement,
  createTextElement,
  updateElementInSlide,
  type EditablePresentationDocument,
  type EditableImageElement
} from '@renderer/lib/editable-presentation'
import { normalizeTextParagraphs, resolveTypingStyle } from '@renderer/lib/presentation-rich-text'

describe('EditableSlideSurface', () => {
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

  it('enters text editing from a single pointer down inside the text box', () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Edit me' })
    const withText = addElementToSlide(document, slideId, text)

    render(<EditableSurfaceHarness document={withText} slideId={slideId} />)

    let textBox = screen.getByText('Edit me')
    expect(textBox).not.toHaveAttribute('contenteditable', 'true')

    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = screen.getByRole('textbox')

    expect(textBox).toHaveAttribute('contenteditable', 'true')
  })

  it('grows auto-sized text boxes to measured content while typing', () => {
    mockTextMeasurement()
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Hi', width: 80, height: 30, autoWidth: true })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSurfaceHarness
        document={withText}
        slideId={slideId}
        selectedElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )

    handleUpdate.mockClear()
    let textBox = screen.getByText('Hi')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = screen.getByRole('textbox')
    textBox.textContent = 'Longer title'
    fireEvent.input(textBox)
    act(() => flushAnimationFrame())

    expect(textBox).toHaveStyle({
      boxSizing: 'border-box',
      padding: '4px 8px'
    })

    expect(handleUpdate).toHaveBeenCalledWith(
      slideId,
      text.id,
      expect.objectContaining({
        text: 'Longer title',
        width: 160,
        height: 82
      })
    )
  })

  it('keeps fixed-width content-height text wrapping while typing', () => {
    mockTextMeasurement()
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: '',
      width: 120,
      height: 30,
      autoSize: 'content',
      autoWidth: false
    })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSurfaceHarness
        document={withText}
        slideId={slideId}
        selectedElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )

    handleUpdate.mockClear()
    let textBox = screen.getByRole('textbox')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = screen.getByRole('textbox')
    textBox.textContent = 'LongEnglishTokenThatWraps'
    fireEvent.input(textBox)
    act(() => flushAnimationFrame())

    const updates = handleUpdate.mock.calls.at(-1)?.[2]
    expect(updates).toMatchObject({ text: 'LongEnglishTokenThatWraps', height: 230 })
    expect(updates).not.toHaveProperty('width')
  })

  it('defers East Asian composition commits until the scheduled frame reads the current text', () => {
    mockTextMeasurement()
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: '', width: 80, height: 30, autoWidth: true })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSurfaceHarness
        document={withText}
        slideId={slideId}
        selectedElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )

    handleUpdate.mockClear()
    let textBox = screen.getByRole('textbox')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = screen.getByRole('textbox')
    fireEvent.compositionStart(textBox)
    textBox.textContent = 'ㄓ'
    fireEvent.input(textBox)

    expect(handleUpdate).not.toHaveBeenCalled()

    textBox.textContent = '中'
    fireEvent.compositionEnd(textBox)

    expect(handleUpdate).not.toHaveBeenCalled()

    act(() => flushAnimationFrame())

    expect(handleUpdate).toHaveBeenCalledWith(
      slideId,
      text.id,
      expect.objectContaining({
        text: '中'
      })
    )
  })

  it('cancels a pending input commit when East Asian composition starts', () => {
    mockTextMeasurement()
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: '', width: 80, height: 30, autoWidth: true })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSurfaceHarness
        document={withText}
        slideId={slideId}
        selectedElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )

    handleUpdate.mockClear()
    let textBox = screen.getByRole('textbox')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = screen.getByRole('textbox')
    textBox.textContent = 'provisional'
    fireEvent.input(textBox)
    fireEvent.compositionStart(textBox)
    textBox.textContent = 'ㄓ'

    act(() => flushAnimationFrame())

    expect(handleUpdate).not.toHaveBeenCalled()

    textBox.textContent = '中'
    fireEvent.compositionEnd(textBox)
    expect(handleUpdate).not.toHaveBeenCalled()

    act(() => flushAnimationFrame())

    expect(handleUpdate).toHaveBeenCalledWith(
      slideId,
      text.id,
      expect.objectContaining({ text: '中' })
    )
  })

  it('keeps focus and editing active while text commits update the document', () => {
    mockTextMeasurement()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: '', width: 80, height: 30, autoWidth: true })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <>
        <button type="button">Confirm target</button>
        <StatefulEditableSurfaceHarness document={withText} slideId={slideId} />
      </>
    )

    let textBox = screen.getByRole('textbox')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = screen.getByRole('textbox')

    expect(textBox).toHaveAttribute('contenteditable', 'true')
    expect(globalThis.document.activeElement).toBe(textBox)

    textBox.textContent = '中'
    fireEvent.input(textBox)

    expect(textBox).toHaveAttribute('contenteditable', 'true')
    expect(globalThis.document.activeElement).toBe(textBox)

    textBox.textContent = '中文'
    fireEvent.input(textBox)

    expect(textBox).toHaveAttribute('contenteditable', 'true')
    expect(globalThis.document.activeElement).toBe(textBox)
    expect(textBox).toHaveTextContent('中文')
  })

  it('can edit the same text box again after blur confirms the edit', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'First', width: 220, height: 40, autoWidth: false })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <>
        <button type="button">Confirm target</button>
        <StatefulEditableSurfaceHarness document={withText} slideId={slideId} />
      </>
    )

    let textBox = screen.getByRole('textbox')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = screen.getByRole('textbox')
    expect(textBox).toHaveAttribute('contenteditable', 'true')

    textBox.textContent = 'Confirmed'
    fireEvent.input(textBox)
    act(() => {
      screen.getByRole('button', { name: 'Confirm target' }).focus()
      fireEvent.blur(textBox)
    })

    expect(screen.getByRole('textbox')).not.toHaveAttribute('contenteditable', 'true')
    fireEvent.pointerDown(screen.getByText('Confirmed'), { clientX: 40, clientY: 20, pointerId: 2 })

    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'true')
  })

  it('does not write pending blur text from passive editor unmount', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'First', width: 220, height: 40, autoWidth: false })
    const withText = addElementToSlide(document, slideId, text)
    const { unmount } = render(
      <EditableSurfaceHarness
        document={withText}
        slideId={slideId}
        selectedElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )

    let textBox = screen.getByRole('textbox')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = screen.getByRole('textbox')
    textBox.textContent = 'Final text'
    globalThis.document.body.focus()
    fireEvent.blur(textBox)

    unmount()
    act(() => flushAnimationFrame())

    expect(handleUpdate).not.toHaveBeenCalled()
  })

  it('defers a composing blur finalization until compositionend and keeps auto-size geometry', () => {
    mockTextMeasurement()
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    let finalize: () => boolean = () => true
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'First',
      width: 80,
      height: 30,
      autoSize: 'content',
      autoWidth: true
    })
    const withText = addElementToSlide(document, slideId, text)
    render(
      <>
        <button type="button">Finish composition</button>
        <EditableSlideSurface
          document={withText}
          slideId={slideId}
          editable
          selectedElementId={text.id}
          editingElementId={text.id}
          onUpdateElement={handleUpdate}
          onTextEditFinalizerChange={(next) => {
            if (next) finalize = next
          }}
        />
      </>
    )

    const textBox = screen.getByRole('textbox')
    fireEvent.compositionStart(textBox)
    textBox.textContent = 'Final title'
    screen.getByRole('button', { name: 'Finish composition' }).focus()
    fireEvent.blur(textBox)
    act(() => flushAnimationFrame())

    expect(finalize()).toBe(false)
    expect(handleUpdate).not.toHaveBeenCalled()

    fireEvent.compositionEnd(textBox)
    act(() => flushAnimationFrame())

    expect(handleUpdate).toHaveBeenCalledTimes(1)
    expect(handleUpdate).toHaveBeenCalledWith(
      slideId,
      text.id,
      expect.objectContaining({ text: 'Final title', width: 148, height: 82 })
    )
  })

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

  it('keeps manually-sized text boxes at fixed width and height while typing', () => {
    mockTextMeasurement()
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Hi', width: 80, height: 30, autoWidth: false })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSurfaceHarness
        document={withText}
        slideId={slideId}
        selectedElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )

    handleUpdate.mockClear()
    let textBox = screen.getByText('Hi')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = screen.getByRole('textbox')
    textBox.textContent = 'Longer title'
    fireEvent.input(textBox)
    act(() => flushAnimationFrame())

    expect(handleUpdate).toHaveBeenCalledWith(
      slideId,
      text.id,
      expect.objectContaining({
        text: 'Longer title'
      })
    )
    const updates = handleUpdate.mock.calls[0]?.[2]
    expect(updates).not.toHaveProperty('width')
    expect(updates).not.toHaveProperty('height')
  })

  it('renders imported text runs and keeps normalized rich text after editing', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Bold plain', autoSize: 'fixed' })
    Object.assign(text, {
      runs: [
        {
          text: 'Bold',
          fontFamily: 'Arial',
          fontSize: 40,
          bold: true,
          italic: false,
          underline: false,
          color: '#ff0000'
        },
        {
          text: ' plain',
          fontFamily: 'Arial',
          fontSize: 24,
          bold: false,
          italic: true,
          underline: false,
          color: '#0000ff'
        }
      ]
    })
    const withText = addElementToSlide(document, slideId, text)

    render(
      <EditableSurfaceHarness
        document={withText}
        slideId={slideId}
        onUpdateElement={handleUpdate}
      />
    )

    expect(screen.getByText('Bold')).toHaveStyle({
      fontSize: '40px',
      fontWeight: '700',
      color: '#ff0000'
    })
    let textBox = screen.getByRole('textbox')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = screen.getByRole('textbox')
    textBox.textContent = 'Edited'
    fireEvent.input(textBox)
    act(() => flushAnimationFrame())

    expect(handleUpdate).toHaveBeenCalledWith(
      slideId,
      text.id,
      expect.objectContaining({
        text: 'Edited',
        paragraphs: [
          expect.objectContaining({
            runs: [expect.objectContaining({ text: 'Edited', fontFamily: 'Arial' })]
          })
        ]
      })
    )
  })

  it('updates one imported run without flattening adjacent run styles', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Bold plain',
      autoSize: 'fixed',
      runs: [
        { ...createTextElement({ fontFamily: 'Arial', bold: true }), text: 'Bold' },
        { ...createTextElement({ fontFamily: 'Calibri', italic: true }), text: ' plain' }
      ]
    })
    const withText = addElementToSlide(document, slideId, text)
    render(
      <EditableSurfaceHarness
        document={withText}
        slideId={slideId}
        onUpdateElement={handleUpdate}
      />
    )

    fireEvent.pointerDown(screen.getByRole('textbox'), { clientX: 40, clientY: 20, pointerId: 1 })
    screen.getByText('Bold').textContent = 'Bolder'
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())

    expect(handleUpdate).toHaveBeenCalledWith(
      slideId,
      text.id,
      expect.objectContaining({
        text: 'Bolder plain',
        paragraphs: [
          expect.objectContaining({
            runs: [
              expect.objectContaining({ text: 'Bolder', fontFamily: 'Arial', bold: true }),
              expect.objectContaining({ text: ' plain', fontFamily: 'Calibri', italic: true })
            ]
          })
        ]
      })
    )
  })

  it('coalesces a burst of rich-text input into one frame update', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Start', autoSize: 'fixed' })

    render(
      <EditableSlideSurface
        document={addElementToSlide(document, slideId, text)}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )
    const textbox = screen.getByRole('textbox')
    for (const value of ['O', 'On', 'One']) {
      textbox.textContent = value
      fireEvent.input(textbox)
    }
    expect(handleUpdate).not.toHaveBeenCalled()
    act(() => flushAnimationFrame())

    expect(handleUpdate).toHaveBeenCalledTimes(1)
    expect(handleUpdate).toHaveBeenCalledWith(
      slideId,
      text.id,
      expect.objectContaining({ text: 'One' })
    )
  })

  it('preserves unannotated text inserted beside a formatted run', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const text = createTextElement({
      text: 'Hello',
      autoSize: 'fixed',
      runs: [{ ...createTextElement({ fontFamily: 'Arial' }), text: 'Hello' }]
    })

    render(
      <EditableSlideSurface
        document={addElementToSlide(source, slideId, text)}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )
    const paragraph = document.querySelector<HTMLElement>('[data-text-paragraph]')!
    paragraph.append(' pasted')
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())

    expect(handleUpdate).toHaveBeenCalledWith(
      slideId,
      text.id,
      expect.objectContaining({ text: 'Hello pasted' })
    )
  })

  it('preserves a Shift+Enter soft line break inside a formatted run', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const original = createTextElement({ text: 'HelloWorld', bold: true, autoSize: 'fixed' })
    const text = { ...original, paragraphs: normalizeTextParagraphs(original) }

    render(
      <EditableSlideSurface
        document={addElementToSlide(source, slideId, text)}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )
    document.querySelector<HTMLElement>('[data-text-run="0"]')!.innerHTML = 'Hello<br>World'
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())

    expect(handleUpdate).toHaveBeenCalledWith(
      slideId,
      text.id,
      expect.objectContaining({
        text: 'Hello\nWorld',
        paragraphs: [
          expect.objectContaining({
            runs: [expect.objectContaining({ text: 'Hello\nWorld', bold: true })]
          })
        ]
      })
    )
  })

  it('ignores the caret placeholder after a soft line break at the end of a run', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const original = createTextElement({ text: 'Hello', bold: true, autoSize: 'fixed' })
    const text = { ...original, paragraphs: normalizeTextParagraphs(original) }

    render(
      <EditableSlideSurface
        document={addElementToSlide(source, slideId, text)}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )
    document.querySelector<HTMLElement>('[data-text-run="0"]')!.innerHTML = 'Hello<br><br>'
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())

    expect(handleUpdate.mock.calls.at(-1)?.[2].text).toBe('Hello\n')
  })

  it('does not serialize an empty paragraph placeholder break as content', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const original = createTextElement({ text: 'First\n\nThird', autoSize: 'fixed' })
    const text = { ...original, paragraphs: normalizeTextParagraphs(original) }

    render(
      <EditableSlideSurface
        document={addElementToSlide(source, slideId, text)}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )
    screen.getByText('First').textContent = 'First!'
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())

    const update = handleUpdate.mock.calls.at(-1)?.[2]
    expect(update.text).toBe('First!\n\nThird')
    expect(update.paragraphs?.[1].runs).toEqual([])
  })

  it('inherits the preceding paragraph style when Enter inserts a paragraph', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const first = normalizeTextParagraphs(
      createTextElement({ text: 'First', italic: true, autoSize: 'fixed' })
    )[0]
    const second = normalizeTextParagraphs(
      createTextElement({ text: 'Second', bold: true, autoSize: 'fixed' })
    )[0]
    const text = {
      ...createTextElement({ text: 'First\nSecond', autoSize: 'fixed' }),
      paragraphs: [first, second]
    }

    render(
      <EditableSlideSurface
        document={addElementToSlide(source, slideId, text)}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )
    const firstParagraph = document.querySelector<HTMLElement>('[data-text-paragraph="0"]')!
    const insertedParagraph = document.createElement('div')
    insertedParagraph.textContent = 'New'
    firstParagraph.after(insertedParagraph)
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())

    const paragraphs = handleUpdate.mock.calls.at(-1)?.[2].paragraphs
    expect(paragraphs?.[1].runs[0]).toMatchObject({ text: 'New', italic: true, bold: false })
    expect(paragraphs?.[2].runs[0]).toMatchObject({ text: 'Second', bold: true })
  })

  it('keeps the source paragraph style when an earlier paragraph is removed', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const first = normalizeTextParagraphs(
      createTextElement({ text: 'First', italic: true, autoSize: 'fixed' })
    )[0]
    const second = normalizeTextParagraphs(
      createTextElement({ text: 'Second', bold: true, autoSize: 'fixed' })
    )[0]
    const text = {
      ...createTextElement({ text: 'First\nSecond', autoSize: 'fixed' }),
      paragraphs: [first, second]
    }

    render(
      <EditableSlideSurface
        document={addElementToSlide(source, slideId, text)}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )
    document.querySelector<HTMLElement>('[data-text-paragraph="0"]')!.remove()
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())

    expect(handleUpdate.mock.calls.at(-1)?.[2].paragraphs).toEqual([
      expect.objectContaining({
        runs: [expect.objectContaining({ text: 'Second', bold: true, italic: false })]
      })
    ])
  })

  it('preserves run styles when Backspace merges two paragraphs', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const first = normalizeTextParagraphs(
      createTextElement({ text: 'First', italic: true, autoSize: 'fixed' })
    )[0]
    const second = normalizeTextParagraphs(
      createTextElement({ text: 'Second', bold: true, color: '#ef4444', autoSize: 'fixed' })
    )[0]
    const text = {
      ...createTextElement({ text: 'First\nSecond', autoSize: 'fixed' }),
      paragraphs: [first, second]
    }

    render(
      <EditableSlideSurface
        document={addElementToSlide(source, slideId, text)}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )
    const firstParagraph = document.querySelector<HTMLElement>('[data-text-paragraph="0"]')!
    const secondParagraph = document.querySelector<HTMLElement>('[data-text-paragraph="1"]')!
    firstParagraph.append(...Array.from(secondParagraph.childNodes))
    secondParagraph.remove()
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())

    expect(handleUpdate.mock.calls.at(-1)?.[2].paragraphs?.[0].runs).toEqual([
      expect.objectContaining({ text: 'First', italic: true, bold: false }),
      expect.objectContaining({ text: 'Second', bold: true, color: '#ef4444' })
    ])
  })

  it('keeps a collapsed typing style only on the caret side of a paragraph split', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const original = createTextElement({ text: 'HelloWorld', autoSize: 'fixed' })
    const paragraph = normalizeTextParagraphs(original)[0]
    const text = {
      ...original,
      paragraphs: [
        {
          ...paragraph,
          typingStyle: { ...resolveTypingStyle([paragraph], 5)!, bold: true },
          typingStyleCaret: 5
        }
      ]
    }

    render(
      <EditableSlideSurface
        document={addElementToSlide(source, slideId, text)}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )
    const firstParagraph = document.querySelector<HTMLElement>('[data-text-paragraph="0"]')!
    const firstRun = firstParagraph.querySelector<HTMLElement>('[data-text-run="0"]')!
    const secondParagraph = document.createElement('div')
    const secondRun = firstRun.cloneNode(true) as HTMLElement
    firstRun.textContent = 'Hello'
    secondRun.textContent = 'World'
    secondParagraph.append(secondRun)
    firstParagraph.after(secondParagraph)
    const range = document.createRange()
    range.setStart(secondRun.firstChild!, 0)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())

    const paragraphs = handleUpdate.mock.calls.at(-1)?.[2].paragraphs
    expect(paragraphs?.[0].typingStyleCaret).toBeUndefined()
    expect(paragraphs?.[1].typingStyleCaret).toBe(0)
    expect(paragraphs?.[1].typingStyle?.bold).toBe(true)
  })

  it('applies a collapsed typing style to text inserted inside an existing run', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const original = createTextElement({
      text: 'Hello',
      autoSize: 'fixed',
      runs: [{ ...createTextElement({ fontFamily: 'Arial' }), text: 'Hello' }]
    })
    const paragraph = normalizeTextParagraphs(original)[0]
    const typingStyle = resolveTypingStyle([paragraph], 5)!
    const text = {
      ...original,
      paragraphs: [
        { ...paragraph, typingStyle: { ...typingStyle, bold: true }, typingStyleCaret: 5 }
      ]
    }

    render(
      <EditableSlideSurface
        document={addElementToSlide(document, slideId, text)}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )
    screen.getByText('Hello').textContent = 'Hello!'
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())

    expect(handleUpdate).toHaveBeenCalledWith(
      slideId,
      text.id,
      expect.objectContaining({
        paragraphs: [
          expect.objectContaining({
            runs: [
              expect.objectContaining({ text: 'Hello', bold: false }),
              expect.objectContaining({ text: '!', bold: true })
            ]
          })
        ]
      })
    )
  })

  it('moves a collapsed typing style backward with a deletion', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const original = createTextElement({ text: 'Hello', autoSize: 'fixed' })
    const paragraph = normalizeTextParagraphs(original)[0]
    const text = {
      ...original,
      paragraphs: [
        {
          ...paragraph,
          typingStyle: { ...resolveTypingStyle([paragraph], 5)!, bold: true },
          typingStyleCaret: 5
        }
      ]
    }
    const initial = addElementToSlide(source, slideId, text)
    const view = render(
      <EditableSlideSurface
        document={initial}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )

    screen.getByText('Hello').textContent = 'Hell'
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())
    const deletion = handleUpdate.mock.calls.at(-1)![2]
    expect(deletion.paragraphs?.[0].typingStyleCaret).toBe(4)

    const afterDeletion = updateElementInSlide(initial, slideId, text.id, deletion)
    handleUpdate.mockClear()
    view.rerender(
      <EditableSlideSurface
        document={afterDeletion}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )
    screen.getByText('Hell').textContent = 'Hell!'
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())

    expect(handleUpdate.mock.calls.at(-1)?.[2].paragraphs?.[0].runs.at(-1)).toMatchObject({
      text: '!',
      bold: true
    })
  })

  it('moves a collapsed typing style backward when an earlier run is removed', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const original = createTextElement({
      text: 'DeleteKeep',
      autoSize: 'fixed',
      runs: [
        { ...createTextElement({ fontFamily: 'Arial', bold: true }), text: 'Delete' },
        { ...createTextElement({ fontFamily: 'Arial' }), text: 'Keep' }
      ]
    })
    const paragraph = normalizeTextParagraphs(original)[0]
    const text = {
      ...original,
      paragraphs: [
        {
          ...paragraph,
          typingStyle: { ...resolveTypingStyle([paragraph], 10)!, bold: true },
          typingStyleCaret: 10
        }
      ]
    }
    const initial = addElementToSlide(source, slideId, text)
    const view = render(
      <EditableSlideSurface
        document={initial}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )

    screen.getByText('Delete').remove()
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())
    const deletion = handleUpdate.mock.calls.at(-1)![2]
    expect(deletion.paragraphs?.[0].typingStyleCaret).toBe(4)
    expect(deletion).toMatchObject({
      text: 'Keep',
      paragraphs: [{ runs: [expect.objectContaining({ text: 'Keep' })] }]
    })

    const afterDeletion = updateElementInSlide(initial, slideId, text.id, deletion)
    handleUpdate.mockClear()
    view.unmount()
    render(
      <EditableSlideSurface
        document={afterDeletion}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )
    screen.getByText('Keep').textContent = 'Keep!'
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())

    expect(handleUpdate.mock.calls.at(-1)?.[2].paragraphs?.[0].runs.at(-1)).toMatchObject({
      text: '!',
      bold: true
    })
  })

  it('moves a collapsed typing style forward when raw text is inserted before it', () => {
    const flushAnimationFrame = mockAnimationFrame()
    const handleUpdate = vi.fn()
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const original = createTextElement({
      text: 'HelloWorld',
      autoSize: 'fixed',
      runs: [
        { ...createTextElement({ fontFamily: 'Arial', italic: true }), text: 'Hello' },
        { ...createTextElement({ fontFamily: 'Arial' }), text: 'World' }
      ]
    })
    const paragraph = normalizeTextParagraphs(original)[0]
    const text = {
      ...original,
      paragraphs: [
        {
          ...paragraph,
          typingStyle: { ...resolveTypingStyle([paragraph], 10)!, bold: true },
          typingStyleCaret: 10
        }
      ]
    }

    render(
      <EditableSlideSurface
        document={addElementToSlide(source, slideId, text)}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onUpdateElement={handleUpdate}
      />
    )
    const paragraphNode = document.querySelector<HTMLElement>('[data-text-paragraph]')!
    const secondRun = paragraphNode.querySelector<HTMLElement>('[data-text-run="1"]')!
    paragraphNode.insertBefore(document.createTextNode('++'), secondRun)
    fireEvent.input(screen.getByRole('textbox'))
    act(() => flushAnimationFrame())

    expect(handleUpdate.mock.calls.at(-1)?.[2].paragraphs?.[0].typingStyleCaret).toBe(12)
  })

  it('reports the current character selection to ribbon commands', () => {
    const handleSelection = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Hello',
      autoSize: 'fixed',
      runs: [{ ...createTextElement({ fontFamily: 'Arial' }), text: 'Hello' }]
    })

    render(
      <EditableSlideSurface
        document={addElementToSlide(document, slideId, text)}
        slideId={slideId}
        editable
        editingElementId={text.id}
        onTextSelectionChange={handleSelection}
      />
    )
    const textNode = screen.getByText('Hello').firstChild!
    const range = window.document.createRange()
    range.setStart(textNode, 1)
    range.setEnd(textNode, 4)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    act(() => window.document.dispatchEvent(new Event('selectionchange')))

    expect(handleSelection).toHaveBeenLastCalledWith({ elementId: text.id, start: 1, end: 4 })
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

  it('keeps legacy auto-width text content-height when autoSize is absent', () => {
    const handleUpdate = vi.fn()
    const document = createBlankEditablePresentationDocument('Sunday')
    const slideId = document.slideOrder[0]
    const text = createTextElement({
      text: 'Legacy frame',
      width: 220,
      height: 40,
      autoWidth: true
    })
    delete text.autoSize
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

    expect(screen.getAllByLabelText(/Resize text box/)).toHaveLength(6)
    const rightHandle = screen.getByLabelText('Resize text box right')
    mockElementRect(rightHandle, { left: 0, top: 0, width: 25, height: 25 })
    fireEvent.pointerDown(rightHandle, { clientX: 12.5, clientY: 12.5, pointerId: 1 })
    fireEvent.pointerMove(rightHandle, { clientX: 36.5, clientY: 36.5, pointerId: 1 })

    const updates = handleUpdate.mock.calls[0]?.[2]
    expect(updates).toMatchObject({ width: 244, autoSize: 'content', autoWidth: false })
    expect(updates).not.toHaveProperty('height')
    expect(updates).not.toHaveProperty('y')
  })

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

function EditableSurfaceHarness({
  document,
  slideId,
  selectedElementId,
  cropElementId,
  onUpdateElement
}: {
  document: EditablePresentationDocument
  slideId: string
  selectedElementId?: string | null
  cropElementId?: string | null
  onUpdateElement?: ComponentProps<typeof EditableSlideSurface>['onUpdateElement']
}): JSX.Element {
  const [editingElementId, setEditingElementId] = useState<string | null>(null)

  return (
    <EditableSlideSurface
      document={document}
      slideId={slideId}
      editable
      selectedElementId={selectedElementId}
      editingElementId={editingElementId}
      cropElementId={cropElementId}
      onEditingElementChange={setEditingElementId}
      onUpdateElement={onUpdateElement}
    />
  )
}

function StatefulEditableSurfaceHarness({
  document,
  slideId
}: {
  document: EditablePresentationDocument
  slideId: string
}): JSX.Element {
  const [currentDocument, setCurrentDocument] = useState(document)
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null)
  const [editingElementId, setEditingElementId] = useState<string | null>(null)

  return (
    <EditableSlideSurface
      document={currentDocument}
      slideId={slideId}
      editable
      selectedElementId={selectedElementId}
      editingElementId={editingElementId}
      onSelectElement={setSelectedElementId}
      onEditingElementChange={setEditingElementId}
      onUpdateElement={(nextSlideId, elementId, updates) => {
        setCurrentDocument((previous) =>
          updateElementInSlide(previous, nextSlideId, elementId, updates)
        )
      }}
    />
  )
}

function mockTextMeasurement(): void {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return Math.max(20, (this.textContent?.length ?? 0) * 12) + getHorizontalPadding(this)
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    const width = Number.parseFloat(this.style.width) - getHorizontalPadding(this)
    const textWidth = Math.max(20, (this.textContent?.length ?? 0) * 12)
    const lines =
      Number.isFinite(width) && width > 0 ? Math.max(1, Math.ceil(textWidth / width)) : 1
    return lines * 74 + getVerticalPadding(this)
  })
}

function getHorizontalPadding(element: HTMLElement): number {
  return (
    Number.parseFloat(element.style.paddingLeft) + Number.parseFloat(element.style.paddingRight)
  )
}

function getVerticalPadding(element: HTMLElement): number {
  return (
    Number.parseFloat(element.style.paddingTop) + Number.parseFloat(element.style.paddingBottom)
  )
}

function mockAnimationFrame(): () => void {
  let nextFrameId = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const frameId = ++nextFrameId
    frames.set(frameId, callback)
    return frameId
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frameId) => {
    frames.delete(frameId)
  })

  return () => {
    const pendingFrames = [...frames.values()]
    frames.clear()
    pendingFrames.forEach((callback) => callback(0))
  }
}

function getSlideSurface(container: HTMLElement): HTMLElement {
  const surface = container.querySelector('[data-slide-surface]')
  if (!(surface instanceof HTMLElement)) throw new Error('slide surface not found')
  return surface
}

function withinResizeHandle(handle: HTMLElement): HTMLElement {
  const indicator = handle.querySelector('[data-resize-handle-indicator]')
  if (!(indicator instanceof HTMLElement)) throw new Error('resize handle indicator not found')
  return indicator
}

function withinResizeHandleVisual(handle: HTMLElement): HTMLElement {
  const visual = handle.querySelector('[data-resize-handle-visual]')
  if (!(visual instanceof HTMLElement)) throw new Error('resize handle visual not found')
  return visual
}

function expectScreenHitTarget(handle: HTMLElement, scale: number): void {
  expect(Number.parseFloat(handle.style.width) * scale).toBeGreaterThanOrEqual(24)
  expect(Number.parseFloat(handle.style.height) * scale).toBeGreaterThanOrEqual(24)
}

function mockSurfaceRect(surface: HTMLElement): void {
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 960,
    bottom: 540,
    width: 960,
    height: 540,
    toJSON: () => ({})
  })
}

function mockHandleCenterTie(
  surface: HTMLElement,
  preferred: HTMLElement,
  painted: HTMLElement
): void {
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 480, 270))
  vi.spyOn(preferred, 'getBoundingClientRect').mockReturnValue(rect(92.5, 92.5, 25, 25))
  vi.spyOn(painted, 'getBoundingClientRect').mockReturnValue(rect(87.5, 87.5, 25, 25))
  vi.spyOn(withinResizeHandle(preferred), 'getBoundingClientRect').mockReturnValue(
    rect(89, 89, 12, 12)
  )
  vi.spyOn(withinResizeHandle(painted), 'getBoundingClientRect').mockReturnValue(
    rect(99, 99, 12, 12)
  )
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON: () => ({})
  }
}

function mockSurfaceScale(scale: number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.hasAttribute('data-slide-surface')) {
      const width = 1920 * scale
      const height = 1080 * scale
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
        toJSON: () => ({})
      }
    }
    return new DOMRect()
  })
}

function mockElementRect(
  element: HTMLElement,
  rect: { left: number; top: number; width: number; height: number }
): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({})
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})
