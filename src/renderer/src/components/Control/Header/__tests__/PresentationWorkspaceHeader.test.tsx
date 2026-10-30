import { makeEditableItem } from '@renderer/test/presentation-fixtures'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import PresentationWorkspaceHeader from '../PresentationWorkspaceHeader'
import { ShortcutScopeProvider } from '@renderer/contexts/ShortcutScopeContext'
import {
  createBlankEditablePresentationDocument,
  createTextElement,
  insertBlankEditableSlide
} from '@renderer/lib/editable-presentation'
import type {
  PresentationEditorSession,
  PresentationSessionSnapshot
} from '@renderer/lib/presentation-editor-session'
import type { PresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { PptxExportError } from '@renderer/lib/pptx-export-drawingml'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import type { FileItemRecord } from '@shared/types/folder'
import type {
  PresentationReadinessReport,
  PresentationReadinessStatus
} from '@renderer/lib/presentation-readiness'

const mocks = vi.hoisted(() => ({
  exportPresentationPptx: vi.fn(),
  navigate: vi.fn(),
  registry: null as PresentationSessionRegistry | null,
  requestCloseDecision: vi.fn(),
  openFileExplorerDB: vi.fn(),
  loadEditablePresentation: vi.fn(),
  startMediaProjection: vi.fn(),
  stopProjectionSession: vi.fn(),
  toastDanger: vi.fn(),
  isProjectionOpen: false,
  ensureProjectionOpen: vi.fn(() => Promise.resolve()),
  stopProjection: vi.fn()
}))

vi.mock('@renderer/lib/pptx-export', async () => {
  const actual = await vi.importActual<typeof import('@renderer/lib/pptx-export-drawingml')>(
    '@renderer/lib/pptx-export-drawingml'
  )
  return {
    exportPresentationPptx: mocks.exportPresentationPptx,
    PptxExportError: actual.PptxExportError
  }
})

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next')
  return {
    ...actual,
    useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key })
  }
})

vi.mock('@heroui/react/toast', () => ({
  toast: { danger: mocks.toastDanger, warning: vi.fn() }
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mocks.navigate }
})

vi.mock('@renderer/contexts/ProjectionContext', () => ({
  useProjection: () => ({
    isProjectionOpen: mocks.isProjectionOpen,
    ensureProjectionOpen: mocks.ensureProjectionOpen,
    stopProjection: mocks.stopProjection
  })
}))

vi.mock('@renderer/contexts/PresentationSessionRegistryContext', async () => {
  const actual = await vi.importActual<
    typeof import('@renderer/contexts/PresentationSessionRegistryContext')
  >('@renderer/contexts/PresentationSessionRegistryContext')
  return {
    ...actual,
    usePresentationSessionRegistry: () => mocks.registry
  }
})

vi.mock('@renderer/contexts/PresentationCloseDecisionContext', () => ({
  usePresentationCloseDecision: () => mocks.requestCloseDecision
}))

vi.mock('@renderer/lib/file-explorer-db', () => ({
  openFileExplorerDB: mocks.openFileExplorerDB
}))

vi.mock('@renderer/lib/editable-presentation', async () => {
  const actual = await vi.importActual<typeof import('@renderer/lib/editable-presentation')>(
    '@renderer/lib/editable-presentation'
  )
  return {
    ...actual,
    loadEditablePresentation: mocks.loadEditablePresentation
  }
})

vi.mock('@renderer/lib/projection-actions', () => ({
  startMediaProjection: mocks.startMediaProjection,
  stopProjectionSession: mocks.stopProjectionSession
}))

function makeReadinessReport(
  item: FileItemRecord,
  status: PresentationReadinessStatus,
  readyItems = 0
): PresentationReadinessReport {
  return {
    summary: {
      ready: (status === 'ready' ? 1 : 0) + readyItems,
      preparing: status === 'preparing' ? 1 : 0,
      unsupported: status === 'unsupported' ? 1 : 0,
      missing: status === 'missing' ? 1 : 0,
      failed: status === 'failed' ? 1 : 0
    },
    items: [
      {
        itemId: item.id,
        blobId: item.id,
        status,
        reason: `${status}-fixture`,
        support: 'native'
      },
      ...Array.from({ length: readyItems }, (_, index) => ({
        itemId: `other-ready-${index}`,
        blobId: `other-ready-${index}`,
        status: 'ready' as const,
        reason: 'ready-fixture',
        support: 'native' as const
      }))
    ]
  }
}

function createFakeSession(item: FileItemRecord): PresentationEditorSession {
  const blank = { ...createBlankEditablePresentationDocument('Sunday'), id: item.id }
  const document = insertBlankEditableSlide(blank, 1).document
  const snapshot: PresentationSessionSnapshot = {
    history: { past: [], present: document, future: [] },
    save: {
      status: 'saved',
      scheduledRevision: 0,
      persistedRevision: 0,
      error: null,
      mirrorWarnings: []
    },
    draftKind: null,
    renderedDocument: document
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    commit: vi.fn(),
    reflowText: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    beginDraft: vi.fn(),
    previewDraft: vi.fn(),
    commitDraft: vi.fn(),
    cancelDraft: vi.fn(),
    rename: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn(),
    discard: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn()
  }
}

function createRegistry(session: PresentationEditorSession): PresentationSessionRegistry {
  return {
    open: vi.fn().mockResolvedValue(session),
    get: vi.fn(() => session),
    activate: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(true),
    flushAll: vi.fn().mockResolvedValue(undefined),
    discardAll: vi.fn().mockResolvedValue(undefined),
    finalizeAndFlush: vi.fn(async () => {
      session.commitDraft()
      await session.flush()
      return session.getSnapshot().history.present
    }),
    undo: vi.fn(() => {
      session.undo()
      return true
    }),
    redo: vi.fn(() => {
      session.redo()
      return true
    }),
    hasLiveEditor: vi.fn(() => false),
    hasPendingEditorWork: vi.fn(() => false),
    hasComposingEditor: vi.fn(() => false),
    hasUnsafeWork: vi.fn(() => false),
    getUnsafeItemIds: vi.fn(() => []),
    subscribe: vi.fn(() => () => undefined)
  }
}

function renderHeader(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <ShortcutScopeProvider>
        <PresentationWorkspaceHeader />
      </ShortcutScopeProvider>
    </MemoryRouter>
  )
}

describe('PresentationWorkspaceHeader', () => {
  let item: FileItemRecord
  let session: PresentationEditorSession
  let db: {
    get: ReturnType<typeof vi.fn>
    getAllFromIndex: ReturnType<typeof vi.fn>
    put: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:export')
        static revokeObjectURL = vi.fn()
      }
    )
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    mocks.exportPresentationPptx.mockReset().mockResolvedValue(new Blob(['PPTX']))
    usePersonalSyncStore.setState({ activeOwnerId: null })
    item = makeEditableItem()
    session = createFakeSession(item)
    mocks.registry = createRegistry(session)
    mocks.requestCloseDecision.mockResolvedValue('keep-editing')
    mocks.isProjectionOpen = false
    db = {
      get: vi.fn().mockResolvedValue(item),
      getAllFromIndex: vi.fn().mockResolvedValue([item]),
      put: vi.fn().mockResolvedValue(undefined)
    }
    mocks.openFileExplorerDB.mockResolvedValue(db)
    mocks.startMediaProjection.mockResolvedValue(makeReadinessReport(item, 'ready'))
    useFileExplorerStore.setState({
      items: { [item.id]: item },
      _itemsArray: [item]
    })
    useMediaProjectionStore.getState().exit()
    usePresentationWorkspaceStore.setState({
      documents: [],
      activeItemId: null,
      activeSlideIdByItemId: {}
    })
    usePresentationWorkspaceStore.getState().openDocument(item)
    usePresentationWorkspaceStore.getState().updateEditorMetadata(item.id, {
      saveStatus: 'saved',
      mirrorWarnings: [],
      canUndo: false,
      canRedo: false
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('exports the finalized current document once with a safe filename and releases its object URL', async () => {
    const user = userEvent.setup()
    usePresentationWorkspaceStore
      .getState()
      .updateDocumentName(item.id, 'Worship/2026:<Sunday>.lpdeck')
    renderHeader()
    await user.click(screen.getByRole('button', { name: 'Export PPTX' }))
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce())
    expect(mocks.registry!.finalizeAndFlush).toHaveBeenCalledWith(item.id)
    expect(mocks.exportPresentationPptx).toHaveBeenCalledWith(session.getSnapshot().history.present)
    expect(session.commitDraft).toHaveBeenCalledOnce()
    expect(session.flush).toHaveBeenCalledOnce()
    const link = vi.mocked(HTMLAnchorElement.prototype.click).mock.contexts[0]
    if (!(link instanceof HTMLAnchorElement)) throw new Error('Download anchor missing')
    expect(link.download).toBe('Worship_2026__Sunday_.pptx')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:export')
    expect(mocks.startMediaProjection).not.toHaveBeenCalled()
    expect(mocks.stopProjectionSession).not.toHaveBeenCalled()
  })

  it('exports unsaved text after its editor finalizer commits the draft', async () => {
    usePresentationWorkspaceStore.getState().updateEditorMetadata(item.id, { isUnsaved: true })
    const text = createTextElement({ text: 'Finalized latest text' })
    vi.mocked(session.commitDraft).mockImplementation(() => {
      const snapshot = session.getSnapshot()
      const slide = snapshot.history.present.slides[snapshot.history.present.slideOrder[0]]
      slide.elements[text.id] = text
      slide.elementOrder.push(text.id)
    })
    renderHeader()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export PPTX' }))
    await waitFor(() => expect(mocks.exportPresentationPptx).toHaveBeenCalledOnce())
    const exported = mocks.exportPresentationPptx.mock.calls[0][0]
    expect(exported.slides[exported.slideOrder[0]].elements[text.id].text).toBe(
      'Finalized latest text'
    )
    expect(screen.getByRole('button', { name: 'Save' })).toBeVisible()
  })

  it('cancels a pending download when IME starts and ends before export completes', async () => {
    let finish!: (blob: Blob) => void
    mocks.exportPresentationPptx.mockReturnValue(
      new Promise<Blob>((resolve) => {
        finish = resolve
      })
    )
    renderHeader()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export PPTX' }))
    await waitFor(() => expect(mocks.exportPresentationPptx).toHaveBeenCalledOnce())
    act(() => {
      vi.mocked(mocks.registry!.hasComposingEditor!).mockReturnValue(true)
      for (const [listener] of vi.mocked(mocks.registry!.subscribe).mock.calls) listener()
      vi.mocked(mocks.registry!.hasComposingEditor!).mockReturnValue(false)
      for (const [listener] of vi.mocked(mocks.registry!.subscribe).mock.calls) listener()
    })
    await act(async () => finish(new Blob(['PPTX'])))
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Export PPTX' })).toBeEnabled()
  })

  it('releases the object URL when the platform download fails', async () => {
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(() => {
      throw new Error('Download blocked')
    })
    renderHeader()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export PPTX' }))
    await waitFor(() => expect(mocks.toastDanger).toHaveBeenCalledWith('Unable to export PPTX'))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:export')
    expect(screen.getByRole('button', { name: 'Export PPTX' })).toBeEnabled()
  })

  it('offers export only for an editable workspace with a live session', () => {
    usePresentationWorkspaceStore.getState().closeDocument(item.id)
    usePresentationWorkspaceStore.getState().openDocument({
      ...item,
      name: 'Original.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    })
    const view = renderHeader()
    expect(screen.queryByRole('button', { name: 'Export PPTX' })).not.toBeInTheDocument()
    view.unmount()
    usePresentationWorkspaceStore.getState().closeDocument(item.id)
    usePresentationWorkspaceStore.getState().openDocument(item)
    mocks.registry = { ...mocks.registry!, get: vi.fn(() => undefined) }
    renderHeader()
    expect(screen.getByRole('button', { name: 'Export PPTX' })).toBeDisabled()
  })

  it('disables export during IME composition and refuses a finalizer that returns null', async () => {
    mocks.registry = { ...mocks.registry!, hasComposingEditor: vi.fn(() => true) }
    const view = renderHeader()
    expect(screen.getByRole('button', { name: 'Export PPTX' })).toBeDisabled()
    view.unmount()
    mocks.registry = {
      ...mocks.registry!,
      hasComposingEditor: vi.fn(() => false),
      finalizeAndFlush: vi.fn().mockResolvedValue(null)
    }
    renderHeader()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export PPTX' }))
    await waitFor(() => expect(mocks.registry!.finalizeAndFlush).toHaveBeenCalledOnce())
    expect(mocks.exportPresentationPptx).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it.each(['flush', 'export'])('shows failure and never downloads when %s fails', async (step) => {
    if (step === 'flush') vi.mocked(session.flush).mockRejectedValue(new Error('quota exceeded'))
    else mocks.exportPresentationPptx.mockRejectedValue(new Error('Invalid package'))
    renderHeader()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export PPTX' }))
    await waitFor(() => expect(mocks.toastDanger).toHaveBeenCalledWith('Unable to export PPTX'))
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(mocks.startMediaProjection).not.toHaveBeenCalled()
  })

  it('reports a localized compatibility failure without displaying retained XML', async () => {
    mocks.exportPresentationPptx.mockRejectedValue(
      new PptxExportError([
        {
          code: 'source-conflict',
          message: '<opaque>private source XML</opaque>',
          slideId: session.getSnapshot().history.present.slideOrder[0]
        }
      ])
    )
    renderHeader()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export PPTX' }))
    await waitFor(() => expect(mocks.toastDanger).toHaveBeenCalled())
    expect(String(mocks.toastDanger.mock.calls[0][0])).not.toContain('private source')
    expect(String(mocks.toastDanger.mock.calls[0][0])).toContain('retained content')
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it('prevents a duplicate click while exporting', async () => {
    let finish!: (blob: Blob) => void
    mocks.exportPresentationPptx.mockReturnValue(
      new Promise<Blob>((resolve) => {
        finish = resolve
      })
    )
    renderHeader()
    const button = screen.getByRole('button', { name: 'Export PPTX' })
    const user = userEvent.setup()
    await user.click(button)
    await user.click(button)
    expect(button).toBeDisabled()
    expect(mocks.exportPresentationPptx).toHaveBeenCalledOnce()
    await act(async () => {
      finish(new Blob(['PPTX']))
    })
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce()
    expect(button).toBeEnabled()
  })

  it.each([
    'tab',
    'closed',
    'reopened',
    'account',
    'account-returned',
    'session',
    'composition',
    'unmount'
  ])('cancels a pending download after %s changes', async (change) => {
    let finish!: (blob: Blob) => void
    mocks.exportPresentationPptx.mockReturnValue(
      new Promise<Blob>((resolve) => {
        finish = resolve
      })
    )
    const view = renderHeader()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export PPTX' }))
    expect(mocks.exportPresentationPptx).toHaveBeenCalledOnce()
    act(() => {
      if (change === 'tab')
        usePresentationWorkspaceStore.getState().openDocument(makeEditableItem('deck-2'))
      if (change === 'reopened') {
        usePresentationWorkspaceStore.getState().closeDocument(item.id)
        usePresentationWorkspaceStore.getState().openDocument(item)
      }
      if (change === 'closed') usePresentationWorkspaceStore.getState().closeDocument(item.id)
      if (change === 'account' || change === 'account-returned')
        usePersonalSyncStore.setState({ activeOwnerId: 'different-owner' })
      if (change === 'account-returned') usePersonalSyncStore.setState({ activeOwnerId: null })
      if (change === 'session')
        vi.mocked(mocks.registry!.get).mockReturnValue(createFakeSession(item))
      if (change === 'composition')
        vi.mocked(mocks.registry!.hasComposingEditor!).mockReturnValue(true)
      if (change === 'unmount') view.unmount()
    })
    await act(async () => {
      finish(new Blob(['PPTX']))
    })
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(mocks.startMediaProjection).not.toHaveBeenCalled()
  })

  it('does not build a package when the tab changes during finalization', async () => {
    let finish!: (
      value: ReturnType<PresentationEditorSession['getSnapshot']>['history']['present']
    ) => void
    vi.mocked(mocks.registry!.finalizeAndFlush).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    renderHeader()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export PPTX' }))
    act(() => usePresentationWorkspaceStore.getState().openDocument(makeEditableItem('deck-2')))
    await act(async () => finish(session.getSnapshot().history.present))
    expect(mocks.exportPresentationPptx).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it('joins the active document tab to the ribbon surface without a bottom shadow', () => {
    renderHeader()

    const tab = screen.getByText('Sunday.lpdeck').closest('[role="button"]')
    expect(tab).toHaveClass('bg-surface', 'border-b-surface', '-mb-px')
    expect(tab).not.toHaveClass('shadow-sm')
  })

  it('runs session Undo and Redo with truthful disabled states', async () => {
    const user = userEvent.setup()
    const snapshot = session.getSnapshot()
    snapshot.history.past.push(snapshot.history.present)
    snapshot.history.future.push(snapshot.history.present)
    renderHeader()

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await user.click(screen.getByRole('button', { name: 'Redo' }))

    expect(session.undo).toHaveBeenCalledTimes(1)
    expect(session.redo).toHaveBeenCalledTimes(1)
  })

  it('keeps Undo and Redo disabled without an active session even when metadata is stale', () => {
    mocks.registry = { ...mocks.registry!, get: vi.fn(() => undefined) }
    usePresentationWorkspaceStore.getState().updateEditorMetadata(item.id, {
      canUndo: true,
      canRedo: true
    })
    renderHeader()

    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()
  })

  it('disables Redo for pending input and both history commands during composition', () => {
    const snapshot = session.getSnapshot()
    snapshot.history.future.push(snapshot.history.present)
    vi.mocked(mocks.registry!.hasPendingEditorWork!).mockReturnValue(true)
    const view = renderHeader()

    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()

    view.unmount()
    mocks.registry = {
      ...mocks.registry!,
      hasComposingEditor: vi.fn(() => true)
    }
    renderHeader()

    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()
  })

  it('shows save failure and retries the active session', async () => {
    const user = userEvent.setup()
    usePresentationWorkspaceStore.getState().updateEditorMetadata(item.id, {
      saveStatus: 'error',
      mirrorWarnings: ['thumbnail'],
      canUndo: false,
      canRedo: false
    })
    renderHeader()

    expect(screen.getByText('Save failed')).toBeInTheDocument()
    expect(screen.getByText('Preview needs repair')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry save' }))

    expect(session.retry).toHaveBeenCalledTimes(1)
  })

  it('flushes through the registry before activating another tab', async () => {
    const secondItem = makeEditableItem('deck-2')
    secondItem.name = 'Sermon.lpdeck'
    usePresentationWorkspaceStore.getState().openDocument(secondItem)
    usePresentationWorkspaceStore.getState().setActiveDocument(item.id)
    renderHeader()

    fireEvent.click(screen.getByText('Sermon.lpdeck'))

    await waitFor(() => expect(mocks.registry!.activate).toHaveBeenCalledWith(secondItem.id))
    expect(mocks.navigate).toHaveBeenCalledWith('/presentations/deck-2')
  })

  it('asks for a close decision after flush fails and can discard', async () => {
    vi.mocked(mocks.registry!.close).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    mocks.requestCloseDecision.mockResolvedValue('discard')
    const user = userEvent.setup()
    renderHeader()

    await user.click(screen.getByRole('button', { name: 'Close tab' }))

    await waitFor(() => {
      expect(mocks.requestCloseDecision).toHaveBeenCalledWith([item.id])
      expect(mocks.registry!.close).toHaveBeenLastCalledWith(item.id, 'discard')
    })
  })

  it('renames an editable document through its session and flushes before updating labels', async () => {
    const user = userEvent.setup()
    renderHeader()

    await user.dblClick(screen.getByText('Sunday.lpdeck'))
    const input = screen.getByRole('textbox', { name: 'Rename file' })
    await user.clear(input)
    await user.type(input, 'Worship')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(session.rename).toHaveBeenCalledWith('Worship', 'Worship.lpdeck')
      expect(session.flush).toHaveBeenCalledTimes(1)
    })
    expect(mocks.loadEditablePresentation).not.toHaveBeenCalled()
    expect(usePresentationWorkspaceStore.getState().documents[0].name).toBe('Worship.lpdeck')
  })

  it('does not start projection when the active session cannot flush', async () => {
    const user = userEvent.setup()
    vi.mocked(session.flush).mockRejectedValue(new Error('quota exceeded'))
    renderHeader()

    await user.click(screen.getByRole('button', { name: 'Start projection' }))

    await waitFor(() => expect(session.flush).toHaveBeenCalledTimes(1))
    expect(session.commitDraft).toHaveBeenCalledTimes(1)
    expect(mocks.startMediaProjection).not.toHaveBeenCalled()
    expect(useMediaProjectionStore.getState().isPresenting).toBe(false)
  })

  it('shows one round projection button and presents from the current slide', async () => {
    const user = userEvent.setup()
    const deckDocument = session.getSnapshot().history.present
    usePresentationWorkspaceStore.getState().setActiveSlideId(item.id, deckDocument.slideOrder[1])
    renderHeader()

    const button = screen.getByRole('button', { name: 'Start projection' })
    expect(button).toHaveClass('size-10', 'min-w-10', 'rounded-full', 'p-0')
    expect(button.closest('[role="group"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Present from Beginning' })).not.toBeInTheDocument()
    await user.click(button)

    await waitFor(() => {
      expect(mocks.startMediaProjection).toHaveBeenCalledWith([item], 0, expect.any(Object), {
        prioritizeStartItem: true,
        presentationState: { slideIndex: 1, slideCount: 2 }
      })
    })
    expect(session.commitDraft).toHaveBeenCalledTimes(1)
    expect(session.flush).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/media'))
  })

  it('aligns only document tabs to the bottom of the normal 56px header frame', () => {
    const { container } = renderHeader()

    const header = container.querySelector('header')
    expect(header).toHaveClass('h-14', 'items-center', 'px-2')
    expect(header?.querySelector('.mb-1')).toBeNull()
    expect(screen.getByText('Sunday.lpdeck').closest('[role="button"]')).toHaveClass('self-end')
    expect(screen.getByRole('button', { name: 'Start projection' })).toHaveClass(
      'size-10',
      'min-w-10'
    )
  })

  it('keeps the presentation editor open when the requested item failed', async () => {
    const user = userEvent.setup()
    mocks.startMediaProjection.mockResolvedValue(makeReadinessReport(item, 'failed', 1))
    renderHeader()

    await user.click(screen.getByRole('button', { name: 'Start projection' }))

    await waitFor(() => expect(mocks.startMediaProjection).toHaveBeenCalledTimes(1))
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('keeps the presentation editor open when no items are ready', async () => {
    const user = userEvent.setup()
    mocks.startMediaProjection.mockResolvedValue(makeReadinessReport(item, 'preparing'))
    renderHeader()

    await user.click(screen.getByRole('button', { name: 'Start projection' }))

    await waitFor(() => expect(mocks.startMediaProjection).toHaveBeenCalledTimes(1))
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('keeps the presentation editor open when projection start is rejected', async () => {
    const user = userEvent.setup()
    mocks.startMediaProjection.mockRejectedValue(new Error('projection unavailable'))
    renderHeader()

    await user.click(screen.getByRole('button', { name: 'Start projection' }))

    await waitFor(() => expect(mocks.startMediaProjection).toHaveBeenCalledTimes(1))
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.toastDanger).toHaveBeenCalledWith('Unable to save presentation')
  })

  it('stops an open projection from the same header button', async () => {
    const user = userEvent.setup()
    mocks.isProjectionOpen = true
    mocks.stopProjectionSession.mockResolvedValue(undefined)
    renderHeader()

    await user.click(screen.getByRole('button', { name: 'Stop projection' }))

    expect(mocks.stopProjectionSession).toHaveBeenCalledWith({
      stopProjection: mocks.stopProjection
    })
    expect(mocks.startMediaProjection).not.toHaveBeenCalled()
  })

  it('starts an original PPTX with F5 without an editable session', async () => {
    item = {
      ...item,
      name: 'Sunday.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    }
    db.get.mockResolvedValue(item)
    usePresentationWorkspaceStore.getState().closeDocument(item.id)
    usePresentationWorkspaceStore.getState().openDocument(item)
    usePresentationWorkspaceStore.getState().setSlideCount(item.id, 13)
    mocks.registry = { ...mocks.registry!, get: vi.fn(() => undefined) }
    renderHeader()
    fireEvent.keyDown(document, { code: 'F5', key: 'F5' })
    await waitFor(() =>
      expect(mocks.startMediaProjection).toHaveBeenCalledWith(
        [item],
        0,
        expect.any(Object),
        expect.objectContaining({ presentationState: { slideIndex: 0, slideCount: 13 } })
      )
    )
  })

  it('presents while a text box still has focus', async () => {
    renderHeader()
    const input = document.createElement('textarea')
    document.body.append(input)
    input.focus()
    fireEvent.keyDown(input, { code: 'F5', key: 'F5' })
    await waitFor(() => expect(mocks.startMediaProjection).toHaveBeenCalledOnce())
    input.remove()
  })

  it('uses F5 for beginning and Shift+F5 for the current slide', async () => {
    const deckDocument = session.getSnapshot().history.present
    usePresentationWorkspaceStore.getState().setActiveSlideId(item.id, deckDocument.slideOrder[1])
    renderHeader()

    fireEvent.keyDown(document, { code: 'F5', key: 'F5' })
    await waitFor(() => expect(mocks.startMediaProjection).toHaveBeenCalledTimes(1))
    expect(mocks.startMediaProjection).toHaveBeenLastCalledWith(
      [item],
      0,
      expect.any(Object),
      expect.objectContaining({ presentationState: { slideIndex: 0, slideCount: 2 } })
    )
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/media'))

    fireEvent.keyDown(document, { code: 'F5', key: 'F5', shiftKey: true })
    await waitFor(() => expect(mocks.startMediaProjection).toHaveBeenCalledTimes(2))
    expect(mocks.startMediaProjection).toHaveBeenLastCalledWith(
      [item],
      0,
      expect.any(Object),
      expect.objectContaining({ presentationState: { slideIndex: 1, slideCount: 2 } })
    )
  })

  it('keeps native text Undo while presentation shortcuts target the session', () => {
    const snapshot = session.getSnapshot()
    snapshot.history.past.push(snapshot.history.present)
    snapshot.history.future.push(snapshot.history.present)
    renderHeader()

    fireEvent.keyDown(document, { code: 'KeyZ', key: 'z', ctrlKey: true })
    fireEvent.keyDown(document, { code: 'KeyY', key: 'y', ctrlKey: true })
    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { code: 'KeyZ', key: 'z', ctrlKey: true })
    input.remove()

    expect(session.undo).toHaveBeenCalledTimes(1)
    expect(session.redo).toHaveBeenCalledTimes(1)
  })
})
