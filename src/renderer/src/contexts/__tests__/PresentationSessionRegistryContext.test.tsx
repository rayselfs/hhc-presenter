import { makeEditableItem as makeEditableFixture } from '@renderer/test/presentation-fixtures'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PresentationSessionRegistryProvider,
  usePresentationSessionRegistry,
  type PresentationSessionRegistry
} from '../PresentationSessionRegistryContext'
import {
  createBlankEditablePresentationDocument,
  type EditablePresentationDocument
} from '@renderer/lib/editable-presentation'
import type {
  PresentationEditorSession,
  PresentationSessionSnapshot
} from '@renderer/lib/presentation-editor-session'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import type { FileItemRecord } from '@shared/types/folder'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'

const mocks = vi.hoisted(() => ({
  loadEditablePresentationSnapshot: vi.fn(),
  createPresentationEditorSession: vi.fn()
}))

vi.mock('@renderer/lib/editable-presentation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/editable-presentation')>()
  return {
    ...actual,
    loadEditablePresentationSnapshot: mocks.loadEditablePresentationSnapshot
  }
})

vi.mock('@renderer/lib/presentation-editor-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/presentation-editor-session')>()
  return {
    ...actual,
    createPresentationEditorSession: mocks.createPresentationEditorSession
  }
})

function makeEditableItem(id: string): FileItemRecord {
  return makeEditableFixture(id, `${id}.lpdeck`)
}

function makeDocument(name: string, itemId: string): EditablePresentationDocument {
  return { ...createBlankEditablePresentationDocument(name), id: itemId }
}

function createFakeSession(
  document: EditablePresentationDocument,
  saveStatus: PresentationSessionSnapshot['save']['status'] = 'saved'
): PresentationEditorSession {
  const listeners = new Set<() => void>()
  const snapshot: PresentationSessionSnapshot = {
    history: { past: [], present: document, future: [] },
    save: {
      status: saveStatus,
      scheduledRevision: saveStatus === 'saved' ? 0 : 1,
      persistedRevision: 0,
      error: saveStatus === 'error' ? 'save failed' : null,
      mirrorWarnings: []
    },
    draftKind: null,
    renderedDocument: document
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    commit: vi.fn(),
    reflowText: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    beginDraft: vi.fn(),
    previewDraft: vi.fn(),
    commitDraft: vi.fn(),
    cancelDraft: vi.fn(),
    rename: vi.fn(),
    flush: vi.fn().mockImplementation(async () => {
      snapshot.save = {
        ...snapshot.save,
        status: 'saved',
        persistedRevision: snapshot.save.scheduledRevision,
        error: null
      }
    }),
    retry: vi.fn(),
    discard: vi.fn().mockImplementation(async () => {
      snapshot.draftKind = null
      snapshot.save = {
        ...snapshot.save,
        status: 'saved',
        scheduledRevision: snapshot.save.persistedRevision,
        error: null
      }
    }),
    dispose: vi.fn()
  }
}

function RegistryProbe({
  onRegistry,
  showChild = true
}: {
  onRegistry: (registry: PresentationSessionRegistry) => void
  showChild?: boolean
}): React.JSX.Element | null {
  onRegistry(usePresentationSessionRegistry())
  return showChild ? <div>routed child</div> : null
}

describe('PresentationSessionRegistryContext', () => {
  beforeEach(() => {
    usePersonalSyncStore.getState().setAccount('anonymous')
    mocks.loadEditablePresentationSnapshot.mockReset()
    mocks.createPresentationEditorSession.mockReset()
    usePresentationWorkspaceStore.setState({
      documents: [],
      activeItemId: null,
      activeSlideIdByItemId: {}
    })
  })

  it('hides departing personal tabs, flushes their session and rejects reopening from another account', async () => {
    usePersonalSyncStore.getState().setAccount('authenticated', 'alice', true)
    const item = { ...makeEditableItem('private-deck'), personalOwnerId: 'alice' }
    const document = makeDocument('Private', item.id)
    const session = createFakeSession(document)
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document, revision: 1 })
    mocks.createPresentationEditorSession.mockReturnValue(session)
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <RegistryProbe onRegistry={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await registry!.open(item)
    usePresentationWorkspaceStore.getState().openDocument(item)
    act(() => usePersonalSyncStore.getState().setAccount('authenticated', 'bob', true))
    expect(usePresentationWorkspaceStore.getState().documents).toEqual([])
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalled())
    await expect(registry!.open(item)).rejects.toThrow('Personal account changed')
  })

  it('returns one session when the same item is opened twice', async () => {
    const item = makeEditableItem('deck-1')
    const document = makeDocument('Sunday', item.id)
    const session = createFakeSession(document)
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document, revision: 4 })
    mocks.createPresentationEditorSession.mockReturnValue(session)
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <RegistryProbe onRegistry={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )

    const first = await registry!.open(item)
    const second = await registry!.open(item)

    expect(first).toBe(session)
    expect(second).toBe(session)
    expect(mocks.loadEditablePresentationSnapshot).toHaveBeenCalledTimes(1)
    expect(mocks.createPresentationEditorSession).toHaveBeenCalledTimes(1)
    expect(mocks.createPresentationEditorSession).toHaveBeenCalledWith(
      expect.objectContaining({ initialRevision: 4 })
    )
  })

  it('flushes the previous editable session before activating another tab', async () => {
    const firstItem = makeEditableItem('deck-1')
    const secondItem = makeEditableItem('deck-2')
    const firstSession = createFakeSession(makeDocument('First', firstItem.id), 'dirty')
    const secondSession = createFakeSession(makeDocument('Second', secondItem.id))
    mocks.loadEditablePresentationSnapshot
      .mockResolvedValueOnce({
        document: firstSession.getSnapshot().renderedDocument,
        revision: 0
      })
      .mockResolvedValueOnce({
        document: secondSession.getSnapshot().renderedDocument,
        revision: 0
      })
    mocks.createPresentationEditorSession
      .mockReturnValueOnce(firstSession)
      .mockReturnValueOnce(secondSession)
    usePresentationWorkspaceStore.getState().openDocument(firstItem)
    usePresentationWorkspaceStore.getState().openDocument(secondItem)
    usePresentationWorkspaceStore.getState().setActiveDocument(firstItem.id)
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <RegistryProbe onRegistry={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await registry!.open(firstItem)
    await registry!.open(secondItem)
    const finalize = vi.fn(() => true)
    registry!.registerEditorFinalizer!(firstItem.id, finalize)

    await expect(registry!.activate(secondItem.id)).resolves.toBe(true)

    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(firstSession.flush).mock.invocationCallOrder[0]
    )
    expect(firstSession.flush).toHaveBeenCalledTimes(1)
    expect(usePresentationWorkspaceStore.getState().activeItemId).toBe(secondItem.id)
  })

  it('treats pending live editor DOM as unsafe before a session draft exists', async () => {
    const item = makeEditableItem('deck-1')
    const session = createFakeSession(makeDocument('Sunday', item.id))
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: session.getSnapshot().renderedDocument,
      revision: 0
    })
    mocks.createPresentationEditorSession.mockReturnValue(session)
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <RegistryProbe onRegistry={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await registry!.open(item)
    let pending = true
    registry!.registerEditorFinalizer!(
      item.id,
      () => true,
      () => pending
    )

    expect(registry!.hasUnsafeWork()).toBe(true)
    expect(registry!.getUnsafeItemIds()).toEqual([item.id])
    pending = false
    expect(registry!.hasUnsafeWork()).toBe(false)
  })

  it('finalizes a live editor before preparing its current document for projection', async () => {
    const item = makeEditableItem('deck-1')
    const document = makeDocument('Sunday', item.id)
    const session = createFakeSession(document, 'dirty')
    session.getSnapshot().draftKind = 'text'
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document, revision: 0 })
    mocks.createPresentationEditorSession.mockReturnValue(session)
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <RegistryProbe onRegistry={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await registry!.open(item)
    const finalize = vi.fn(() => true)
    registry!.registerEditorFinalizer!(item.id, finalize)
    const finalizeAndFlush = (
      registry! as PresentationSessionRegistry & {
        finalizeAndFlush?: (itemId: string) => Promise<EditablePresentationDocument | null>
      }
    ).finalizeAndFlush

    expect(finalizeAndFlush).toBeTypeOf('function')
    if (!finalizeAndFlush) return
    await expect(finalizeAndFlush(item.id)).resolves.toBe(document)
    expect(finalize.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(session.commitDraft).mock.invocationCallOrder[0]
    )
    expect(vi.mocked(session.commitDraft).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(session.flush).mock.invocationCallOrder[0]
    )
  })

  it('keeps the previous tab active when its flush fails', async () => {
    const firstItem = makeEditableItem('deck-1')
    const secondItem = makeEditableItem('deck-2')
    const firstSession = createFakeSession(makeDocument('First', firstItem.id), 'dirty')
    vi.mocked(firstSession.flush).mockRejectedValue(new Error('save failed'))
    const secondSession = createFakeSession(makeDocument('Second', secondItem.id))
    mocks.loadEditablePresentationSnapshot
      .mockResolvedValueOnce({
        document: firstSession.getSnapshot().renderedDocument,
        revision: 0
      })
      .mockResolvedValueOnce({
        document: secondSession.getSnapshot().renderedDocument,
        revision: 0
      })
    mocks.createPresentationEditorSession
      .mockReturnValueOnce(firstSession)
      .mockReturnValueOnce(secondSession)
    usePresentationWorkspaceStore.getState().openDocument(firstItem)
    usePresentationWorkspaceStore.getState().openDocument(secondItem)
    usePresentationWorkspaceStore.getState().setActiveDocument(firstItem.id)
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <RegistryProbe onRegistry={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await registry!.open(firstItem)
    await registry!.open(secondItem)

    await expect(registry!.activate(secondItem.id)).resolves.toBe(false)

    expect(usePresentationWorkspaceStore.getState().activeItemId).toBe(firstItem.id)
  })

  it('retains the session and its history when a routed child unmounts', async () => {
    const item = makeEditableItem('deck-1')
    const document = makeDocument('Sunday', item.id)
    const session = createFakeSession(document)
    session.getSnapshot().history.past.push({ ...document, name: 'Before' })
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({ document, revision: 0 })
    mocks.createPresentationEditorSession.mockReturnValue(session)
    let registry: PresentationSessionRegistry | null = null
    const { rerender } = render(
      <PresentationSessionRegistryProvider>
        <RegistryProbe onRegistry={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await registry!.open(item)

    rerender(
      <PresentationSessionRegistryProvider>
        <RegistryProbe onRegistry={(next) => (registry = next)} showChild={false} />
      </PresentationSessionRegistryProvider>
    )

    expect(registry!.get(item.id)).toBe(session)
    expect(registry!.get(item.id)?.getSnapshot().history.past).toHaveLength(1)
  })

  it('flushes and disposes a session before closing its tab', async () => {
    const item = makeEditableItem('deck-1')
    const session = createFakeSession(makeDocument('Sunday', item.id))
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: session.getSnapshot().renderedDocument,
      revision: 0
    })
    mocks.createPresentationEditorSession.mockReturnValue(session)
    usePresentationWorkspaceStore.getState().openDocument(item)
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <RegistryProbe onRegistry={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await registry!.open(item)
    const finalize = vi.fn(() => true)
    registry!.registerEditorFinalizer!(item.id, finalize)

    await expect(registry!.close(item.id)).resolves.toBe(true)

    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(session.flush).mock.invocationCallOrder[0]
    )
    expect(session.flush).toHaveBeenCalledTimes(1)
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(registry!.get(item.id)).toBeUndefined()
    expect(usePresentationWorkspaceStore.getState().documents).toEqual([])
  })

  it('discards and disposes without flushing when explicitly requested', async () => {
    const item = makeEditableItem('deck-1')
    const session = createFakeSession(makeDocument('Sunday', item.id), 'error')
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: session.getSnapshot().renderedDocument,
      revision: 0
    })
    mocks.createPresentationEditorSession.mockReturnValue(session)
    usePresentationWorkspaceStore.getState().openDocument(item)
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <RegistryProbe onRegistry={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await registry!.open(item)
    const finalize = vi.fn(() => true)
    registry!.registerEditorFinalizer!(item.id, finalize)

    await expect(registry!.close(item.id, 'discard')).resolves.toBe(true)

    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(session.discard).mock.invocationCallOrder[0]
    )
    expect(session.discard).toHaveBeenCalledTimes(1)
    expect(session.flush).not.toHaveBeenCalled()
    expect(session.dispose).toHaveBeenCalledTimes(1)
  })

  it('rejects flushAll when an unsafe session cannot flush', async () => {
    const firstItem = makeEditableItem('deck-1')
    const secondItem = makeEditableItem('deck-2')
    const firstSession = createFakeSession(makeDocument('First', firstItem.id), 'dirty')
    const secondSession = createFakeSession(makeDocument('Second', secondItem.id), 'error')
    vi.mocked(secondSession.flush).mockRejectedValue(new Error('save failed'))
    mocks.loadEditablePresentationSnapshot
      .mockResolvedValueOnce({
        document: firstSession.getSnapshot().renderedDocument,
        revision: 0
      })
      .mockResolvedValueOnce({
        document: secondSession.getSnapshot().renderedDocument,
        revision: 0
      })
    mocks.createPresentationEditorSession
      .mockReturnValueOnce(firstSession)
      .mockReturnValueOnce(secondSession)
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <RegistryProbe onRegistry={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    await registry!.open(firstItem)
    await registry!.open(secondItem)

    await expect(registry!.flushAll()).rejects.toThrow('save failed')
    expect(firstSession.flush).toHaveBeenCalledTimes(1)
    expect(secondSession.flush).toHaveBeenCalledTimes(1)
    expect(registry!.getUnsafeItemIds()).toEqual([secondItem.id])
  })

  it('notifies subscribers when registry contents change', async () => {
    const item = makeEditableItem('deck-1')
    const session = createFakeSession(makeDocument('Sunday', item.id))
    mocks.loadEditablePresentationSnapshot.mockResolvedValue({
      document: session.getSnapshot().renderedDocument,
      revision: 0
    })
    mocks.createPresentationEditorSession.mockReturnValue(session)
    let registry: PresentationSessionRegistry | null = null
    render(
      <PresentationSessionRegistryProvider>
        <RegistryProbe onRegistry={(next) => (registry = next)} />
      </PresentationSessionRegistryProvider>
    )
    const listener = vi.fn()
    registry!.subscribe(listener)

    await act(() => registry!.open(item))

    expect(listener).toHaveBeenCalledTimes(1)
  })
})
