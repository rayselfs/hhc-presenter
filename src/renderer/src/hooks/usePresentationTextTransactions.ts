import { useCallback, useEffect, useRef } from 'react'
import type { PresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import type { PresentationEditorSession } from '@renderer/lib/presentation-editor-session'
import {
  updateElementInSlide,
  type EditablePresentationDocument,
  type EditablePresentationElement
} from '@renderer/lib/editable-presentation'
import type { TextEditFinalizer } from '@renderer/types/presentation-text'

interface PresentationTextTransactions {
  setTextEditorFinalizer(finalizer: TextEditFinalizer | null): void
  getTextEditorFinalizer(): TextEditFinalizer | null
  finalizeTextEditor(): boolean
  commitTextDraft(): void
  finalizeDocumentMutation(): EditablePresentationDocument | null
  commitDocument(
    update: (document: EditablePresentationDocument) => EditablePresentationDocument
  ): boolean
  previewTextElement(
    slideId: string,
    elementId: string,
    updates: Partial<EditablePresentationElement>
  ): void
  beginEmptyTextDraft(elementId: string, document: EditablePresentationDocument): void
  isEmptyTextDraft(elementId: string): boolean
  cancelEmptyTextDraft(): boolean
}

export function usePresentationTextTransactions(
  itemId: string,
  session: PresentationEditorSession,
  registry: Pick<PresentationSessionRegistry, 'registerEditorFinalizer' | 'notifyEditorLifecycle'>
): PresentationTextTransactions {
  const textDraftStartedAtRef = useRef<number | null>(null)
  const textCommitTimerRef = useRef<number | null>(null)
  const textEditorFinalizerRef = useRef<TextEditFinalizer | null>(null)
  const newEmptyTextRef = useRef<string | null>(null)

  const finalizeTextEditor = useCallback(
    (): boolean => textEditorFinalizerRef.current?.() ?? true,
    []
  )
  const setTextEditorFinalizer = useCallback(
    (finalize: TextEditFinalizer | null): void => {
      textEditorFinalizerRef.current = finalize
      registry.notifyEditorLifecycle?.(itemId)
    },
    [itemId, registry]
  )

  useEffect(
    () =>
      registry.registerEditorFinalizer?.(
        itemId,
        finalizeTextEditor,
        () => textEditorFinalizerRef.current?.hasUnsafeWork?.() ?? false,
        () => textEditorFinalizerRef.current !== null,
        () => textEditorFinalizerRef.current?.isComposing?.() ?? false
      ),
    [itemId, finalizeTextEditor, registry]
  )
  useEffect(
    () => () => {
      if (textCommitTimerRef.current !== null) {
        window.clearTimeout(textCommitTimerRef.current)
      }
    },
    []
  )

  const clearTextCommitTimer = useCallback((resetDeadline = true): void => {
    if (resetDeadline) textDraftStartedAtRef.current = null
    if (textCommitTimerRef.current === null) return
    window.clearTimeout(textCommitTimerRef.current)
    textCommitTimerRef.current = null
  }, [])

  const commitTextDraft = (): void => {
    clearTextCommitTimer()
    if (newEmptyTextRef.current) return
    if (session.getSnapshot().draftKind === 'text') session.commitDraft()
  }

  const finalizeDocumentMutation = (): EditablePresentationDocument | null => {
    if (!finalizeTextEditor()) return null
    clearTextCommitTimer()
    return session.getSnapshot().renderedDocument
  }

  const commitDocument = (
    update: (currentDocument: EditablePresentationDocument) => EditablePresentationDocument
  ): boolean => {
    const currentDocument = finalizeDocumentMutation()
    if (!currentDocument) return false
    session.commit(update(currentDocument))
    return true
  }

  const previewTextElement = useCallback(
    (slideId: string, elementId: string, updates: Partial<EditablePresentationElement>): void => {
      const preview = session.getSnapshot().renderedDocument
      if (
        newEmptyTextRef.current === elementId &&
        'text' in updates &&
        updates.text?.replace(/[\u200b\ufeff]/g, '').trim()
      ) {
        newEmptyTextRef.current = null
      }
      const current = preview.slides[slideId]?.elements[elementId]
      if (
        current &&
        Object.entries(updates).every(
          ([key, value]) => current[key as keyof typeof current] === value
        )
      ) {
        return
      }
      textDraftStartedAtRef.current ??= Date.now()
      if (session.getSnapshot().draftKind !== 'text') session.beginDraft('text')
      session.previewDraft(updateElementInSlide(preview, slideId, elementId, updates))
      clearTextCommitTimer(false)
      if (newEmptyTextRef.current === elementId) return
      if (
        Date.now() - (textDraftStartedAtRef.current ?? Date.now()) >= 4000 &&
        !textEditorFinalizerRef.current?.isComposing?.()
      ) {
        session.commitDraft()
        textDraftStartedAtRef.current = null
        return
      }
      textCommitTimerRef.current = window.setTimeout(function commitWhenReady() {
        textCommitTimerRef.current = null
        if (textEditorFinalizerRef.current?.isComposing?.()) {
          textCommitTimerRef.current = window.setTimeout(commitWhenReady, 750)
          return
        }
        textDraftStartedAtRef.current = null
        if (session.getSnapshot().draftKind === 'text') session.commitDraft()
      }, 750)
    },
    [session, clearTextCommitTimer]
  )

  const beginEmptyTextDraft = (elementId: string, document: EditablePresentationDocument): void => {
    newEmptyTextRef.current = elementId
    session.beginDraft('text')
    session.previewDraft(document)
  }

  const cancelEmptyTextDraft = (): boolean => {
    if (!newEmptyTextRef.current) return false
    newEmptyTextRef.current = null
    clearTextCommitTimer()
    session.cancelDraft()
    return true
  }

  return {
    setTextEditorFinalizer,
    getTextEditorFinalizer: () => textEditorFinalizerRef.current,
    finalizeTextEditor,
    commitTextDraft,
    finalizeDocumentMutation,
    commitDocument,
    previewTextElement,
    beginEmptyTextDraft,
    isEmptyTextDraft: (elementId) => newEmptyTextRef.current === elementId,
    cancelEmptyTextDraft
  }
}
