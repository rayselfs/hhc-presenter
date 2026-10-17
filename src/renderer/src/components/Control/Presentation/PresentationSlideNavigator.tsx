import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavigatorRail } from '@renderer/components/Common/WorkspacePrimitives'
import EditableSlideSurface from '@renderer/components/Common/EditableSlideSurface'
import {
  getSlideBackgroundOutline,
  type EditablePresentationDocument
} from '@renderer/lib/editable-presentation'

interface PresentationSlideNavigatorProps {
  document: EditablePresentationDocument
  activeSlideIndex: number
  projectedSlideIndex: number
  selectedSlideIds: ReadonlySet<string>
  insertionIndex: number | null
  onContextMenu(event: React.MouseEvent): void
  onSelectSlide(index: number, event: React.MouseEvent): void
  onInsertionIndexChange(index: number): void
  onMoveSlides(targetIndex: number): void
  onDragSlideStart(slideId: string, event: React.DragEvent<HTMLButtonElement>): void
  onDragSlideEnd(): void
  onReorderSlide(slideId: string, targetIndex: number): void
  onAddSlideAfter(index: number): void
  onResizeStart(event: React.PointerEvent): void
}

export default function PresentationSlideNavigator({
  document,
  activeSlideIndex,
  projectedSlideIndex,
  selectedSlideIds,
  insertionIndex,
  onContextMenu,
  onSelectSlide,
  onInsertionIndexChange,
  onMoveSlides,
  onDragSlideStart,
  onDragSlideEnd,
  onReorderSlide,
  onAddSlideAfter,
  onResizeStart
}: PresentationSlideNavigatorProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <NavigatorRail
      data-slide-sidebar
      role="listbox"
      aria-multiselectable="true"
      className="presentation-slide-rail relative h-full min-h-0 overflow-y-auto border-r border-separator bg-surface/40 px-2 py-3"
      onContextMenu={onContextMenu}
    >
      <div className="space-y-1" role="presentation">
        {document.slideOrder.map((slideId, index) => {
          const isSelected =
            selectedSlideIds.size === 0 ? index === activeSlideIndex : selectedSlideIds.has(slideId)
          const slide = document.slides[slideId]
          const hasBackdropImage = slide.elementOrder.some((id) => {
            const element = slide.elements[id]
            return (
              (element.type === 'image' || element.type === 'locked') &&
              element.x <= 0 &&
              element.y <= 0 &&
              element.x + element.width >= document.width &&
              element.y + element.height >= document.height
            )
          })
          const outline = hasBackdropImage ? 'mixed' : getSlideBackgroundOutline(slide.background)
          return (
            <React.Fragment key={slideId}>
              <button
                type="button"
                data-slide-divider
                data-slide-index={index}
                className="group flex h-5 w-full items-center px-1"
                onClick={() => onInsertionIndexChange(index)}
                onDragOver={(event) => {
                  event.preventDefault()
                  onInsertionIndexChange(index)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  onMoveSlides(index)
                }}
                aria-label={t('presentationWorkspace.insertBeforeSlide', {
                  number: index + 1
                })}
              >
                <span
                  className={`w-full rounded-full ${
                    insertionIndex === index
                      ? 'h-[2px] presentation-insertion-line bg-[#f59e0b]'
                      : 'h-px bg-transparent group-focus-visible:bg-[#f59e0b]/70'
                  }`}
                />
              </button>
              <button
                draggable
                data-slide-option
                data-slide-index={index}
                role="option"
                aria-selected={isSelected}
                className="flex w-full gap-2 rounded-md px-1 py-2 text-left text-muted transition-colors hover:bg-surface-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500"
                onClick={(event) => onSelectSlide(index, event)}
                onDragStart={(event) => onDragSlideStart(slideId, event)}
                onDragEnd={onDragSlideEnd}
                onKeyDown={(event) => {
                  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                    event.preventDefault()
                    const target = event.key === 'ArrowUp' ? index - 1 : index + 2
                    onReorderSlide(slideId, target)
                    return
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    onAddSlideAfter(index)
                  }
                }}
              >
                <span
                  className={
                    isSelected
                      ? 'w-4 pt-1 text-right text-xs tabular-nums text-foreground'
                      : 'w-4 pt-1 text-right text-xs tabular-nums'
                  }
                >
                  {index + 1}
                </span>
                <span
                  className={`relative flex aspect-video w-full min-w-0 overflow-hidden border bg-black shadow-sm ${`${outline === 'dark' ? 'border-neutral-500' : 'border-white'} ${
                    isSelected ? 'ring-2 ring-[#f59e0b]' : ''
                  } ${outline === 'mixed' ? 'outline outline-1 outline-neutral-600' : ''}`}`}
                >
                  <EditableSlideThumbnail document={document} slideId={slideId} />
                  {index === projectedSlideIndex && (
                    <span
                      className="absolute inset-y-0 left-0 w-1 bg-success"
                      aria-label={t('presentationWorkspace.projectedSlide', 'Projected slide')}
                    />
                  )}
                  {index === projectedSlideIndex + 1 && projectedSlideIndex >= 0 && (
                    <span
                      className="absolute bottom-1 right-1 rounded bg-success/90 px-1 text-[10px] font-semibold text-white"
                      aria-label={t('presentationWorkspace.nextSlide', 'Next slide')}
                    >
                      {t('presentationWorkspace.next', 'Next')}
                    </span>
                  )}
                </span>
              </button>
            </React.Fragment>
          )
        })}
        <button
          type="button"
          data-slide-divider
          data-slide-index={document.slideOrder.length}
          className="group flex h-5 w-full items-center px-1"
          onClick={() => onInsertionIndexChange(document.slideOrder.length)}
          onDragOver={(event) => {
            event.preventDefault()
            onInsertionIndexChange(document.slideOrder.length)
          }}
          onDrop={(event) => {
            event.preventDefault()
            onMoveSlides(document.slideOrder.length)
          }}
          aria-label={t('presentationWorkspace.insertAfterLastSlide')}
        >
          <span
            className={`w-full rounded-full ${
              insertionIndex === document.slideOrder.length
                ? 'h-[2px] presentation-insertion-line bg-[#f59e0b]'
                : 'h-px bg-transparent group-focus-visible:bg-[#f59e0b]/70'
            }`}
          />
        </button>
      </div>
      <button
        type="button"
        className="absolute inset-y-0 right-0 w-1 cursor-col-resize bg-transparent hover:bg-accent/50 focus-visible:bg-accent"
        onPointerDown={onResizeStart}
        aria-label={t('presentationWorkspace.resizeSlideRail', 'Resize slide rail')}
      />
    </NavigatorRail>
  )
}

const EditableSlideThumbnail = React.memo(
  function EditableSlideThumbnail({
    document,
    slideId
  }: {
    document: EditablePresentationDocument
    slideId: string
  }): React.JSX.Element {
    const containerRef = useRef<HTMLDivElement>(null)
    const [isVisible, setIsVisible] = useState(() => typeof IntersectionObserver === 'undefined')

    useEffect(() => {
      const container = containerRef.current
      if (!container || isVisible) return
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setIsVisible(true)
            observer.disconnect()
          }
        },
        { rootMargin: '160px 0px' }
      )
      observer.observe(container)
      return () => observer.disconnect()
    }, [isVisible])

    return (
      <div ref={containerRef} className="h-full w-full">
        {isVisible && (
          <EditableSlideSurface
            document={document}
            slideId={slideId}
            className="pointer-events-none"
          />
        )}
      </div>
    )
  },
  (previous, next) =>
    previous.slideId === next.slideId &&
    previous.document.width === next.document.width &&
    previous.document.height === next.document.height &&
    previous.document.assets === next.document.assets &&
    previous.document.slides[previous.slideId] === next.document.slides[next.slideId]
)
