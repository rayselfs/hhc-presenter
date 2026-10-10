import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@heroui/react'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import GlassDivider from '@renderer/components/Common/GlassDivider'
import { isPresentationItem } from '@renderer/lib/presentation-media'
import NextItemPreview from './Preview/NextItemPreview'

function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms: number
): ((...args: Args) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const debounced = (...args: Args): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
  debounced.cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  return debounced
}

interface PresenterSidebarProps {
  previewCache: Record<string, string | null>
  onNext: () => void
}

export default function PresenterSidebar({
  previewCache,
  onNext
}: PresenterSidebarProps): React.JSX.Element {
  const { t } = useTranslation()
  const nextItem = useMediaProjectionStore((s) => s.nextItem())
  const currentItem = useMediaProjectionStore((s) => s.currentItem())
  const presentation = useMediaProjectionStore((s) => s.typeStates.presentation)
  const pendingSlide = isPresentationItem(currentItem) && !presentation?.slideCount
  const nextSlideIndex =
    isPresentationItem(currentItem) &&
    presentation?.slideCount &&
    presentation.slideIndex + 1 < presentation.slideCount
      ? presentation.slideIndex + 1
      : undefined
  const previewItem = nextSlideIndex !== undefined ? currentItem : nextItem
  const updateNotes = useMediaProjectionStore((s) => s.updateNotes)

  const [notes, setNotes] = useState(currentItem?.notes ?? '')
  const [notesFontSize, setNotesFontSize] = useState(() =>
    parseInt(localStorage.getItem('hhc-notes-font-size') ?? '14', 10)
  )

  const debouncedUpdateNotes = useMemo(
    () =>
      debounce((itemId: string, value: string) => {
        updateNotes(itemId, value)
      }, 300),
    [updateNotes]
  )

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setNotes(currentItem?.notes ?? '')
    })
    return () => cancelAnimationFrame(raf)
  }, [currentItem?.id, currentItem?.notes])

  useEffect(() => {
    return () => {
      debouncedUpdateNotes.cancel()
    }
  }, [debouncedUpdateNotes])

  const handleNotesChange = (value: string): void => {
    setNotes(value)
    if (currentItem) {
      debouncedUpdateNotes(currentItem.id, value)
    }
  }

  return (
    <div className="flex flex-col h-full bg-surface">
      <div className="shrink-0">
        <div className="h-12 flex items-center px-3 text-foreground/60 text-base font-medium">
          {t('presenter.next')}
        </div>
        <div className="px-4 pb-4">
          <div
            className="relative aspect-video bg-surface-secondary rounded-2xl overflow-hidden cursor-default"
            onClick={onNext}
          >
            {!previewItem && (
              <span className="absolute inset-0 flex items-center justify-center text-foreground/50 text-base">
                {t(pendingSlide ? 'presenter.loading' : 'presenter.endOfSlides')}
              </span>
            )}
            {previewItem && (
              <NextItemPreview
                key={previewItem.id}
                item={previewItem}
                slideIndex={nextSlideIndex}
                previewCache={previewCache}
              />
            )}
          </div>
        </div>
      </div>

      <GlassDivider />

      <div className="flex-1 relative overflow-hidden">
        <textarea
          className="absolute inset-0 bg-transparent text-foreground/90 p-3 pb-10 resize-none focus:outline-none placeholder:text-foreground/30"
          style={{ fontSize: `${notesFontSize}px` }}
          value={notes}
          onChange={(e) => handleNotesChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
              e.currentTarget.blur()
            }
          }}
          placeholder={t('presenter.notesPlaceholder')}
        />
        <div className="absolute bottom-2 left-2 flex gap-1">
          <Button
            isIconOnly
            variant="ghost"
            size="lg"
            onPress={() =>
              setNotesFontSize((s) => {
                const v = Math.min(s + 2, 28)
                localStorage.setItem('hhc-notes-font-size', String(v))
                return v
              })
            }
            aria-label={t('presentationWorkspace.increaseFontSize')}
          >
            A+
          </Button>
          <Button
            isIconOnly
            variant="ghost"
            size="lg"
            onPress={() =>
              setNotesFontSize((s) => {
                const v = Math.max(s - 2, 10)
                localStorage.setItem('hhc-notes-font-size', String(v))
                return v
              })
            }
            aria-label={t('presentationWorkspace.decreaseFontSize')}
          >
            A-
          </Button>
        </div>
      </div>
    </div>
  )
}
