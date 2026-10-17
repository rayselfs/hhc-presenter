import {
  mocks,
  Workspace,
  HeaderWorkspaceWithSession,
  GuardedWorkspace,
  renderWorkspaceSession,
  setupWorkspaceSessionTest,
  cleanupWorkspaceSessionTest
} from '@renderer/test/presentation-workspace-session-harness'
import { makeEditableItem } from '@renderer/test/presentation-fixtures'
import { mockAnimationFrame } from '@renderer/test/animation-frame'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import {
  PresentationSessionRegistryProvider,
  type PresentationSessionRegistry
} from '@renderer/contexts/PresentationSessionRegistryContext'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createTextElement,
  insertBlankEditableSlide
} from '@renderer/lib/editable-presentation'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import { openFileExplorerDB } from '@renderer/lib/file-explorer-db'

describe('PresentationWorkspacePage text contract', () => {
  beforeEach(setupWorkspaceSessionTest)
  afterEach(cleanupWorkspaceSessionTest)
  it('formats the whole text box after its character selection leaves edit mode', async () => {
    const source = createBlankEditablePresentationDocument('Sunday')
    const slideId = source.slideOrder[0]
    const text = createTextElement({ text: 'Whole text' })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(source, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const frame = (await screen.findAllByText('Whole text'))
      .at(-1)!
      .closest('[data-slide-element]')!

    fireEvent.click(frame)
    fireEvent.keyDown(document, { key: 'Enter', code: 'Enter' })
    const content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!
    const textNode = document.createTreeWalker(content, NodeFilter.SHOW_TEXT).nextNode()!
    const range = document.createRange()
    range.setStart(textNode, 1)
    range.setEnd(textNode, 4)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    fireEvent.keyDown(content, { key: 'Escape', code: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }))

    const updated = session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    expect(updated.type === 'text' && updated.paragraphs?.[0].runs.every((run) => run.bold)).toBe(
      true
    )
  })

  it('finalizes pending text on Escape instead of discarding its active edit transaction', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const historyLength = session.getSnapshot().history.past.length
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    content.textContent = 'Keep me'
    fireEvent.input(content)
    fireEvent.keyDown(content, { key: 'Escape', code: 'Escape' })

    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      text: 'Keep me'
    })
    expect(session.getSnapshot().history.past).toHaveLength(historyLength + 1)
    act(() => flushAnimationFrame())
    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      text: 'Keep me'
    })
  })

  it('keeps composition active on Escape and exposes pending DOM text as unsafe work', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
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
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    fireEvent.compositionStart(content)
    content.textContent = 'Provisional'
    fireEvent.input(content)
    expect(registry!.hasUnsafeWork()).toBe(true)
    fireEvent.keyDown(content, { key: 'Escape', code: 'Escape', keyCode: 229, isComposing: true })

    expect(content).toHaveAttribute('contenteditable', 'true')
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Before' })
    fireEvent.compositionEnd(content)
    act(() => flushAnimationFrame())
    fireEvent.keyDown(content, { key: 'Escape', code: 'Escape' })

    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Provisional' })
  })

  it('reports regular pending editor input as unsafe before its animation frame', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
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
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    content.textContent = 'Pending navigation text'
    fireEvent.input(content)

    expect(registry!.hasUnsafeWork()).toBe(true)
    act(() => flushAnimationFrame())
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Pending navigation text' })
  })

  it('commits continuous text within four seconds but never during composition', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const initial = createBlankEditablePresentationDocument('Continuous typing')
    const slideId = initial.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(initial, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    vi.useFakeTimers()
    try {
      fireEvent.pointerDown(
        document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
        { clientX: 40, clientY: 20, pointerId: 1 }
      )
      const content = document.querySelector<HTMLElement>(
        '.presentation-stage [data-text-content][contenteditable="true"]'
      )!
      act(() => session.beginDraft('text'))
      for (let index = 0; index < 10; index++) {
        content.textContent = `Continuous ${index}`
        fireEvent.input(content)
        act(() => flushAnimationFrame())
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500)
        })
      }
      expect(session.getSnapshot().history.present.slides[slideId].elements[text.id]).toMatchObject(
        { text: 'Continuous 8' }
      )
      expect(session.getSnapshot().save.persistedRevision).toBeGreaterThan(0)
      fireEvent.compositionStart(content)
      const committed = session.getSnapshot().history.present
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(session.getSnapshot().history.present).toBe(committed)
      content.textContent = '完成輸入'
      fireEvent.compositionEnd(content)
      act(() => flushAnimationFrame())
      expect(session.getSnapshot().history.present.slides[slideId].elements[text.id]).toMatchObject(
        { text: '完成輸入' }
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes autosaving a pending draft after composition is canceled without changes', async () => {
    const initial = createBlankEditablePresentationDocument('Canceled composition')
    const slideId = initial.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(initial, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    vi.useFakeTimers()
    const flushAnimationFrame = mockAnimationFrame()
    try {
      fireEvent.pointerDown(
        document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
        { clientX: 40, clientY: 20, pointerId: 1 }
      )
      const content = document.querySelector<HTMLElement>(
        '.presentation-stage [data-text-content][contenteditable="true"]'
      )!
      content.textContent = 'Pending text'
      fireEvent.input(content)
      act(() => flushAnimationFrame())
      expect(session.getSnapshot().draftKind).toBe('text')
      fireEvent.compositionStart(content)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(session.getSnapshot().draftKind).toBe('text')
      fireEvent.compositionEnd(content)
      act(() => flushAnimationFrame())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(session.getSnapshot().draftKind).toBeNull()
      expect(session.getSnapshot().save.status).toBe('saved')
      expect(session.getSnapshot().history.present.slides[slideId].elements[text.id]).toMatchObject(
        {
          text: 'Pending text'
        }
      )
      expect(session.getSnapshot().save.persistedRevision).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles a refocused pending blur through text commit without leaving edit mode unsafe', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
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
    await act(async () => {
      await registry!.get('deck-1')!.flush()
    })
    vi.useFakeTimers()
    try {
      let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
      if (!content) throw new Error('presentation text box not found')
      fireEvent.pointerDown(
        document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
        { clientX: 40, clientY: 20, pointerId: 1 }
      )
      content = document.querySelector<HTMLElement>(
        '.presentation-stage [data-text-content][contenteditable="true"]'
      )!
      content.textContent = 'Refocused text'
      fireEvent.input(content)
      fireEvent.blur(content)
      fireEvent.pointerDown(
        document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
        { clientX: 40, clientY: 20, pointerId: 2 }
      )
      content = document.querySelector<HTMLElement>(
        '.presentation-stage [data-text-content][contenteditable="true"]'
      )!
      act(() => flushAnimationFrame())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1750)
      })

      expect(
        registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
      ).toMatchObject({ text: 'Refocused text' })
      expect(registry!.get('deck-1')!.getSnapshot().draftKind).toBeNull()
      expect(registry!.hasPendingEditorWork?.('deck-1')).toBe(false)
      await act(async () => {
        await registry!.get('deck-1')!.flush()
      })
      expect(registry!.hasUnsafeWork()).toBe(false)
      expect(content).toHaveAttribute('contenteditable', 'true')
    } finally {
      vi.useRealTimers()
    }
  })

  it('blocks real navigation and browser unload until live pending text finalizes', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: (
            <PresentationSessionRegistryProvider>
              <GuardedWorkspace onSession={(next) => (registry = next)} />
            </PresentationSessionRegistryProvider>
          )
        }
      ],
      { initialEntries: ['/presentations/deck-1'] }
    )
    render(<RouterProvider router={router} />)
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    content.textContent = 'Navigate safely'
    fireEvent.input(content)
    Object.defineProperty(HTMLElement.prototype, 'focus', {
      configurable: true,
      writable: true,
      value: HTMLElement.prototype.focus
    })
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)

    await act(() => router.navigate('/files'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/files'))
    act(() => flushAnimationFrame())
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Navigate safely' })
  })

  it('keeps real navigation blocked through composition until compositionend', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: (
            <PresentationSessionRegistryProvider>
              <GuardedWorkspace onSession={(next) => (registry = next)} />
            </PresentationSessionRegistryProvider>
          )
        }
      ],
      { initialEntries: ['/presentations/deck-1'] }
    )
    render(<RouterProvider router={router} />)
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    fireEvent.compositionStart(content)
    content.textContent = 'Composed navigation text'
    fireEvent.input(content)

    await act(() => router.navigate('/files'))
    expect(router.state.location.pathname).toBe('/presentations/deck-1')
    fireEvent.compositionEnd(content)
    act(() => flushAnimationFrame())
    await act(() => router.navigate('/files'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/files'))
  })

  it('finalizes live text before header Undo and does not reapply its queued frame', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({
      text: 'Before',
      width: 120,
      height: 40,
      autoSize: 'fixed',
      autoWidth: false
    })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <HeaderWorkspaceWithSession onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    act(() => content!.blur())
    act(() => flushAnimationFrame())
    expect(registry!.get('deck-1')!.getSnapshot().draftKind).toBeNull()
    expect(registry!.get('deck-1')!.getSnapshot().history.past).toHaveLength(0)
    expect(registry!.hasPendingEditorWork?.('deck-1')).toBe(false)
    expect(usePresentationWorkspaceStore.getState().getActiveDocument()?.canUndo).toBe(false)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled())
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    content.textContent = 'Undo target'
    fireEvent.input(content)
    const undo = screen.getByRole('button', { name: 'Undo' })
    expect(undo).toBeEnabled()
    fireEvent.click(undo)

    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Before' })
    act(() => flushAnimationFrame())
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Before' })
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Undo target' })
    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true })
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Before' })
  })

  it('blocks header Undo while text composition is active', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <HeaderWorkspaceWithSession onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    fireEvent.compositionStart(content)
    content.textContent = 'Provisional'
    fireEvent.input(content)
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()

    expect(content).toHaveAttribute('contenteditable', 'true')
    expect(
      registry!.get('deck-1')!.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Before' })
  })

  it('finalizes pending DOM text before Header starts projection and blocks composition', async () => {
    const user = userEvent.setup()
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    await (
      await openFileExplorerDB()
    ).put('folder-items', useFileExplorerStore.getState().items['deck-1']!)
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <HeaderWorkspaceWithSession onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    let content = document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')
    if (!content) throw new Error('presentation text box not found')
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    content.textContent = 'Projected text'
    fireEvent.input(content)
    await user.click(screen.getByRole('button', { name: 'Start projection' }))

    await waitFor(() => expect(mocks.startMediaProjection).toHaveBeenCalledTimes(1))
    expect(
      registry!.get('deck-1')!.getSnapshot().history.present.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Projected text' })
    act(() => flushAnimationFrame())
    expect(
      registry!.get('deck-1')!.getSnapshot().history.present.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Projected text' })

    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.presentation-stage [data-text-content]')!,
      { clientX: 40, clientY: 20, pointerId: 1 }
    )
    content = document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    fireEvent.compositionStart(content)
    content.textContent = 'Provisional'
    fireEvent.input(content)
    await user.click(screen.getByRole('button', { name: 'Start projection' }))

    await waitFor(() =>
      expect(mocks.toastDanger).toHaveBeenCalledWith('Unable to save presentation')
    )
    expect(mocks.startMediaProjection).toHaveBeenCalledTimes(1)
    fireEvent.compositionEnd(content)
    content.textContent = 'Final composition'
    fireEvent.input(content)
    await user.click(screen.getByRole('button', { name: 'Start projection' }))
    await waitFor(() => expect(mocks.startMediaProjection).toHaveBeenCalledTimes(2))
    expect(
      registry!.get('deck-1')!.getSnapshot().history.present.slides[slideId].elements[text.id]
    ).toMatchObject({ text: 'Final composition' })
  })

  it('stores Ribbon font sizes as canvas pixels derived from PowerPoint points', async () => {
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry!.get('deck-1')).toBeDefined())
    const session = registry!.get('deck-1')!
    const document = session.getSnapshot().renderedDocument
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Scale me', fontSize: 88 })

    act(() => session.commit(addElementToSlide(document, slideId, text)))
    const textElement = (await screen.findAllByText('Scale me'))
      .at(-1)
      ?.closest('[data-slide-element]')
    expect(textElement).not.toBeNull()
    fireEvent.pointerDown(textElement!, { clientX: 10, clientY: 10 })
    const fontSizeInput = screen.getByRole('textbox', { name: 'Font size' })
    fireEvent.change(fontSizeInput, { target: { value: '72' } })
    fireEvent.keyDown(fontSizeInput, { key: 'Enter' })

    await waitFor(() => {
      const updated = session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]
      expect(updated.type === 'text' ? updated.fontSize : null).toBe(144)
    })
  })

  it('does not select a generated shape while composition blocks the mutation', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Composing', width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    let textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!textBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    fireEvent.compositionStart(textBox)
    expect(screen.getByLabelText('Resize text box right')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Shapes' }))
    const menuItems = mocks.showMenu.mock.calls.at(-1)?.[0] as Array<
      { id?: string; onAction?: () => void } | string
    >
    const insertRectangle = menuItems.find(
      (item) => typeof item !== 'string' && item.id === 'insert-rectangle'
    ) as { onAction?: () => void } | undefined
    act(() => insertRectangle?.onAction?.())

    expect(session.getSnapshot().renderedDocument.slides[slideId].elementOrder).toEqual([text.id])
    expect(screen.getByLabelText('Resize text box right')).toBeInTheDocument()
  })

  it('rebases pending text before New Slide and keyboard nudge mutations', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', x: 20, y: 20, width: 120, height: 40 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(sourceDocument, slideId, text),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    let textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!textBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    textBox.textContent = 'Before New Slide'
    fireEvent.input(textBox)
    const newSlide = screen.getByRole('button', { name: 'New Slide' })
    newSlide.focus()
    fireEvent.blur(textBox)
    fireEvent.click(newSlide)
    act(() => flushAnimationFrame())

    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      text: 'Before New Slide'
    })
    expect(session.getSnapshot().renderedDocument.slideOrder).toHaveLength(2)

    await act(async () => {
      usePresentationWorkspaceStore.getState().setActiveSlideId('deck-1', slideId)
    })
    let returnedTextBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!returnedTextBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(returnedTextBox, { clientX: 40, clientY: 20, pointerId: 2 })
    returnedTextBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    returnedTextBox.textContent = 'Before Nudge'
    fireEvent.input(returnedTextBox)
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    act(() => flushAnimationFrame())

    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      text: 'Before Nudge',
      x: 25
    })
  })

  it.each([
    ['activation', 'activate', true],
    ['close save', 'close', true],
    ['close discard', 'discard', false],
    ['flush all', 'flushAll', true]
  ] as const)('finalizes live pending text before %s', async (_label, action, persists) => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
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
    textBox.textContent = 'Final before boundary'
    fireEvent.input(textBox)

    if (action === 'activate') {
      const secondItem = makeEditableItem('deck-2', 'Second.lpdeck')
      useFileExplorerStore.setState((state) => ({
        items: { ...state.items, [secondItem.id]: secondItem },
        _itemsArray: [...state._itemsArray, secondItem]
      }))
      await act(async () => {
        await registry!.open(secondItem)
        await registry!.activate(secondItem.id)
      })
    } else if (action === 'flushAll') {
      await act(async () => {
        await registry!.flushAll()
      })
    } else {
      await act(async () => {
        await registry!.close('deck-1', action === 'discard' ? 'discard' : undefined)
      })
    }
    const persistedBeforeFrame = mocks.persistEditablePresentationRevision.mock.calls.length
    act(() => flushAnimationFrame())

    if (persists) {
      expect(mocks.persistEditablePresentationRevision).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'deck-1',
          document: expect.objectContaining({
            slides: expect.objectContaining({
              [slideId]: expect.objectContaining({
                elements: expect.objectContaining({
                  [text.id]: expect.objectContaining({ text: 'Final before boundary' })
                })
              })
            })
          })
        })
      )
    } else {
      expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
    }
    if (action === 'flushAll') {
      expect(mocks.persistEditablePresentationRevision).toHaveBeenCalledTimes(persistedBeforeFrame)
    }
  })

  it('finalizes pending text before direct slide switching and deletes without a later frame write', async () => {
    const flushAnimationFrame = mockAnimationFrame()
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const slideId = sourceDocument.slideOrder[0]
    const text = createTextElement({ text: 'Before', width: 120, height: 40 })
    const withText = addElementToSlide(sourceDocument, slideId, text)
    const { document, slideId: secondSlideId } = insertBlankEditableSlide(withText, 1)
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document, revision: 0 })
    const session = await renderWorkspaceSession()
    let textBox = globalThis.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!textBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(textBox, { clientX: 40, clientY: 20, pointerId: 1 })
    textBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    textBox.textContent = 'Before switch'
    fireEvent.input(textBox)
    fireEvent.click(screen.getByRole('option', { name: '2' }))
    act(() => flushAnimationFrame())

    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toMatchObject({
      text: 'Before switch'
    })
    expect(usePresentationWorkspaceStore.getState().getActiveSlideId('deck-1')).toBe(secondSlideId)

    fireEvent.click(screen.getByRole('option', { name: '1Before switch' }))
    let returnedTextBox = globalThis.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content]'
    )
    if (!returnedTextBox) throw new Error('presentation text box not found')
    fireEvent.pointerDown(returnedTextBox, { clientX: 40, clientY: 20, pointerId: 2 })
    returnedTextBox = window.document.querySelector<HTMLElement>(
      '.presentation-stage [data-text-content][contenteditable="true"]'
    )!
    returnedTextBox.textContent = 'Delete me'
    fireEvent.input(returnedTextBox)
    fireEvent.keyDown(globalThis.document, { key: 'Delete' })
    act(() => flushAnimationFrame())

    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[text.id]).toBeUndefined()
  })
})
