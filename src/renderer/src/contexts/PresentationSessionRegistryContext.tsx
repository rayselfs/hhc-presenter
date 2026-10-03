import {
  discardPresentationDraft,
  savePresentationDraft,
  PRESENTATION_DRAFT_PARENT
} from '@renderer/lib/presentation-drafts'
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { getBlobId } from '@renderer/lib/blob-identity'
import type { EditablePresentationDocument } from '@renderer/lib/editable-presentation'
import type { PresentationEditorSession } from '@renderer/lib/presentation-editor-session'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import type { FileItemRecord } from '@shared/types/folder'
import { isPersonalRecordVisible, usePersonalSyncStore } from '@renderer/stores/personal-sync'

export type CloseDecision = 'keep-editing' | 'retry' | 'discard'

export interface PresentationSessionRegistry {
  open(item: FileItemRecord): Promise<PresentationEditorSession>
  get(itemId: string): PresentationEditorSession | undefined
  finalizeAndFlush(itemId: string): Promise<EditablePresentationDocument | null>
  activate(itemId: string): Promise<boolean>
  close(itemId: string, decision?: CloseDecision): Promise<boolean>
  checkpointAll?(): Promise<void>
  saveDraft?(itemId: string, parentId: string, name: string): Promise<void>
  flushAll(): Promise<void>
  discardAll(): Promise<void>
  undo?(itemId: string): boolean
  redo?(itemId: string): boolean
  hasLiveEditor?(itemId: string): boolean
  hasPendingEditorWork?(itemId: string): boolean
  hasComposingEditor?(itemId: string): boolean
  notifyEditorLifecycle?(itemId: string): void
  hasUnsafeWork(): boolean
  getUnsafeItemIds(): string[]
  subscribe(listener: () => void): () => void
  registerEditorFinalizer?(
    itemId: string,
    finalize: () => boolean,
    hasUnsafeWork?: () => boolean,
    hasLiveEditor?: () => boolean,
    hasComposing?: () => boolean
  ): () => void
}

const PresentationSessionRegistryContext = createContext<PresentationSessionRegistry | null>(null)

function isSessionUnsafe(session: PresentationEditorSession): boolean {
  const snapshot = session.getSnapshot()
  return snapshot.draftKind !== null || snapshot.save.status !== 'saved'
}

export function PresentationSessionRegistryProvider({
  children
}: {
  children: ReactNode
}): React.JSX.Element {
  const sessionItemsRef = useRef(new Map<string, FileItemRecord>())
  const draftIdsRef = useRef(new Set<string>())
  const sessionsRef = useRef(new Map<string, PresentationEditorSession>())
  const openingRef = useRef(new Map<string, Promise<PresentationEditorSession>>())
  const sessionUnsubscribersRef = useRef(new Map<string, () => void>())
  const editorFinalizersRef = useRef(
    new Map<
      string,
      {
        finalize: () => boolean
        hasUnsafeWork: () => boolean
        hasLiveEditor: () => boolean
        hasComposing: () => boolean
      }
    >()
  )
  const listenersRef = useRef(new Set<() => void>())

  const registry = useMemo<PresentationSessionRegistry>(() => {
    const notify = (): void => {
      for (const listener of listenersRef.current) listener()
    }

    const publishSessionMetadata = (itemId: string, session: PresentationEditorSession): void => {
      const snapshot = session.getSnapshot()
      usePresentationWorkspaceStore.getState().updateEditorMetadata(itemId, {
        isUnsaved: draftIdsRef.current.has(itemId),
        saveStatus: snapshot.save.status,
        mirrorWarnings: snapshot.save.mirrorWarnings,
        canUndo: snapshot.history.past.length > 0,
        canRedo: snapshot.history.future.length > 0
      })
    }

    const open = async (item: FileItemRecord): Promise<PresentationEditorSession> => {
      if (!isPersonalRecordVisible(item)) throw new Error('Personal account changed')
      const existing = sessionsRef.current.get(item.id)
      if (existing) return existing
      const opening = openingRef.current.get(item.id)
      if (opening) return opening

      const promise = (async () => {
        const [
          { loadEditablePresentationSnapshot },
          { persistEditablePresentationRevision, refreshEditablePresentationThumbnail },
          { createPresentationEditorSession }
        ] = await Promise.all([
          import('@renderer/lib/editable-presentation'),
          import('@renderer/lib/editable-presentation-persistence'),
          import('@renderer/lib/presentation-editor-session')
        ])
        const { document, revision } = await loadEditablePresentationSnapshot(item)
        if (!isPersonalRecordVisible(item)) throw new Error('Personal account changed')
        if (item.parentId === PRESENTATION_DRAFT_PARENT) draftIdsRef.current.add(item.id)
        const session = createPresentationEditorSession({
          initialDocument: document,
          initialRevision: revision,
          persist: (request) =>
            persistEditablePresentationRevision({
              ...request,
              itemId: item.id,
              sourceBlobId: getBlobId(item)
            }),
          refreshThumbnail: refreshEditablePresentationThumbnail
        })
        sessionsRef.current.set(item.id, session)
        sessionItemsRef.current.set(item.id, item)
        publishSessionMetadata(item.id, session)
        sessionUnsubscribersRef.current.set(
          item.id,
          session.subscribe(() => {
            publishSessionMetadata(item.id, session)
            notify()
          })
        )
        notify()
        return session
      })()
      openingRef.current.set(item.id, promise)
      try {
        return await promise
      } finally {
        openingRef.current.delete(item.id)
      }
    }

    const getUnsafeItemIds = (): string[] => [
      ...new Set([
        ...usePresentationWorkspaceStore
          .getState()
          .documents.filter((entry) => entry.isUnsaved && isPersonalRecordVisible(entry))
          .map((entry) => entry.itemId),
        ...[...sessionsRef.current.entries()]
          .filter(
            ([itemId, session]) =>
              isPersonalRecordVisible(sessionItemsRef.current.get(itemId) ?? {}) &&
              (draftIdsRef.current.has(itemId) ||
                isSessionUnsafe(session) ||
                editorFinalizersRef.current.get(itemId)?.hasUnsafeWork())
          )
          .map(([itemId]) => itemId)
      ])
    ]

    const finalizeEditor = (itemId: string): boolean =>
      editorFinalizersRef.current.get(itemId)?.finalize() ?? true

    const moveHistory = (itemId: string, direction: 'undo' | 'redo'): boolean => {
      const session = sessionsRef.current.get(itemId)
      if (!session || !finalizeEditor(itemId)) return false
      session[direction]()
      return true
    }

    const finalizeAndFlush = async (
      itemId: string
    ): Promise<EditablePresentationDocument | null> => {
      const session = sessionsRef.current.get(itemId)
      if (!session || !finalizeEditor(itemId)) return null
      if (session.getSnapshot().draftKind !== null) session.commitDraft()
      if (isSessionUnsafe(session)) await session.flush()
      return session.getSnapshot().history.present
    }

    const checkpointAll = async (): Promise<void> => {
      await Promise.all(openingRef.current.values())
      for (const itemId of sessionsRef.current.keys()) {
        if (!isPersonalRecordVisible(sessionItemsRef.current.get(itemId) ?? {})) continue
        if (!finalizeEditor(itemId)) throw new Error('Text composition is still active')
        await sessionsRef.current.get(itemId)!.flush()
      }
    }

    return {
      open,
      checkpointAll,
      saveDraft: async (itemId, parentId, name) => {
        const session = sessionsRef.current.get(itemId)
        if (!session || !finalizeEditor(itemId)) throw new Error('Presentation is not ready')
        session.commitDraft()
        session.rename(name.trim(), name.trim())
        await session.flush()
        const item = await savePresentationDraft(itemId, parentId, name)
        draftIdsRef.current.delete(itemId)
        sessionItemsRef.current.set(itemId, item)
        usePresentationWorkspaceStore.getState().openDocument(item)
        publishSessionMetadata(itemId, session)
        notify()
      },
      get: (itemId) => sessionsRef.current.get(itemId),
      finalizeAndFlush,
      activate: async (itemId) => {
        const workspace = usePresentationWorkspaceStore.getState()
        const previousItemId = workspace.activeItemId
        if (previousItemId === itemId) return true
        const previousSession = previousItemId ? sessionsRef.current.get(previousItemId) : undefined
        if (previousSession) {
          if (!finalizeEditor(previousItemId!)) return false
          try {
            await previousSession.flush()
          } catch {
            return false
          }
        }
        usePresentationWorkspaceStore.getState().setActiveDocument(itemId)
        return true
      },
      close: async (itemId, decision) => {
        if (decision === 'keep-editing') return false
        await openingRef.current.get(itemId)?.catch(() => undefined)
        const isDraft =
          draftIdsRef.current.has(itemId) ||
          usePresentationWorkspaceStore
            .getState()
            .documents.some((entry) => entry.itemId === itemId && entry.isUnsaved)
        if (isDraft && decision !== 'discard') return false
        const session = sessionsRef.current.get(itemId)
        if (session) {
          if (!finalizeEditor(itemId)) return false
          if (decision === 'discard') {
            await session.discard()
          } else {
            try {
              await session.flush()
            } catch {
              return false
            }
          }
          sessionUnsubscribersRef.current.get(itemId)?.()
          sessionUnsubscribersRef.current.delete(itemId)
          session.dispose()
          sessionsRef.current.delete(itemId)
          editorFinalizersRef.current.delete(itemId)
        }
        if (isDraft) {
          await discardPresentationDraft(itemId)
          draftIdsRef.current.delete(itemId)
        }
        sessionItemsRef.current.delete(itemId)
        usePresentationWorkspaceStore.getState().closeDocument(itemId)
        notify()
        return true
      },
      flushAll: async () => {
        await checkpointAll()
        if (
          usePresentationWorkspaceStore
            .getState()
            .documents.some((entry) => entry.isUnsaved && isPersonalRecordVisible(entry)) ||
          [...draftIdsRef.current].some((id) =>
            isPersonalRecordVisible(sessionItemsRef.current.get(id) ?? {})
          )
        )
          throw new Error('Presentation has no saved destination')
      },
      discardAll: async () => {
        await Promise.allSettled(openingRef.current.values())
        for (const [itemId, session] of sessionsRef.current) {
          if (!isPersonalRecordVisible(sessionItemsRef.current.get(itemId) ?? {})) continue
          if (!finalizeEditor(itemId)) throw new Error('Text composition is still active')
          if (draftIdsRef.current.has(itemId)) {
            await session.discard()
            await discardPresentationDraft(itemId)
            sessionUnsubscribersRef.current.get(itemId)?.()
            sessionUnsubscribersRef.current.delete(itemId)
            session.dispose()
            sessionsRef.current.delete(itemId)
            draftIdsRef.current.delete(itemId)
            editorFinalizersRef.current.delete(itemId)
            usePresentationWorkspaceStore.getState().closeDocument(itemId)
          } else if (isSessionUnsafe(session)) await session.discard()
        }
        for (const entry of usePresentationWorkspaceStore.getState().documents) {
          if (entry.isUnsaved && isPersonalRecordVisible(entry)) {
            await discardPresentationDraft(entry.itemId)
            usePresentationWorkspaceStore.getState().closeDocument(entry.itemId)
          }
        }
        notify()
      },
      undo: (itemId) => moveHistory(itemId, 'undo'),
      redo: (itemId) => moveHistory(itemId, 'redo'),
      hasLiveEditor: (itemId) => editorFinalizersRef.current.get(itemId)?.hasLiveEditor() ?? false,
      hasPendingEditorWork: (itemId) =>
        editorFinalizersRef.current.get(itemId)?.hasUnsafeWork() ?? false,
      hasComposingEditor: (itemId) =>
        editorFinalizersRef.current.get(itemId)?.hasComposing() ?? false,
      notifyEditorLifecycle: () => notify(),
      hasUnsafeWork: () => getUnsafeItemIds().length > 0,
      getUnsafeItemIds,
      subscribe: (listener) => {
        listenersRef.current.add(listener)
        return () => listenersRef.current.delete(listener)
      },
      registerEditorFinalizer: (
        itemId,
        finalize,
        hasUnsafeWork = () => false,
        hasLiveEditor = () => false,
        hasComposing = () => false
      ) => {
        editorFinalizersRef.current.set(itemId, {
          finalize,
          hasUnsafeWork,
          hasLiveEditor,
          hasComposing
        })
        notify()
        return () => {
          if (editorFinalizersRef.current.get(itemId)?.finalize === finalize) {
            editorFinalizersRef.current.delete(itemId)
            notify()
          }
        }
      }
    }
  }, [])

  useEffect(
    () =>
      usePersonalSyncStore.subscribe((state, previous) => {
        if (state.activeOwnerId === previous.activeOwnerId) return
        for (const document of usePresentationWorkspaceStore.getState().documents) {
          if (isPersonalRecordVisible(document)) continue
          // Finalize before unmounting the editor; failed saves stay in the hidden session for recovery.
          const saving = registry.finalizeAndFlush(document.itemId)
          usePresentationWorkspaceStore.getState().closeDocument(document.itemId)
          void saving
            .then(async () => {
              if (!isPersonalRecordVisible(document)) await registry.close(document.itemId)
            })
            .catch(() => undefined)
        }
      }),
    [registry]
  )

  useEffect(
    () => () => {
      for (const unsubscribe of sessionUnsubscribersRef.current.values()) unsubscribe()
      for (const session of sessionsRef.current.values()) session.dispose()
      sessionUnsubscribersRef.current.clear()
      sessionsRef.current.clear()
      editorFinalizersRef.current.clear()
      openingRef.current.clear()
      listenersRef.current.clear()
    },
    []
  )

  return (
    <PresentationSessionRegistryContext.Provider value={registry}>
      {children}
    </PresentationSessionRegistryContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePresentationSessionRegistry(): PresentationSessionRegistry {
  const registry = useContext(PresentationSessionRegistryContext)
  if (!registry) {
    throw new Error(
      'usePresentationSessionRegistry must be used within PresentationSessionRegistryProvider'
    )
  }
  return registry
}
