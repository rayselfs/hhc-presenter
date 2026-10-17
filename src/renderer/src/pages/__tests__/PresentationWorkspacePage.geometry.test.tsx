import {
  mocks,
  Workspace,
  renderWorkspaceSession,
  resizeElement,
  mockAutoTextMeasurement,
  setupWorkspaceSessionTest,
  cleanupWorkspaceSessionTest
} from '@renderer/test/presentation-workspace-session-harness'
import { mockAnimationFrame } from '@renderer/test/animation-frame'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  PresentationSessionRegistryProvider,
  type PresentationSessionRegistry
} from '@renderer/contexts/PresentationSessionRegistryContext'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createTextElement
} from '@renderer/lib/editable-presentation'

describe('PresentationWorkspacePage geometry contract', () => {
  beforeEach(setupWorkspaceSessionTest)
  afterEach(cleanupWorkspaceSessionTest)
  it.each([1920, 1280])(
    'inserts 24 point text with line-height and vertical inset at %i px document width',
    async (documentWidth) => {
      const sourceDocument = createBlankEditablePresentationDocument('Sunday')
      sourceDocument.width = documentWidth
      sourceDocument.height = (documentWidth * 9) / 16
      mocks.loadEditablePresentationSnapshot.mockResolvedValue({
        document: sourceDocument,
        revision: 0
      })
      let registry: PresentationSessionRegistry | null = null
      render(
        <PresentationSessionRegistryProvider>
          <Workspace showPage onSession={(next) => (registry = next)} />
        </PresentationSessionRegistryProvider>
      )
      await waitFor(() => expect(registry!.get('deck-1')).toBeDefined())

      const surface = window.document.querySelector<HTMLElement>(
        '.presentation-stage [data-slide-surface]'
      )
      expect(surface).not.toBeNull()
      vi.spyOn(surface!, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: documentWidth / 2,
        bottom: sourceDocument.height / 2,
        width: documentWidth / 2,
        height: sourceDocument.height / 2,
        toJSON: () => undefined
      })

      fireEvent.doubleClick(surface!, { clientX: 100, clientY: 100 })

      await waitFor(() => {
        const document = registry!.get('deck-1')!.getSnapshot().renderedDocument
        const slide = document.slides[document.slideOrder[0]]
        expect(slide.elementOrder).toHaveLength(1)
        const element = slide.elements[slide.elementOrder[0]]
        expect(element.type).toBe('text')
        if (element.type !== 'text') return
        expect((element.fontSize * 960) / documentWidth).toBe(24)
        expect(element.height).toBe(
          Math.max(32, Math.ceil(element.fontSize * element.lineHeight) + 8)
        )
        expect(element.autoSize).toBe('content')
        expect(element.autoWidth).toBe(true)
      })

      const firstContent = window.document.querySelector<HTMLElement>(
        '.presentation-stage [contenteditable="true"]'
      )!
      firstContent.textContent = 'First text'
      fireEvent.input(firstContent)
      fireEvent.click(screen.getByRole('button', { name: 'Text' }))
      fireEvent.pointerDown(surface!, { clientX: 100, clientY: 100, pointerId: 1 })
      fireEvent.pointerUp(surface!, { clientX: 140, clientY: 120, pointerId: 1 })

      await waitFor(() => {
        const slide = registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[
          sourceDocument.slideOrder[0]
        ]
        const dragged = slide.elements[slide.elementOrder[1]]
        expect(dragged.type).toBe('text')
        if (dragged.type !== 'text') return
        expect(dragged.height).toBe(
          Math.max(40, Math.ceil(dragged.fontSize * dragged.lineHeight) + 8)
        )
        expect(dragged.autoSize).toBe('content')
        expect(dragged.autoWidth).toBe(false)
      })

      const secondContent = window.document.querySelector<HTMLElement>(
        '.presentation-stage [contenteditable="true"]'
      )!
      secondContent.textContent = 'Second text'
      fireEvent.input(secondContent)
      const rightHandle = screen.getByLabelText('Resize text box right')
      fireEvent.pointerDown(rightHandle, { clientX: 0, clientY: 0, pointerId: 2 })
      fireEvent.pointerMove(rightHandle, { clientX: 12, clientY: 0, pointerId: 2 })
      fireEvent.pointerUp(rightHandle, { clientX: 12, clientY: 0, pointerId: 2 })

      await waitFor(() => {
        const slide = registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[
          sourceDocument.slideOrder[0]
        ]
        const resized = slide.elements[slide.elementOrder[1]]
        expect(resized.type === 'text' ? resized.width : null).toBe(104)
        expect(resized.type === 'text' ? resized.autoSize : null).toBe('content')
      })

      act(() => registry!.get('deck-1')!.undo())
      const afterUndo = registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[
        sourceDocument.slideOrder[0]
      ].elements[
        registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[sourceDocument.slideOrder[0]]
          .elementOrder[1]
      ]
      expect(afterUndo.type === 'text' ? afterUndo.width : null).toBe(80)
      expect(afterUndo.type === 'text' ? afterUndo.autoSize : null).toBe('content')
    }
  )

  it('does not let a pending text blur create history after a resize commits', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({
      text: 'Original text',
      width: 80,
      height: 40,
      autoSize: 'content',
      autoWidth: false
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())

    let textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!textBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    textBox.textContent = 'Pending blur text'
    fireEvent.input(textBox)
    const rightHandle = await screen.findByLabelText('Resize text box right')
    rightHandle.focus()
    fireEvent.blur(textBox)

    fireEvent.pointerDown(rightHandle, { clientX: 0, clientY: 0, pointerId: 2 })
    fireEvent.pointerMove(rightHandle, { clientX: 24, clientY: 0, pointerId: 2 })
    fireEvent.pointerUp(rightHandle, { clientX: 24, clientY: 0, pointerId: 2 })

    act(() => flushAnimationFrame())

    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Pending blur text', width: 104 })
    act(() => registry!.get('deck-1')!.undo())
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Pending blur text', width: 80 })
  })

  it('resizes from finalized auto-width text geometry and undoes only the resize', async () => {
    mockAutoTextMeasurement()
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({
      text: 'Original',
      width: 80,
      height: 30,
      autoSize: 'content',
      autoWidth: true
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())

    let textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!textBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    textBox.textContent = 'Final title'
    fireEvent.input(textBox)
    const rightHandle = await screen.findByLabelText('Resize text box right')
    rightHandle.focus()
    fireEvent.blur(textBox)

    fireEvent.pointerDown(rightHandle, { clientX: 0, clientY: 0, pointerId: 2 })
    fireEvent.pointerMove(rightHandle, { clientX: 24, clientY: 0, pointerId: 2 })
    fireEvent.pointerUp(rightHandle, { clientX: 24, clientY: 0, pointerId: 2 })
    act(() => flushAnimationFrame())

    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Final title', width: 172, height: 82 })
    act(() => registry!.get('deck-1')!.undo())
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Final title', width: 148, height: 82 })
  })

  it('does not create a text history entry when editing finishes unchanged before resize', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Unchanged', width: 80, height: 40, autoWidth: false })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const initialHistoryLength = session.getSnapshot().history.past.length
    let textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!textBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    const rightHandle = await screen.findByLabelText('Resize text box right')
    fireEvent.pointerDown(rightHandle, { clientX: 0, clientY: 0, pointerId: 2 })
    fireEvent.pointerMove(rightHandle, { clientX: 24, clientY: 0, pointerId: 2 })
    fireEvent.pointerUp(rightHandle, { clientX: 24, clientY: 0, pointerId: 2 })

    expect(session.getSnapshot().history.past).toHaveLength(initialHistoryLength + 1)
    act(() => session.undo())
    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      text: 'Unchanged',
      width: 80
    })
  })

  it('commits one history entry for each keyboard resize action', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({
      text: 'Keyboard frame',
      x: 100,
      y: 80,
      width: 220,
      height: 40,
      autoSize: 'fixed',
      autoWidth: false
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const initialHistoryLength = session.getSnapshot().history.past.length
    const textFrame = (await screen.findAllByText('Keyboard frame'))
      .at(-1)
      ?.closest('[data-slide-element]')
    expect(textFrame).not.toBeNull()
    fireEvent.click(textFrame!)

    const firstHandle = screen.getByLabelText('Resize text box right')
    const firstResize = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true
    })
    fireEvent(firstHandle, firstResize)

    expect(firstResize.defaultPrevented).toBe(true)
    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      x: 100,
      width: 221
    })
    expect(session.getSnapshot().history.past).toHaveLength(initialHistoryLength + 1)

    const secondHandle = screen.getByLabelText('Resize text box right')
    fireEvent.keyDown(secondHandle, { key: 'ArrowRight', shiftKey: true })
    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      x: 100,
      width: 231
    })
    expect(session.getSnapshot().history.past).toHaveLength(initialHistoryLength + 2)
  })

  it('does not change document, history, revision, or save work for min-clamped resize', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({
      text: 'Minimum frame',
      x: 100,
      y: 80,
      width: 60,
      height: 24,
      autoSize: 'fixed',
      autoWidth: false
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const initial = session.getSnapshot()
    const textFrame = (await screen.findAllByText('Minimum frame'))
      .at(-1)
      ?.closest('[data-slide-element]')
    fireEvent.click(textFrame!)

    const leftHandle = screen.getByLabelText('Resize text box left')
    fireEvent.keyDown(leftHandle, { key: 'ArrowRight' })
    fireEvent.pointerDown(leftHandle, { clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(leftHandle, { clientX: 24, clientY: 0, pointerId: 1 })
    fireEvent.pointerUp(leftHandle, { clientX: 24, clientY: 0, pointerId: 1 })

    const after = session.getSnapshot()
    expect(after.renderedDocument).toBe(initial.renderedDocument)
    expect(after.history).toBe(initial.history)
    expect(after.save.scheduledRevision).toBe(initial.save.scheduledRevision)
    expect(after.draftKind).toBeNull()
    expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
  })

  it('does not commit a pointer move whose finalized position snaps to its original', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({
      text: 'Snapped origin',
      x: 0,
      y: 100,
      width: 120,
      height: 40,
      autoWidth: false
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const initial = session.getSnapshot()
    const frame = (await screen.findAllByText('Snapped origin'))
      .at(-1)
      ?.closest<HTMLElement>('[data-slide-element]')
    if (!frame) throw new Error('presentation text frame not found')

    fireEvent.pointerDown(frame, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(frame, { clientX: 14, clientY: 10, pointerId: 1 })

    expect(session.getSnapshot().renderedDocument).toBe(initial.renderedDocument)
    expect(frame).toHaveStyle({ left: '0px' })

    fireEvent.pointerUp(frame, { clientX: 14, clientY: 10, pointerId: 1 })
    const after = session.getSnapshot()
    expect(after.renderedDocument).toBe(initial.renderedDocument)
    expect(after.history).toBe(initial.history)
    expect(after.save.scheduledRevision).toBe(initial.save.scheduledRevision)
    expect(after.draftKind).toBeNull()
    expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
  })

  it('restores the live base geometry when a pointer move returns exactly to its origin', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({
      text: 'Return to origin',
      x: 100,
      y: 100,
      width: 120,
      height: 40,
      autoWidth: false
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const initial = session.getSnapshot()
    const frame = (await screen.findAllByText('Return to origin'))
      .at(-1)
      ?.closest<HTMLElement>('[data-slide-element]')
    if (!frame) throw new Error('presentation text frame not found')

    fireEvent.pointerDown(frame, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(frame, { clientX: 30, clientY: 10, pointerId: 1 })
    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      x: 120,
      y: 100
    })

    const movedFrame = (await screen.findAllByText('Return to origin'))
      .at(-1)
      ?.closest<HTMLElement>('[data-slide-element]')
    if (!movedFrame) throw new Error('moved presentation text frame not found')
    fireEvent.pointerMove(movedFrame, { clientX: 10, clientY: 10, pointerId: 1 })

    expect(session.getSnapshot().renderedDocument).toBe(initial.renderedDocument)
    expect(movedFrame).toHaveStyle({ left: '100px', top: '100px' })

    fireEvent.pointerUp(movedFrame, { clientX: 10, clientY: 10, pointerId: 1 })
    const after = session.getSnapshot()
    expect(after.history).toBe(initial.history)
    expect(after.save.scheduledRevision).toBe(initial.save.scheduledRevision)
    expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
  })

  it('does not commit a selected group move whose finalized delta snaps to zero', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const first = createTextElement({ text: 'Group first', x: 0, y: 100, width: 120, height: 40 })
    const second = createTextElement({
      text: 'Group second',
      x: 200,
      y: 100,
      width: 120,
      height: 40
    })
    const withFirst = addElementToSlide(sourceDocument, slideId, first)
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(withFirst, slideId, second),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const firstFrame = (await screen.findAllByText('Group first'))
      .at(-1)
      ?.closest<HTMLElement>('[data-slide-element]')
    const secondFrame = (await screen.findAllByText('Group second'))
      .at(-1)
      ?.closest<HTMLElement>('[data-slide-element]')
    if (!firstFrame || !secondFrame) throw new Error('presentation group frames not found')
    fireEvent.click(firstFrame)
    fireEvent.click(secondFrame, { ctrlKey: true })
    const initial = session.getSnapshot()

    act(() => {
      fireEvent.pointerDown(firstFrame, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(firstFrame, { clientX: 14, clientY: 10, pointerId: 1 })
    })
    fireEvent.pointerUp(firstFrame, { clientX: 14, clientY: 10, pointerId: 1 })

    const after = session.getSnapshot()
    expect(after.renderedDocument).toBe(initial.renderedDocument)
    expect(after.history).toBe(initial.history)
    expect(after.save.scheduledRevision).toBe(initial.save.scheduledRevision)
    expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
  })

  it('starts in Fit mode and recalculates when Notes changes the viewport height', async () => {
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={() => undefined} />
      </PresentationSessionRegistryProvider>
    )

    const viewport = await screen.findByTestId('presentation-canvas-viewport')
    resizeElement(viewport, 1050, 486)

    expect(screen.getByRole('button', { name: 'Fit' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('73')

    const notesToggle = screen.getByRole('button', { name: 'Toggle Notes' })
    expect(notesToggle).toHaveAttribute('aria-controls', 'presentation-notes-region')
    expect(notesToggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(notesToggle)
    resizeElement(viewport, 1050, 400)

    const notesRegion = screen.getByRole('region', { name: 'Notes' })
    expect(notesRegion).toHaveAttribute('id', 'presentation-notes-region')
    expect(notesToggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeVisible()
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('58')
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeVisible()

    fireEvent.click(notesToggle)
    expect(notesToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'Notes' })).not.toBeInTheDocument()
  })

  it('leaves Windows Meta-wheel untouched while Windows Ctrl-wheel zooms', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32')
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={() => undefined} />
      </PresentationSessionRegistryProvider>
    )

    const viewport = await screen.findByTestId('presentation-canvas-viewport')
    resizeElement(viewport, 1050, 486)
    const zoom = screen.getByRole('slider', { name: 'Zoom' })
    const fit = screen.getByRole('button', { name: 'Fit' })

    const metaWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      metaKey: true,
      deltaY: -100
    })
    fireEvent(viewport, metaWheel)
    expect(metaWheel.defaultPrevented).toBe(false)
    expect(zoom).toHaveValue('73')
    expect(fit).toHaveAttribute('aria-pressed', 'true')

    const ctrlWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -100
    })
    fireEvent(viewport, ctrlWheel)
    expect(ctrlWheel.defaultPrevented).toBe(true)
    expect(zoom).toHaveValue('78')
    expect(fit).toHaveAttribute('aria-pressed', 'false')
  })

  it('anchors macOS Ctrl and Meta wheel zoom while leaving ordinary wheel scrolling alone', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel')
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={() => undefined} />
      </PresentationSessionRegistryProvider>
    )

    const viewport = await screen.findByTestId('presentation-canvas-viewport')
    resizeElement(viewport, 1050, 486)
    Object.defineProperties(viewport, {
      scrollLeft: { value: 200, writable: true },
      scrollTop: { value: 100, writable: true }
    })
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1050,
      bottom: 486,
      width: 1050,
      height: 486,
      toJSON: () => undefined
    })

    const ordinaryWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 })
    fireEvent(viewport, ordinaryWheel)
    expect(ordinaryWheel.defaultPrevented).toBe(false)
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('73')

    const ctrlWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 200,
      ctrlKey: true,
      deltaY: -100
    })
    fireEvent(viewport, ctrlWheel)
    expect(ctrlWheel.defaultPrevented).toBe(true)
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('78')
    expect(viewport.scrollLeft).toBeCloseTo(220.55, 1)
    expect(viewport.scrollTop).toBeCloseTo(113.7, 1)

    const metaWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 200,
      metaKey: true,
      deltaY: -100
    })
    fireEvent(viewport, metaWheel)
    expect(metaWheel.defaultPrevented).toBe(true)
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('83')
  })

  it('keeps the editable stage and Ribbon inside the shared responsive workspace shell', async () => {
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={() => undefined} />
      </PresentationSessionRegistryProvider>
    )

    const ribbon = await screen.findByTestId('presentation-ribbon-frame')
    const group = window.document.querySelector('.workspace-panel-group')
    expect(group).not.toBeNull()
    expect(group!.querySelector('.workspace-navigator-slot [data-slide-sidebar]')).toHaveClass(
      'h-full',
      'overflow-y-auto'
    )
    const stageSlot = group!.querySelector('.workspace-stage-slot')
    expect(stageSlot).toHaveClass('flex')
    expect(stageSlot?.querySelector('.presentation-stage')).toHaveClass('min-h-0', 'flex-1')
    expect(ribbon.querySelector('[data-ribbon-surface]')).toHaveClass(
      'overflow-x-auto',
      'overflow-y-hidden',
      'bg-surface'
    )
  })
})
