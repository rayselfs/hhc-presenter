import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import PresentationWorkspaceHeader from '../PresentationWorkspaceHeader'
import { ShortcutScopeProvider } from '@renderer/contexts/ShortcutScopeContext'
import {
  createBlankEditablePresentationDocument,
  insertBlankEditableSlide
} from '@renderer/lib/editable-presentation'
import { EDITABLE_PRESENTATION_MIME_TYPE } from '@renderer/lib/presentation-media'
import type {
  PresentationEditorSession,
  PresentationSessionSnapshot
} from '@renderer/lib/presentation-editor-session'
import type { PresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import type { FileItemRecord } from '@shared/types/folder'
import type {
  PresentationReadinessReport,
  PresentationReadinessStatus
} from '@renderer/lib/presentation-readiness'

const mocks = vi.hoisted(() => ({
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

function makeEditableItem(id = 'deck-1'): FileItemRecord {
  return {
    id,
    parentId: 'file-root',
    type: 'file',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    name: 'Sunday.lpdeck',
    url: `blob:${id}`,
    size: 1024,
    mimeType: EDITABLE_PRESENTATION_MIME_TYPE
  }
}

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
