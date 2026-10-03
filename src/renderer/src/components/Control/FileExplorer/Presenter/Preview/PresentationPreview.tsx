import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Spinner } from '@heroui/react/spinner'
import EditableSlideSurface from '@renderer/components/Common/EditableSlideSurface'
import PptxSlideSurface from '@renderer/components/Common/PptxSlideSurface'
import { usePresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import {
  loadEditablePresentation,
  type EditablePresentationDocument
} from '@renderer/lib/editable-presentation'
import { isEditablePresentationMimeType } from '@renderer/lib/presentation-media'
import type { PresentationEditorSession } from '@renderer/lib/presentation-editor-session'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import type { PreviewComponentProps } from '@renderer/lib/presenter-registry'

export default function PresentationPreview({
  item,
  previewOnly = false,
  onError
}: PreviewComponentProps & {
  previewOnly?: boolean
  onError?: (error: Error) => void
}): React.JSX.Element {
  const registry = usePresentationSessionRegistry()
  const presentationState = useMediaProjectionStore((s) => s.typeStates.presentation)
  const remoteSourceUrl = useMediaProjectionStore((s) => {
    const entry = s.snapshot?.entries.find((candidate) => candidate.itemId === item.id)
    if (!entry?.remoteItem) return undefined
    return entry.remoteSource ? entry.sourceUrl : null
  })
  const slideIndex = previewOnly ? 0 : (presentationState?.slideIndex ?? 0)

  const handleReady = useCallback(
    (info: { slideCount: number }) => {
      if (previewOnly) return
      const state = useMediaProjectionStore.getState()
      const current = state.typeStates.presentation ?? { slideIndex: 0 }
      const slideIndex = Math.min(current.slideIndex, Math.max(0, info.slideCount - 1))
      if (current.slideIndex === slideIndex && current.slideCount === info.slideCount) return
      state.setTypeState('presentation', { slideIndex, slideCount: info.slideCount })
    },
    [previewOnly]
  )

  if (isEditablePresentationMimeType(item.mimeType)) {
    const session = registry.get(item.id)
    return session ? (
      <OpenEditablePresentationPreview
        session={session}
        slideIndex={slideIndex}
        onReady={handleReady}
      />
    ) : (
      <DurableEditablePresentationPreview
        item={item}
        slideIndex={slideIndex}
        onReady={handleReady}
        onError={onError}
      />
    )
  }

  if (remoteSourceUrl === null) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-2xl bg-black">
        <Spinner />
      </div>
    )
  }

  return (
    <PptxSlideSurface
      source={remoteSourceUrl ? { ...item, url: remoteSourceUrl } : item}
      slideIndex={slideIndex}
      className="rounded-2xl"
      onReady={handleReady}
      onError={onError}
    />
  )
}

function OpenEditablePresentationPreview({
  session,
  slideIndex,
  onReady
}: {
  session: PresentationEditorSession
  slideIndex: number
  onReady: (info: { slideCount: number }) => void
}): React.JSX.Element {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const document = snapshot.history.present

  useEffect(() => {
    onReady({ slideCount: document.slideOrder.length })
  }, [document.slideOrder.length, onReady])

  return <EditablePresentationSurface document={document} slideIndex={slideIndex} />
}

function DurableEditablePresentationPreview({
  item,
  slideIndex,
  onReady,
  onError
}: PreviewComponentProps & {
  slideIndex: number
  onReady: (info: { slideCount: number }) => void
  onError?: (error: Error) => void
}): React.JSX.Element {
  const [document, setDocument] = useState<EditablePresentationDocument | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadEditablePresentation(item)
      .then((loadedDocument) => {
        if (cancelled) return
        setDocument(loadedDocument)
        onReady({ slideCount: loadedDocument.slideOrder.length })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (!onError) throw error
        onError(error instanceof Error ? error : new Error(String(error)))
      })
    return () => {
      cancelled = true
    }
  }, [item, onReady, onError])

  return <EditablePresentationSurface document={document} slideIndex={slideIndex} />
}

function EditablePresentationSurface({
  document,
  slideIndex
}: {
  document: EditablePresentationDocument | null
  slideIndex: number
}): React.JSX.Element {
  const slideId = document
    ? document.slideOrder[Math.min(slideIndex, Math.max(0, document.slideOrder.length - 1))]
    : undefined
  if (!document || !slideId) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-2xl bg-black">
        <Spinner />
      </div>
    )
  }

  return <EditableSlideSurface document={document} slideId={slideId} className="rounded-2xl" />
}
