import PresentationSaveDialog from '@renderer/components/Control/Presentation/PresentationSaveDialog'
import { getPresentationItem } from '@renderer/lib/presentation-drafts'
import { ButtonGroup } from '@heroui/react/button-group'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@heroui/react/button'
import { toast } from '@heroui/react/toast'
import { Home, Monitor, Redo2, Undo2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { usePresentationSafeAction } from '@renderer/components/Control/PresentationNavigationGuard'
import { usePresentationCloseDecision } from '@renderer/contexts/PresentationCloseDecisionContext'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import { usePresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import { SHORTCUTS } from '@renderer/config/shortcuts'
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts'
import { hasNameConflict, splitFileName, validateDisplayName } from '@renderer/lib/file-naming'
import { openFileExplorerDB } from '@renderer/lib/file-explorer-db'
import { isWeb } from '@renderer/lib/env'
import {
  getPresentationWorkspacePath,
  isEditablePresentationMimeType,
  isPresentationItem
} from '@renderer/lib/presentation-media'
import { startMediaProjection, stopProjectionSession } from '@renderer/lib/projection-actions'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import { isFileItem } from '@shared/types/folder'
import type { FileItemRecord } from '@shared/types/folder'

export default function PresentationWorkspaceHeader(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { isProjectionOpen, ensureProjectionOpen, stopProjection } = useProjection()
  const registry = usePresentationSessionRegistry()
  const requestCloseDecision = usePresentationCloseDecision()
  const runPresentationSafeAction = usePresentationSafeAction()
  const documents = usePresentationWorkspaceStore((state) => state.documents)
  const activeItemId = usePresentationWorkspaceStore((state) => state.activeItemId)
  const filesPath = useFileExplorerStore((state) =>
    activeItemId && state.items[activeItemId]?.personalOwnerId ? '/cloud-files' : '/files'
  )
  const activeDocument = usePresentationWorkspaceStore((state) => state.getActiveDocument())
  const updateDocumentName = usePresentationWorkspaceStore((state) => state.updateDocumentName)
  const [savingItemId, setSavingItemId] = useState<string | null>(null)
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const activeSession = activeItemId ? registry.get(activeItemId) : undefined
  const hasPendingEditorWork = useSyncExternalStore(
    registry.subscribe,
    () => (activeItemId ? (registry.hasPendingEditorWork?.(activeItemId) ?? false) : false),
    () => false
  )
  const hasComposingEditor = useSyncExternalStore(
    registry.subscribe,
    () => (activeItemId ? (registry.hasComposingEditor?.(activeItemId) ?? false) : false),
    () => false
  )
  const activeSnapshot = activeSession?.getSnapshot()
  const canUndo =
    activeSnapshot !== undefined &&
    !hasComposingEditor &&
    (activeSnapshot.history.past.length > 0 ||
      activeSnapshot.draftKind !== null ||
      hasPendingEditorWork)
  const canRedo =
    activeSnapshot !== undefined &&
    !hasComposingEditor &&
    activeSnapshot.draftKind === null &&
    !hasPendingEditorWork &&
    activeSnapshot.history.future.length > 0

  useEffect(() => {
    if (!editingItemId) return
    editInputRef.current?.focus()
    editInputRef.current?.select()
  }, [editingItemId])

  const activateDocument = async (itemId: string): Promise<void> => {
    if (!(await registry.activate(itemId))) return
    navigate(getPresentationWorkspacePath(itemId))
  }

  const closeTab = async (itemId: string): Promise<void> => {
    let closed = await registry.close(itemId)
    if (!closed) {
      const decision = await requestCloseDecision([itemId])
      if (decision === 'keep-editing') return
      closed = await registry.close(itemId, decision)
    }
    if (!closed) return
    const nextActiveItemId = usePresentationWorkspaceStore.getState().activeItemId
    navigate(nextActiveItemId ? getPresentationWorkspacePath(nextActiveItemId) : filesPath)
  }

  const startRename = (deck: { itemId: string; name: string }): void => {
    const { base } = splitFileName(deck.name)
    setEditingItemId(deck.itemId)
    setEditingName(base)
  }

  const cancelRename = (): void => {
    setEditingItemId(null)
    setEditingName('')
  }

  const renameDocument = async (itemId: string, nextBaseName: string): Promise<void> => {
    const trimmedBase = nextBaseName.trim()
    const currentDeck = documents.find((deck) => deck.itemId === itemId)
    if (!currentDeck) return
    if (!validateDisplayName(trimmedBase)) {
      toast.danger(t('fileExplorer.invalidName', 'Invalid name'))
      return
    }

    const { extension } = splitFileName(currentDeck.name)
    const nextName = `${trimmedBase}${extension}`
    if (nextName === currentDeck.name) {
      cancelRename()
      return
    }

    const db = await openFileExplorerDB()
    const item = await getPresentationItem(itemId)
    if (!item || !isFileItem(item)) return

    const siblings = await db.getAllFromIndex('folder-items', 'by-parent', item.parentId)
    const siblingNames = siblings
      .filter(
        (entry): entry is FileItemRecord =>
          isFileItem(entry) && entry.id !== item.id && !entry.deletedAt
      )
      .map((entry) => entry.name)
    if (hasNameConflict(nextName, siblingNames)) {
      toast.danger(t('fileExplorer.fileAlreadyExists', 'A file with this name already exists'))
      return
    }

    let nextSize = item.size
    if (isEditablePresentationMimeType(item.mimeType)) {
      const session = registry.get(itemId) ?? (await registry.open(item))
      session.commitDraft()
      session.rename(trimmedBase, nextName)
      await session.flush()
      nextSize = new Blob([JSON.stringify(session.getSnapshot().renderedDocument)]).size
    }
    useFileExplorerStore.getState().updateItem?.(itemId, { name: nextName, size: nextSize })
    updateDocumentName(itemId, nextName)
    cancelRename()
  }

  const presentActiveDocument = async (from: 'beginning' | 'current'): Promise<void> => {
    if (!activeDocument) return
    if (isWeb()) void ensureProjectionOpen().catch(() => undefined)

    const item = await getPresentationItem(activeDocument.itemId)
    if (!item || !isFileItem(item) || !isPresentationItem(item)) return

    const activeSlideId = usePresentationWorkspaceStore.getState().getActiveSlideId(item.id)
    let slideIndex = 0
    let slideCount = activeDocument.slideCount
    if (isEditablePresentationMimeType(item.mimeType)) {
      const document = await registry.finalizeAndFlush(item.id)
      if (!document) throw new Error('Presentation text composition is still active')
      slideIndex = Math.max(0, document.slideOrder.indexOf(activeSlideId ?? ''))
      slideCount = document.slideOrder.length
    } else if (activeSlideId?.startsWith('pptx-slide-')) {
      const parsedIndex = Number(activeSlideId.slice('pptx-slide-'.length))
      if (Number.isInteger(parsedIndex) && parsedIndex >= 0) slideIndex = parsedIndex
    }
    if (from === 'beginning') slideIndex = 0
    const report = await startMediaProjection(
      [item],
      0,
      { onNoProjectableFiles: () => toast.warning(t('fileExplorer.noProjectableFiles')) },
      {
        prioritizeStartItem: true,
        presentationState: {
          slideIndex,
          slideCount
        }
      }
    )
    if (report.items.find((entry) => entry.itemId === item.id)?.status === 'ready') {
      navigate('/media')
    }
  }

  const runPresentAction = (from: 'beginning' | 'current'): void => {
    void presentActiveDocument(from).catch(() => {
      toast.danger(t('presentationWorkspace.saveFailed', 'Unable to save presentation'))
    })
  }

  const handleProjectionAction = (): void => {
    if (!isProjectionOpen) {
      runPresentAction('current')
      return
    }

    void stopProjectionSession({ stopProjection }).catch(() => {
      toast.danger(t('toast.projectionCloseFailed'))
    })
  }

  useKeyboardShortcuts(
    [
      {
        id: 'presentation-save',
        allowInEditable: true,
        config: SHORTCUTS.PRESENTATION.SAVE,
        description: t('common.save', 'Save'),
        handler: () => {
          if (activeDocument?.isUnsaved) setSavingItemId(activeDocument.itemId)
          else if (activeItemId)
            void registry
              .finalizeAndFlush(activeItemId)
              .catch(() =>
                toast.danger(t('presentationWorkspace.saveFailed', 'Unable to save presentation'))
              )
        }
      },
      {
        id: 'presentation-start-beginning',
        allowInEditable: true,
        config: SHORTCUTS.PRESENTATION.START_FROM_BEGINNING,
        description: t('presentationWorkspace.presentFromBeginning', 'Present from Beginning'),
        handler: () => {
          runPresentAction('beginning')
        }
      },
      {
        id: 'presentation-start-current',
        allowInEditable: true,
        config: SHORTCUTS.PRESENTATION.START_FROM_CURRENT,
        description: t('presentationWorkspace.presentFromCurrent', 'Present from Current Slide'),
        handler: () => {
          runPresentAction('current')
        }
      },
      {
        id: 'presentation-undo',
        config: SHORTCUTS.PRESENTATION.UNDO,
        description: t('presentationWorkspace.undo', 'Undo'),
        handler: () => {
          if (activeItemId && canUndo) registry.undo?.(activeItemId)
        }
      },
      {
        id: 'presentation-redo',
        config: SHORTCUTS.PRESENTATION.REDO,
        description: t('presentationWorkspace.redo', 'Redo'),
        handler: () => {
          if (activeItemId && canRedo) registry.redo?.(activeItemId)
        }
      }
    ],
    { enabled: Boolean(activeDocument), sectionKey: 'presentation' }
  )

  return (
    <header className="relative flex h-14 shrink-0 items-center gap-1 bg-surface/80 px-2">
      {savingItemId && (
        <PresentationSaveDialog
          key={savingItemId}
          itemId={savingItemId}
          onSaved={() => setSavingItemId(null)}
          onCancel={() => setSavingItemId(null)}
        />
      )}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-separator" />
      <Button
        isIconOnly
        size="lg"
        variant="outline"
        className="relative z-10"
        onPress={() => void runPresentationSafeAction(() => navigate(filesPath))}
        aria-label={t('presentationWorkspace.backToFiles')}
      >
        <Home size={16} />
      </Button>
      <ButtonGroup variant="outline">
        <Button
          isIconOnly
          variant="outline"
          className="relative z-10"
          isDisabled={!canUndo}
          onPress={() => {
            if (activeItemId) registry.undo?.(activeItemId)
          }}
          aria-label={t('presentationWorkspace.undo', 'Undo')}
        >
          <Undo2 size={18} />
        </Button>
        <Button
          isIconOnly
          variant="outline"
          className="relative z-10"
          isDisabled={!canRedo}
          onPress={() => {
            if (activeItemId) registry.redo?.(activeItemId)
          }}
          aria-label={t('presentationWorkspace.redo', 'Redo')}
        >
          <Redo2 size={18} />
        </Button>
      </ButtonGroup>
      {documents.map((deck) => (
        <div
          key={deck.itemId}
          role="button"
          tabIndex={0}
          className={`relative flex h-10 max-w-56 self-end items-center gap-2 rounded-t-xl border px-3 text-sm ${
            deck.itemId === activeItemId
              ? 'z-20 -mb-px border-separator border-b-background bg-background text-foreground shadow-sm'
              : 'z-10 mb-px border-transparent bg-surface-secondary text-muted hover:text-foreground'
          }`}
          onClick={() => {
            if (editingItemId !== deck.itemId) void activateDocument(deck.itemId)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              void activateDocument(deck.itemId)
            }
          }}
        >
          {editingItemId === deck.itemId ? (
            <input
              ref={editInputRef}
              className="min-w-0 flex-1 rounded-md border border-accent/50 bg-background px-1 text-sm text-foreground outline-none"
              value={editingName}
              aria-label={t('fileExplorer.renameFile', 'Rename file')}
              onChange={(event) => setEditingName(event.currentTarget.value)}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onBlur={() => void renameDocument(deck.itemId, editingName)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelRename()
                  return
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void renameDocument(deck.itemId, editingName)
                }
              }}
            />
          ) : (
            <span
              className="min-w-0 flex-1 truncate"
              onDoubleClick={(event) => {
                event.stopPropagation()
                startRename(deck)
              }}
            >
              {deck.name}
            </span>
          )}
          <button
            type="button"
            className="rounded p-0.5 hover:bg-black/10"
            onClick={(event) => {
              event.stopPropagation()
              void closeTab(deck.itemId)
            }}
            aria-label={t('presentationWorkspace.closeTab', 'Close tab')}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <div className="relative z-10 ml-auto flex items-center gap-3">
        {activeDocument?.isUnsaved && (
          <Button variant="primary" onPress={() => setSavingItemId(activeDocument.itemId)}>
            {t('common.save', 'Save')}
          </Button>
        )}
        {activeDocument?.saveStatus && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <span role={activeDocument.saveStatus === 'error' ? 'alert' : undefined}>
              {t(
                `presentationWorkspace.saveStatus.${activeDocument.isUnsaved && activeDocument.saveStatus === 'saved' ? 'dirty' : activeDocument.saveStatus}`,
                activeDocument.saveStatus === 'dirty'
                  ? 'Unsaved'
                  : activeDocument.saveStatus === 'saving'
                    ? 'Saving...'
                    : activeDocument.saveStatus === 'error'
                      ? 'Save failed'
                      : 'Saved'
              )}
            </span>
            {activeDocument.mirrorWarnings && activeDocument.mirrorWarnings.length > 0 && (
              <span>{t('presentationWorkspace.previewWarning', 'Preview needs repair')}</span>
            )}
            {activeDocument.saveStatus === 'error' && (
              <Button size="sm" variant="tertiary" onPress={() => activeSession?.retry()}>
                {t('presentationWorkspace.retrySave', 'Retry save')}
              </Button>
            )}
          </div>
        )}
        <Button
          size="lg"
          isIconOnly
          variant="outline"
          className={`size-10 min-w-10 rounded-full p-0 ${
            isProjectionOpen ? 'text-danger' : 'text-default-foreground'
          }`}
          onPress={handleProjectionAction}
          isDisabled={!isProjectionOpen && !activeDocument}
          aria-label={t(
            isProjectionOpen ? 'projection.stopButton' : 'projection.startButton',
            isProjectionOpen ? 'Stop projection' : 'Start projection'
          )}
        >
          {isProjectionOpen ? <X className="size-4" /> : <Monitor className="size-4" />}
        </Button>
      </div>
    </header>
  )
}
