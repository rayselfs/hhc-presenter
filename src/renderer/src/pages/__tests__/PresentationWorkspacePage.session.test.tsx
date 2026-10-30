import userEvent from '@testing-library/user-event'
import {
  mocks,
  deferImageDecode,
  Workspace,
  setupWorkspaceSessionTest,
  renderWorkspaceSession,
  cleanupWorkspaceSessionTest
} from '@renderer/test/presentation-workspace-session-harness'
import { makeEditableItem } from '@renderer/test/presentation-fixtures'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PresentationElectronCloseBridge from '@renderer/contexts/PresentationElectronCloseBridge'
import {
  PresentationSessionRegistryProvider,
  type PresentationSessionRegistry
} from '@renderer/contexts/PresentationSessionRegistryContext'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createTextElement,
  createShapeElement,
  insertBlankEditableSlide,
  removeEditableSlides
} from '@renderer/lib/editable-presentation'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import type { FileItemRecord } from '@shared/types/folder'

describe('PresentationWorkspacePage session contract', () => {
  beforeEach(setupWorkspaceSessionTest)
  afterEach(cleanupWorkspaceSessionTest)
  it.each([false, true])(
    'isolates a failed document from the next session (already open: %s)',
    async (alreadyOpen) => {
      const next = makeEditableItem('deck-2', 'Healthy.lpdeck')
      const document = createBlankEditablePresentationDocument('Healthy')
      mocks.loadEditablePresentationSnapshot.mockImplementation(async (item: FileItemRecord) => {
        if (item.id === 'deck-1') throw new Error('Broken first document')
        return { document, revision: 0 }
      })
      useFileExplorerStore.setState((state) => ({ items: { ...state.items, [next.id]: next } }))
      let registry: PresentationSessionRegistry | null = null
      render(
        <PresentationSessionRegistryProvider>
          <Workspace showPage onSession={(value) => (registry = value)} />
        </PresentationSessionRegistryProvider>
      )
      await screen.findByText('Broken first document')
      if (alreadyOpen)
        await act(async () => {
          await registry!.open(next)
        })
      const existing = registry!.get(next.id)
      act(() => usePresentationWorkspaceStore.getState().openDocument(next))
      await screen.findByTestId('presentation-ribbon-frame')
      expect(screen.queryByText('Broken first document')).toBeNull()
      if (existing) expect(registry!.get(next.id)).toBe(existing)
    }
  )

  it('renders the same registry session after the routed view remounts', async () => {
    let registry: PresentationSessionRegistry | null = null
    const { rerender } = render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry!.get('deck-1')).toBeDefined())
    const session = registry!.get('deck-1')!
    const document = session.getSnapshot().renderedDocument
    const slideId = document.slideOrder[0]
    const text = createTextElement({ text: 'Unsaved local text' })
    act(() => session.commit(addElementToSlide(document, slideId, text)))

    expect(await screen.findAllByText('Unsaved local text')).not.toHaveLength(0)

    rerender(
      <PresentationSessionRegistryProvider>
        <Workspace showPage={false} onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    rerender(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )

    expect(await screen.findAllByText('Unsaved local text')).not.toHaveLength(0)
    expect(mocks.loadEditablePresentationSnapshot).toHaveBeenCalledTimes(1)
  })

  it('drops a deferred image decode after its document session closes', async () => {
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    const decode = deferImageDecode()
    try {
      const input = globalThis.document.querySelector<HTMLInputElement>('input[type="file"]')
      if (!input) throw new Error('image file input not found')
      fireEvent.change(input, {
        target: { files: [new File(['image'], 'late.png', { type: 'image/png' })] }
      })

      await act(async () => {
        await registry!.close('deck-1')
      })
      await act(async () => {
        await decode.resolve()
      })

      expect(registry!.get('deck-1')).toBeUndefined()
      expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
    } finally {
      decode.restore()
    }
  })

  it('drops a deferred image decode when its target slide was deleted', async () => {
    const initialDocument = createBlankEditablePresentationDocument('Sunday')
    const { document: sourceDocument } = insertBlankEditableSlide(initialDocument, 1)
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
    await waitFor(() => expect(registry?.get('deck-1')).toBeDefined())
    const session = registry!.get('deck-1')!
    const targetSlideId = session.getSnapshot().renderedDocument.slideOrder[0]
    const decode = deferImageDecode()
    try {
      const input = globalThis.document.querySelector<HTMLInputElement>('input[type="file"]')
      if (!input) throw new Error('image file input not found')
      fireEvent.change(input, {
        target: { files: [new File(['image'], 'late.png', { type: 'image/png' })] }
      })
      act(() => {
        session.commit(
          removeEditableSlides(session.getSnapshot().renderedDocument, [targetSlideId])
        )
      })
      mocks.persistEditablePresentationRevision.mockClear()

      await act(async () => {
        await decode.resolve()
      })

      expect(session.getSnapshot().renderedDocument.slides[targetSlideId]).toBeUndefined()
      expect(session.getSnapshot().renderedDocument.assets).toEqual({})
      expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
    } finally {
      decode.restore()
    }
  })

  it('keeps committed Notes in session history across Undo and Redo', async () => {
    const sourceDocument = createBlankEditablePresentationDocument('Sunday')
    const { document, slideId: secondSlideId } = insertBlankEditableSlide(sourceDocument, 1)
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document, revision: 0 })
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )

    await waitFor(() => expect(registry!.get('deck-1')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Remember the closing prayer' }
    })
    fireEvent.click(screen.getByRole('option', { name: '2' }))

    const session = registry!.get('deck-1')!
    const firstSlideId = document.slideOrder[0]
    expect(session.getSnapshot().renderedDocument.slides[firstSlideId].notes).toBe(
      'Remember the closing prayer'
    )
    expect(usePresentationWorkspaceStore.getState().getActiveSlideId('deck-1')).toBe(secondSlideId)

    fireEvent.click(screen.getByRole('option', { name: '1' }))
    act(() => session.undo())
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('')
    act(() => session.redo())
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue(
      'Remember the closing prayer'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    const historyLength = session.getSnapshot().history.past.length
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    expect(session.getSnapshot().history.past).toHaveLength(historyLength)
  })

  it('cancels a reverted Notes draft before route unmount without undo or save work', async () => {
    let registry: PresentationSessionRegistry | null = null
    const { rerender } = render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry!.get('deck-1')).toBeDefined())
    const session = registry!.get('deck-1')!
    const initialHistoryLength = session.getSnapshot().history.past.length
    const initialScheduledRevision = session.getSnapshot().save.scheduledRevision

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    const notes = screen.getByRole('textbox', { name: 'Notes' })
    fireEvent.change(notes, { target: { value: 'Temporary note' } })
    expect(session.getSnapshot().draftKind).toBe('notes')
    fireEvent.change(notes, { target: { value: '' } })

    expect(session.getSnapshot().draftKind).toBeNull()
    rerender(
      <PresentationSessionRegistryProvider>
        <Workspace showPage={false} onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    expect(session.getSnapshot().history.past).toHaveLength(initialHistoryLength)
    expect(session.getSnapshot().save.scheduledRevision).toBe(initialScheduledRevision)
    expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
  })

  it('flushes a focused Notes draft before registry activation and close', async () => {
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry!.get('deck-1')).toBeDefined())
    const session = registry!.get('deck-1')!
    const firstSlideId = session.getSnapshot().renderedDocument.slideOrder[0]
    const secondItem = makeEditableItem('deck-2', 'Sermon.lpdeck')
    useFileExplorerStore.setState((state) => ({
      items: { ...state.items, [secondItem.id]: secondItem },
      _itemsArray: [...state._itemsArray, secondItem]
    }))
    await act(async () => {
      await registry!.open(secondItem)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Updated before activation' }
    })
    expect(session.getSnapshot().draftKind).toBe('notes')
    expect(registry!.hasUnsafeWork()).toBe(true)
    await act(async () => {
      await registry!.activate(secondItem.id)
    })

    expect(mocks.persistEditablePresentationRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'deck-1',
        document: expect.objectContaining({
          slides: expect.objectContaining({
            [firstSlideId]: expect.objectContaining({ notes: 'Updated before activation' })
          })
        })
      })
    )

    await act(async () => {
      await registry!.activate('deck-1')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Updated before close' }
    })
    await act(async () => {
      await registry!.close('deck-1')
    })
    expect(mocks.persistEditablePresentationRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'deck-1',
        document: expect.objectContaining({
          slides: expect.objectContaining({
            [firstSlideId]: expect.objectContaining({ notes: 'Updated before close' })
          })
        })
      })
    )
  })

  it('flushes a focused Notes draft through the Electron app-close bridge', async () => {
    let registry: PresentationSessionRegistry | null = null
    let closeRequested: (() => void) | null = null
    const confirmClose = vi.fn().mockResolvedValue({ closing: true })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        app: {
          onCloseRequested: vi.fn((listener: () => void) => {
            closeRequested = listener
            return () => undefined
          }),
          confirmClose
        }
      } as unknown as Window['api']
    })
    render(
      <PresentationSessionRegistryProvider>
        <PresentationElectronCloseBridge />
        <Workspace showPage onSession={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await waitFor(() => expect(registry!.get('deck-1')).toBeDefined())
    const session = registry!.get('deck-1')!
    const firstSlideId = session.getSnapshot().renderedDocument.slideOrder[0]
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Notes' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Updated before app close' }
    })

    act(() => closeRequested?.())

    await waitFor(() => expect(confirmClose).toHaveBeenCalledTimes(1))
    expect(mocks.persistEditablePresentationRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'deck-1',
        document: expect.objectContaining({
          slides: expect.objectContaining({
            [firstSlideId]: expect.objectContaining({ notes: 'Updated before app close' })
          })
        })
      })
    )
  })
  it('offers all eight new presets only in an explicit v3 document', async () => {
    const source = createBlankEditablePresentationDocument('Shapes')
    source.schemaVersion = 3
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document: source, revision: 0 })
    const session = await renderWorkspaceSession()
    fireEvent.click(screen.getByRole('button', { name: 'Shapes' }))
    const items = mocks.showMenu.mock.calls.at(-1)?.[0] as Array<
      { id?: string; onAction?: () => void } | string
    >
    const presets = [
      'roundRect',
      'triangle',
      'rtTriangle',
      'diamond',
      'rightArrow',
      'leftArrow',
      'upArrow',
      'downArrow'
    ]
    for (const preset of presets) {
      const item = items.find((item) => typeof item !== 'string' && item.id === `insert-${preset}`)
      expect(item).toBeDefined()
      if (typeof item === 'string' || !item) throw new Error('Missing shape action')
      act(() => item.onAction?.())
      expect(
        window.document.querySelector(`.presentation-stage svg[data-shape-kind="${preset}"] path`)
      ).not.toBeNull()
    }
    expect(session.getSnapshot().renderedDocument.schemaVersion).toBe(3)
    expect(session.getSnapshot().history.past).toHaveLength(8)
    expect(mocks.startMediaProjection).not.toHaveBeenCalled()
  })

  it.each([1, 2] as const)('keeps the new preset menu gated for schema v%s', async (version) => {
    const source = createBlankEditablePresentationDocument('Legacy')
    source.schemaVersion = version
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document: source, revision: 0 })
    await renderWorkspaceSession()
    fireEvent.click(screen.getByRole('button', { name: 'Shapes' }))
    const items = mocks.showMenu.mock.calls.at(-1)?.[0] as Array<{ id?: string } | string>
    expect(
      items.filter((item) => typeof item !== 'string').map((item) => (item as { id?: string }).id)
    ).toEqual(['insert-rectangle', 'insert-ellipse', 'insert-line'])
  })

  it('edits a shape parameter through the numeric inspector and saves undo/redo state', async () => {
    const source = createBlankEditablePresentationDocument('Shapes')
    source.schemaVersion = 3
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document: source, revision: 0 })
    const session = await renderWorkspaceSession()
    fireEvent.click(screen.getByRole('button', { name: 'Shapes' }))
    const items = mocks.showMenu.mock.calls.at(-1)?.[0] as Array<
      { id?: string; onAction?: () => void } | string
    >
    const item = items.find((item) => typeof item !== 'string' && item.id === 'insert-roundRect')
    expect(item).toBeDefined()
    if (!item || typeof item === 'string') throw new Error('Missing rounded rectangle action')
    act(() => item.onAction?.())
    const input = screen.getByRole('spinbutton', { name: 'Corner radius (%)' })
    expect(input).toHaveValue(16.667)
    expect(input).toBeValid()
    expect(input).toHaveAttribute('max', '50')
    fireEvent.change(input, { target: { value: '25' } })
    const current = session.getSnapshot().renderedDocument
    const slideId = current.slideOrder[0]
    const elementId = current.slides[slideId].elementOrder[0]
    expect(current.slides[slideId].elements[elementId]).toMatchObject({
      type: 'shape',
      shape: 'roundRect',
      adjustments: [25000]
    })
    expect(session.getSnapshot().history.past).toHaveLength(2)
    act(() => session.undo())
    expect(screen.getByRole('spinbutton', { name: 'Corner radius (%)' })).toHaveValue(16.667)
    act(() => session.redo())
    expect(screen.getByRole('spinbutton', { name: 'Corner radius (%)' })).toHaveValue(25)
    await act(async () => {
      await session.flush()
    })
    expect(mocks.persistEditablePresentationRevision).toHaveBeenLastCalledWith(
      expect.objectContaining({ document: current })
    )
    expect(mocks.startMediaProjection).not.toHaveBeenCalled()
  })

  it('commits an adjustment drag as one undo entry in the real editor session', async () => {
    const source = createBlankEditablePresentationDocument('Shapes')
    source.schemaVersion = 3
    const slideId = source.slideOrder[0]
    const element = createShapeElement('triangle', { width: 200, height: 100, rotation: 90 })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(source, slideId, element),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const path = window.document.querySelector(
      '.presentation-stage svg[data-shape-kind="triangle"] path'
    )!
    fireEvent.click(path.closest('[data-slide-element]')!)
    const surface = path.closest('[data-slide-surface]')!
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 960, 540))
    const handle = screen.getByRole('button', { name: 'Adjust apex position' })
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 })
    for (let index = 1; index <= 25; index++)
      fireEvent.pointerMove(handle, { clientX: 100, clientY: 100 + index, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 100, clientY: 125, pointerId: 1 })
    expect(
      session.getSnapshot().renderedDocument.slides[slideId].elements[element.id]
    ).toMatchObject({ adjustments: [75000] })
    expect(session.getSnapshot().history.past).toHaveLength(1)
    act(() => session.undo())
    expect(
      session.getSnapshot().renderedDocument.slides[slideId].elements[element.id]
    ).not.toHaveProperty('adjustments')
    act(() => session.redo())
    expect(
      session.getSnapshot().renderedDocument.slides[slideId].elements[element.id]
    ).toMatchObject({ adjustments: [75000] })
  })

  it('detaches original source identity when pasting an adjusted shape', async () => {
    const source = createBlankEditablePresentationDocument('Shapes')
    source.schemaVersion = 3
    const slideId = source.slideOrder[0]
    const shape = {
      ...createShapeElement('triangle'),
      adjustments: [25000],
      pptxSourceNode: { id: '2', role: 'geometry' as const }
    }
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(source, slideId, shape),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    fireEvent.click(window.document.querySelector('.presentation-stage [data-slide-element]')!)
    fireEvent.keyDown(window.document.body, { key: 'c', code: 'KeyC', ctrlKey: true })
    fireEvent.keyDown(window.document.body, { key: 'v', code: 'KeyV', ctrlKey: true })
    const slide = session.getSnapshot().renderedDocument.slides[slideId]
    expect(slide.elementOrder).toHaveLength(2)
    const pasted = slide.elements[slide.elementOrder[1]]
    expect(pasted).toMatchObject({ shape: 'triangle', adjustments: [25000] })
    expect(pasted).not.toHaveProperty('pptxSourceNode')
    expect(slide.elements[shape.id]).toHaveProperty('pptxSourceNode')
  })

  it('warns and preserves a legacy document when its slide clipboard contains v3 shapes', async () => {
    const source = createBlankEditablePresentationDocument('Shapes')
    source.schemaVersion = 3
    const slideId = source.slideOrder[0]
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(source, slideId, createShapeElement('triangle')),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    const slideTab = window.document.querySelector<HTMLElement>('[data-slide-option]')!
    fireEvent.keyDown(slideTab, { key: 'c', code: 'KeyC', ctrlKey: true })
    const legacy = createBlankEditablePresentationDocument('Legacy')
    act(() => session.commit(legacy))
    const before = session.getSnapshot().history
    fireEvent.keyDown(window.document.querySelector<HTMLElement>('[data-slide-option]')!, {
      key: 'v',
      code: 'KeyV',
      ctrlKey: true
    })
    expect(session.getSnapshot().history).toBe(before)
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'These shapes cannot be pasted into this presentation yet.'
    )
  })

  it('preserves the original document when an adjustment is already clamped', async () => {
    const source = createBlankEditablePresentationDocument('Shapes')
    source.schemaVersion = 3
    const slideId = source.slideOrder[0]
    const shape = { ...createShapeElement('triangle'), adjustments: [100000] }
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(source, slideId, shape),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    fireEvent.click(window.document.querySelector('.presentation-stage [data-slide-element]')!)
    const before = session.getSnapshot().history
    const handle = screen.getByRole('button', { name: 'Adjust apex position' })
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 140, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(session.getSnapshot().history).toBe(before)
    expect(mocks.persistEditablePresentationRevision).not.toHaveBeenCalled()
  })

  it('keeps integer precision and keyboard access for an arrow with an out-of-range raw parameter', async () => {
    const source = createBlankEditablePresentationDocument('Shapes')
    source.schemaVersion = 3
    const slideId = source.slideOrder[0]
    const shape = {
      ...createShapeElement('rightArrow', { width: 333, height: 220 }),
      adjustments: [25000, 2147483647]
    }
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(source, slideId, shape),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    fireEvent.click(window.document.querySelector('.presentation-stage [data-slide-element]')!)
    const head = screen.getByRole('spinbutton', { name: 'Arrowhead length (%)' })
    expect(head).toHaveValue(151.364)
    expect(head).toBeValid()
    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[shape.id]).toMatchObject(
      { adjustments: [25000, 2147483647] }
    )
    const input = screen.getByRole('spinbutton', { name: 'Shaft width (%)' })
    const user = userEvent.setup()
    await user.click(input)
    await user.keyboard('{Control>}a{/Control}30')
    expect(input).toHaveValue(30)
    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[shape.id]).toMatchObject(
      { adjustments: [30000, 2147483647] }
    )
    expect(mocks.startMediaProjection).not.toHaveBeenCalled()
  })

  it('opens shape parameters in the compact inspector without opening the background panel', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === '(max-width: 1279px)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    }))
    const source = createBlankEditablePresentationDocument('Compact shapes')
    source.schemaVersion = 3
    const slideId = source.slideOrder[0]
    const shape = createShapeElement('roundRect', { adjustments: [30000] })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: addElementToSlide(source, slideId, shape),
      revision: 0
    })
    const session = await renderWorkspaceSession()
    fireEvent.click(window.document.querySelector('.presentation-stage [data-slide-element]')!)
    fireEvent.click(screen.getByRole('button', { name: 'Shape parameters' }))
    const dialog = screen.getByRole('dialog', { name: 'Shape parameters' })
    const input = within(dialog).getByRole('spinbutton', { name: 'Corner radius (%)' })
    expect(input).toHaveValue(30)
    fireEvent.change(input, { target: { value: '25' } })
    expect(session.getSnapshot().renderedDocument.slides[slideId].elements[shape.id]).toMatchObject(
      { adjustments: [25000] }
    )
    expect(within(dialog).queryByText('Format Background')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close Shape parameters' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
