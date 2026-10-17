import { mockAnimationFrame } from '@renderer/test/animation-frame'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import EditableSlideSurface from '../EditableSlideSurface'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createTextElement,
  updateElementInSlide
} from '@renderer/lib/editable-presentation'
import { normalizeTextParagraphs, resolveTypingStyle } from '@renderer/lib/presentation-rich-text'
import {
  EditableSurfaceHarness,
  StatefulEditableSurfaceHarness,
  mockTextMeasurement,
  mockElementRect
} from '@renderer/test/editable-slide-surface-harness'

describe('EditableSlideSurface text contract', () => {
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
})

afterEach(() => {
  vi.restoreAllMocks()
})
