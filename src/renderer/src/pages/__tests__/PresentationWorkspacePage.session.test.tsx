import {
  mocks,
  deferImageDecode,
  Workspace,
  setupWorkspaceSessionTest,
  cleanupWorkspaceSessionTest
} from '@renderer/test/presentation-workspace-session-harness'
import { makeEditableItem } from '@renderer/test/presentation-fixtures'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
})
