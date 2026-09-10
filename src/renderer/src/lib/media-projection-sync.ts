import { useCallback, useEffect, useRef } from 'react'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import { usePresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import {
  useMediaProjectionStore,
  type MediaProjectionStore
} from '@renderer/stores/media-projection'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { isElectron } from '@renderer/lib/env'
import type { HhcLineCloudAuth } from '@renderer/lib/cloud-provider'
import {
  buildEditableSlideProjectionPayload,
  buildFileProjectionPayload,
  buildFileProjectionPayloadWithEditableSlide
} from '@renderer/lib/media-projection-payload'
import {
  isEditablePresentationMimeType,
  isPresentationMimeType
} from '@renderer/lib/presentation-media'
import { registerMediaProjectionPreflight } from '@renderer/lib/media-projection-preflight'
import type { EditablePresentationDocument } from '@renderer/lib/editable-presentation'
import type { PresentationEditorSession } from '@renderer/lib/presentation-editor-session'

function playlistContentChanged(
  prev: { id: string; mimeType: string; name: string }[],
  next: { id: string; mimeType: string; name: string }[]
): boolean {
  if (prev.length !== next.length) return true
  for (let i = 0; i < prev.length; i++) {
    const p = prev[i]
    const n = next[i]
    if (p.id !== n.id || p.mimeType !== n.mimeType || p.name !== n.name) return true
  }
  return false
}

export interface HhcProjectionAccessRevoked {
  providerConnectionId: string
  remoteItemId: string
}

interface MediaProjectionSyncOptions {
  auth?: HhcLineCloudAuth
  onAccessRevoked?: (scope: HhcProjectionAccessRevoked) => void | Promise<void>
}

const RENEWAL_LEAD_MS = 30_000
const RENEWAL_RETRY_MS = 5_000

export function useMediaProjectionSync(options: MediaProjectionSyncOptions = {}): void {
  const { project, startProjection, stopProjection, activeOwner } = useProjection()
  const registry = usePresentationSessionRegistry()
  const projectSequenceRef = useRef(0)
  const editableOwnershipRef = useRef(
    new Map<
      string,
      | {
          kind: 'session'
          session: PresentationEditorSession
          document: EditablePresentationDocument
        }
      | { kind: 'none' }
    >()
  )
  const didInitializeRef = useRef(false)
  const renewalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const projectCurrentItemRef = useRef<
    (
      state: MediaProjectionStore,
      startSession?: boolean,
      forceRemoteSource?: boolean
    ) => Promise<void>
  >(async () => undefined)
  const activeRemoteRef = useRef<{
    itemId: string
    providerConnectionId: string
    remoteItemId: string
    rootRemoteFolderId: string
    leaseId?: string
  } | null>(null)
  const { auth, onAccessRevoked } = options
  const sessionUserId = auth?.getSession()?.userId ?? null

  useEffect(
    () =>
      registerMediaProjectionPreflight(async (items) => {
        const nextOwnership = new Map(editableOwnershipRef.current)
        nextOwnership.clear()
        const ownedDocuments: Array<{
          itemId: string
          session: PresentationEditorSession
          document: EditablePresentationDocument
        }> = []
        const ownedWithoutSession: string[] = []
        for (const item of items) {
          if (!isEditablePresentationMimeType(item.mimeType)) continue
          const session = registry.get(item.id)
          if (!session) {
            nextOwnership.set(item.id, { kind: 'none' })
            ownedWithoutSession.push(item.id)
            continue
          }
          const snapshot = session.getSnapshot()
          let document = snapshot.history.present
          if (
            !registry.hasPendingEditorWork?.(item.id) &&
            snapshot.draftKind === null &&
            snapshot.save?.status === 'saved'
          ) {
            nextOwnership.set(item.id, { kind: 'session', session, document })
            ownedDocuments.push({ itemId: item.id, session, document })
            continue
          }
          try {
            const finalized = await registry.finalizeAndFlush(item.id)
            if (!finalized) return false
            if (registry.get(item.id) !== session) {
              return { status: 'ready' as const, validate: () => false }
            }
            document = finalized
          } catch {
            return false
          }
          nextOwnership.set(item.id, { kind: 'session', session, document })
          ownedDocuments.push({ itemId: item.id, session, document })
        }
        return {
          status: 'ready' as const,
          validate: () => {
            const valid =
              ownedDocuments.every(({ itemId, session, document }) => {
                const snapshot = session.getSnapshot()
                return (
                  registry.get(itemId) === session &&
                  snapshot.history.present === document &&
                  snapshot.draftKind == null
                )
              }) && ownedWithoutSession.every((itemId) => registry.get(itemId) === undefined)
            if (valid) editableOwnershipRef.current = nextOwnership
            return valid
          }
        }
      }),
    [registry]
  )

  const releaseLease = useCallback((leaseId: string): void => {
    const release = window.api?.hhcAssets?.releaseContentLease
    if (!release) return
    void release(leaseId).catch(() => release(leaseId).catch(() => undefined))
  }, [])

  const clearRemoteSource = useCallback((): void => {
    if (renewalTimerRef.current) clearTimeout(renewalTimerRef.current)
    renewalTimerRef.current = null
    const active = activeRemoteRef.current
    const leaseId = active?.leaseId
    activeRemoteRef.current = null
    if (active) {
      useMediaProjectionStore.setState((state) => {
        const snapshot = state.snapshot
        const item = state.playlist.find((candidate) => candidate.id === active.itemId)
        if (!snapshot || !item) return state
        return {
          snapshot: {
            ...snapshot,
            entries: snapshot.entries.map((entry) => {
              if (entry.itemId !== active.itemId) return entry
              const { remoteSource: _remoteSource, ...rest } = entry
              return { ...rest, sourceUrl: item.url }
            })
          }
        }
      })
    }
    if (leaseId) releaseLease(leaseId)
  }, [releaseLease])

  const projectCurrentItem = useCallback(
    async (
      state: MediaProjectionStore,
      startSession = false,
      forceRemoteSource = false
    ): Promise<void> => {
      if (!startSession && activeOwner !== 'media') return
      const sequence = ++projectSequenceRef.current
      const item = state.currentItem()
      let currentState = state
      const snapshotEntry = state.snapshot?.entries.find((entry) => entry.itemId === item?.id)
      if (item && auth && snapshotEntry?.remoteItem) {
        try {
          let sharedAvailable: boolean | null = null
          if (snapshotEntry.remoteItem.providerConnectionId.startsWith('hhc-share:')) {
            const { ensurePersonalShareItemAvailableForPresentation } =
              await import('@renderer/lib/personal-share-sync')
            sharedAvailable =
              (await ensurePersonalShareItemAvailableForPresentation(auth, item)) ?? false
          }
          if (sharedAvailable !== null) {
            if (!sharedAvailable) return
            const latest = useMediaProjectionStore.getState()
            const latestItem = latest.currentItem()
            if (sequence !== projectSequenceRef.current || latestItem?.id !== item.id) return
            useMediaProjectionStore.setState((current) => {
              const snapshot = current.snapshot
              if (!snapshot || current.currentItem()?.id !== item.id) return current
              return {
                snapshot: {
                  ...snapshot,
                  entries: snapshot.entries.map((entry) => {
                    if (entry.itemId !== item.id) return entry
                    const {
                      remoteItem: _remoteItem,
                      remoteSource: _remoteSource,
                      ...localEntry
                    } = entry
                    return { ...localEntry, sourceUrl: latestItem.url }
                  })
                }
              }
            })
            currentState = useMediaProjectionStore.getState()
          } else if (snapshotEntry.playbackMode === 'vlc-embedded' && isElectron()) {
            const { ensureHhcLineDesktopItemAvailableForPresentation } =
              await import('@renderer/lib/hhc-line-connect')
            const available = await ensureHhcLineDesktopItemAvailableForPresentation(auth, item)
            if (available !== true) return
            const latest = useMediaProjectionStore.getState()
            const latestItem = latest.currentItem()
            if (sequence !== projectSequenceRef.current || latestItem?.id !== item.id) return
            useMediaProjectionStore.setState((current) => {
              const snapshot = current.snapshot
              if (!snapshot || current.currentItem()?.id !== item.id) return current
              return {
                snapshot: {
                  ...snapshot,
                  entries: snapshot.entries.map((entry) => {
                    if (entry.itemId !== item.id) return entry
                    const {
                      remoteItem: _remoteItem,
                      remoteSource: _remoteSource,
                      ...localEntry
                    } = entry
                    return { ...localEntry, sourceUrl: latestItem.url }
                  })
                }
              }
            })
            currentState = useMediaProjectionStore.getState()
          } else if (forceRemoteSource || !snapshotEntry.remoteSource) {
            const { prepareHhcLinePresentationSource } =
              await import('@renderer/lib/hhc-line-connect')
            const prepared = await prepareHhcLinePresentationSource(auth, item)
            if (prepared && sequence !== projectSequenceRef.current) {
              if (prepared.source.kind === 'native-lease') releaseLease(prepared.source.leaseId)
              return
            }
            if (!prepared && activeRemoteRef.current?.itemId === item.id) {
              clearRemoteSource()
              currentState = useMediaProjectionStore.getState()
            }
            if (prepared && sequence === projectSequenceRef.current) {
              const previous = activeRemoteRef.current
              const leaseId =
                prepared.source.kind === 'native-lease' ? prepared.source.leaseId : undefined
              if (previous?.leaseId && previous.leaseId !== leaseId) {
                releaseLease(previous.leaseId)
              }
              const remoteSource = {
                providerConnectionId: prepared.providerConnectionId,
                remoteItemId: prepared.remoteItemId,
                rootRemoteFolderId: prepared.rootRemoteFolderId,
                ...(leaseId ? { leaseId } : {}),
                ...(prepared.source.kind === 'ticket'
                  ? { expiresAt: prepared.source.expiresAt }
                  : {}),
                etag: prepared.source.etag
              }
              useMediaProjectionStore.setState((latest) => ({
                snapshot: latest.snapshot
                  ? {
                      ...latest.snapshot,
                      entries: latest.snapshot.entries.map((entry) =>
                        entry.itemId === item.id
                          ? { ...entry, sourceUrl: prepared.source.url, remoteSource }
                          : entry
                      )
                    }
                  : null
              }))
              activeRemoteRef.current = {
                itemId: item.id,
                providerConnectionId: prepared.providerConnectionId,
                remoteItemId: prepared.remoteItemId,
                rootRemoteFolderId: prepared.rootRemoteFolderId,
                ...(leaseId ? { leaseId } : {})
              }
              if (renewalTimerRef.current) clearTimeout(renewalTimerRef.current)
              renewalTimerRef.current = null
              if (prepared.source.kind === 'ticket') {
                const delay = Math.max(
                  1_000,
                  prepared.source.expiresAt - Date.now() - RENEWAL_LEAD_MS
                )
                renewalTimerRef.current = setTimeout(() => {
                  void projectCurrentItemRef
                    .current(useMediaProjectionStore.getState(), false, true)
                    .catch(() => undefined)
                }, delay)
              }
              currentState = useMediaProjectionStore.getState()
            }
          }
        } catch (error) {
          if (sequence !== projectSequenceRef.current) return
          const classified = error as {
            classification?: string
            status?: number
            providerConnectionId?: string
            remoteItemId?: string
          }
          if (
            classified.classification === 'access-revoked' &&
            (classified.status === 403 || classified.status === 404) &&
            classified.providerConnectionId &&
            classified.remoteItemId
          ) {
            projectSequenceRef.current += 1
            clearRemoteSource()
            await stopProjection()
            await onAccessRevoked?.({
              providerConnectionId: classified.providerConnectionId,
              remoteItemId: classified.remoteItemId
            })
          } else if (classified.classification === 'retryable' && snapshotEntry.remoteSource) {
            if (renewalTimerRef.current) clearTimeout(renewalTimerRef.current)
            renewalTimerRef.current = setTimeout(() => {
              void projectCurrentItemRef
                .current(useMediaProjectionStore.getState(), false, true)
                .catch(() => undefined)
            }, RENEWAL_RETRY_MS)
          }
          return
        }
      }
      const latest = useMediaProjectionStore.getState()
      if (
        sequence !== projectSequenceRef.current ||
        latest.sessionRevision !== state.sessionRevision ||
        latest.playlist !== state.playlist ||
        latest.currentIndex !== state.currentIndex ||
        latest.currentItem()?.id !== item?.id ||
        latest.isPresenting !== state.isPresenting
      ) {
        return
      }
      currentState = latest
      const basePayload = buildFileProjectionPayload(currentState)
      let payload = basePayload
      if (basePayload && item && isEditablePresentationMimeType(item.mimeType)) {
        const session = registry.get(item.id)
        let ownership = editableOwnershipRef.current.get(item.id)
        let initialSnapshot: ReturnType<PresentationEditorSession['getSnapshot']> | undefined
        if (!ownership) {
          if (session) {
            initialSnapshot = session.getSnapshot()
            if (initialSnapshot.draftKind != null) return
            ownership = { kind: 'session', session, document: initialSnapshot.history.present }
          } else {
            ownership = { kind: 'none' }
          }
          editableOwnershipRef.current.set(item.id, ownership)
        }
        if (ownership?.kind === 'session') {
          if (session !== ownership.session) return
          const snapshot = initialSnapshot ?? session.getSnapshot()
          if (snapshot.history.present !== ownership.document || snapshot.draftKind != null) return
          payload = buildEditableSlideProjectionPayload(
            basePayload,
            ownership.document,
            usePresentationWorkspaceStore.getState().getActiveSlideId(item.id) ?? ''
          )
        } else if (ownership?.kind === 'none') {
          if (session) return
          payload = await buildFileProjectionPayloadWithEditableSlide(currentState)
          if (
            sequence !== projectSequenceRef.current ||
            registry.get(item.id) !== undefined ||
            useMediaProjectionStore.getState().sessionRevision !== state.sessionRevision
          ) {
            return
          }
        }
      }
      if (!payload) return

      if (sequence === projectSequenceRef.current) {
        if (startSession) {
          void startProjection('media', [['file:show', payload]])
        } else {
          void project('file:show', payload)
        }
      }
    },
    [
      activeOwner,
      auth,
      clearRemoteSource,
      onAccessRevoked,
      project,
      registry,
      releaseLease,
      startProjection,
      stopProjection
    ]
  )

  useEffect(() => {
    projectCurrentItemRef.current = projectCurrentItem
  }, [projectCurrentItem])

  useEffect(() => {
    const unsub = useMediaProjectionStore.subscribe((state, prev) => {
      if (!state.isPresenting) return

      const started =
        (!prev.isPresenting && state.isPresenting) || state.sessionRevision !== prev.sessionRevision
      if (!started && activeOwner !== 'media') return
      const indexChanged = state.currentIndex !== prev.currentIndex
      const playlistChanged = playlistContentChanged(prev.playlist, state.playlist)
      const endedCleared = prev.isEnded && !state.isEnded
      const presentationChanged =
        isPresentationMimeType(state.currentItem()?.mimeType) &&
        state.typeStates.presentation !== prev.typeStates.presentation

      if (started || indexChanged || playlistChanged || endedCleared || presentationChanged) {
        if (indexChanged || playlistChanged) clearRemoteSource()
        void projectCurrentItem(state, started).catch(() => undefined)
      }
    })
    return () => {
      unsub()
    }
  }, [activeOwner, clearRemoteSource, projectCurrentItem])

  useEffect(() => {
    if (!useMediaProjectionStore.getState().isPresenting) {
      editableOwnershipRef.current.clear()
      clearRemoteSource()
    }
    const unsub = useMediaProjectionStore.subscribe((state, prev) => {
      if (prev.isPresenting && !state.isPresenting) {
        projectSequenceRef.current += 1
        editableOwnershipRef.current.clear()
        clearRemoteSource()
      }
    })
    return unsub
  }, [clearRemoteSource])

  useEffect(() => {
    const unsubscribe = useFileExplorerStore.subscribe((state) => {
      const active = activeRemoteRef.current
      if (!active) return
      const root = Object.values(state.folders).find(
        (folder) =>
          folder.syncLink?.providerType === 'hhc-line' &&
          folder.syncLink.providerConnectionId === active.providerConnectionId &&
          folder.syncLink.remoteFolderId === active.rootRemoteFolderId
      )
      if (root && root.syncLink?.status !== 'access-revoked') return
      projectSequenceRef.current += 1
      clearRemoteSource()
      void stopProjection()
    })
    return unsubscribe
  }, [clearRemoteSource, stopProjection])

  const previousSessionUserIdRef = useRef(sessionUserId)
  useEffect(() => {
    const previousUserId = previousSessionUserIdRef.current
    previousSessionUserIdRef.current = sessionUserId
    if (previousUserId && previousUserId !== sessionUserId) {
      projectSequenceRef.current += 1
      clearRemoteSource()
      void stopProjection()
    }
  }, [clearRemoteSource, sessionUserId, stopProjection])

  useEffect(
    () => () => {
      projectSequenceRef.current += 1
      editableOwnershipRef.current.clear()
      clearRemoteSource()
    },
    [clearRemoteSource]
  )

  useEffect(() => {
    const unsub = useMediaProjectionStore.subscribe((state, prev) => {
      if (!state.isPresenting) return
      if (activeOwner !== 'media') return
      if (state.pan !== prev.pan) {
        void project('file:control', { action: 'pan', value: state.pan })
      }
    })
    return unsub
  }, [activeOwner, project])

  useEffect(() => {
    const unsub = useMediaProjectionStore.subscribe((state, prev) => {
      if (!state.isPresenting) return
      if (activeOwner !== 'media') return
      if (state.zoomLevel !== prev.zoomLevel) {
        void project('file:control', { action: 'zoom', value: state.zoomLevel })
      }
    })
    return unsub
  }, [activeOwner, project])

  useEffect(() => {
    const unsub = useMediaProjectionStore.subscribe((state, prev) => {
      if (!state.isPresenting) return
      if (activeOwner !== 'media') return
      if (state.isEnded && !prev.isEnded) {
        projectSequenceRef.current += 1
        void project('file:end', null)
      }
    })
    return unsub
  }, [activeOwner, project])

  useEffect(() => {
    if (didInitializeRef.current) return
    didInitializeRef.current = true
    const state = useMediaProjectionStore.getState()
    if (!state.isPresenting || activeOwner !== 'media') return
    void projectCurrentItem(state, true).catch(() => undefined)
  }, [activeOwner, projectCurrentItem])
}
