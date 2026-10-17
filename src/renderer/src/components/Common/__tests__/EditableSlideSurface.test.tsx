import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import EditableSlideSurface from '../EditableSlideSurface'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createTextElement
} from '@renderer/lib/editable-presentation'
import { getSlideSurface, mockSurfaceRect } from '@renderer/test/editable-slide-surface-harness'

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
