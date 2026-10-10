import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { X } from 'lucide-react'
import { Button } from '@heroui/react'
import { toast } from '@heroui/react/toast'
import { useTranslation } from 'react-i18next'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import {
  resolveMediaProjectionAction,
  type MediaProjectionActionResult
} from '@renderer/stores/media-projection'
import { SHORTCUTS } from '@renderer/config/shortcuts'
import { matchesConfig } from '@renderer/hooks/useKeyboardShortcuts'
import { useThumbnails } from '@renderer/hooks/useThumbnails'
import GlassDivider from '@renderer/components/Common/GlassDivider'
import { getMediaType } from '@renderer/lib/presentability'
import PresentationGrid from './PresentationGrid'
import type { FileItemRecord } from '@shared/types/folder'

interface GridItemProps {
  item: FileItemRecord
  index: number
  isFocused: boolean
  thumbnail: string | null
  onSelect: (index: number) => void
  onMouseEnter: (index: number) => void
  buttonRef?: React.Ref<HTMLButtonElement>
}

interface PresenterGridProps {
  previewCache?: Record<string, string | null>
}

const gridItemRenderCounts = new Map<string, number>()

export const GridItem = React.memo(function GridItem({
  item,
  index,
  isFocused,
  thumbnail,
  onSelect,
  onMouseEnter,
  buttonRef
}: GridItemProps) {
  const isActive = useMediaProjectionStore((s) => s.currentIndex === index)
  const renderCount = (gridItemRenderCounts.get(item.id) ?? 0) + 1
  gridItemRenderCounts.set(item.id, renderCount)

  return (
    <button
      ref={buttonRef}
      data-testid={`grid-item-${index}`}
      data-render={renderCount}
      className={`relative aspect-video rounded overflow-hidden border-3 transition-colors ${
        isActive
          ? 'border-accent'
          : isFocused
            ? 'border-accent/80'
            : 'border-transparent hover:border-accent'
      }`}
      onMouseEnter={() => onMouseEnter(index)}
      onClick={() => onSelect(index)}
    >
      {thumbnail ? (
        <img src={thumbnail} className="w-full h-full object-cover" alt={item.name} />
      ) : (
        <div className="w-full h-full bg-default-200 flex items-center justify-center text-foreground/50 text-xs">
          {item.name}
        </div>
      )}
      {isActive && (
        <div className="absolute inset-0 bg-primary/10 flex items-center justify-center">
          <div className="w-3 h-3 rounded-full bg-primary" />
        </div>
      )}
      <div className="absolute bottom-1 right-1 text-foreground/70 text-xs bg-background/70 px-1 rounded">
        {index + 1}
      </div>
    </button>
  )
})

export default function PresenterGrid(props: PresenterGridProps): React.JSX.Element {
  const presentation = useMediaProjectionStore((state) => {
    const item = state.currentItem()
    return item && getMediaType(item.mimeType) === 'presentation' ? item : null
  })
  return (
    <div
      className="contents"
      onKeyDown={(event) => {
        if (
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing &&
          matchesConfig(event.nativeEvent, SHORTCUTS.MEDIA.TOGGLE_GRID)
        ) {
          event.preventDefault()
          event.stopPropagation()
          useMediaProjectionStore.getState().toggleGrid()
        }
      }}
    >
      {presentation ? (
        <PresentationGrid key={`${presentation.id}:${presentation.url}`} item={presentation} />
      ) : (
        <FileGrid {...props} />
      )}
    </div>
  )
}

function FileGrid({ previewCache }: PresenterGridProps): React.JSX.Element {
  const { t } = useTranslation()
  const playlist = useMediaProjectionStore((s) => s.playlist)
  const jumpTo = useMediaProjectionStore((s) => s.jumpTo)
  const toggleGrid = useMediaProjectionStore((s) => s.toggleGrid)
  const fallbackThumbnails = useThumbnails(playlist)
  const thumbnails = previewCache ?? fallbackThumbnails
  const failureMessageRef = useRef(
    t('presentationWorkspace.saveFailed', 'Unable to save presentation')
  )
  failureMessageRef.current = t('presentationWorkspace.saveFailed', 'Unable to save presentation')

  const selectItem = useCallback(
    async (index: number): Promise<void> => {
      const outcome = await resolveMediaProjectionAction(
        jumpTo(index) as MediaProjectionActionResult
      )
      if (outcome.status === 'success') toggleGrid()
      else if (outcome.status === 'blocked') toast.danger(failureMessageRef.current)
    },
    [jumpTo, toggleGrid]
  )

  const [focusedIndex, setFocusedIndex] = useState(
    () => useMediaProjectionStore.getState().currentIndex
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])

  const getButtonRefCallbacks = useMemo(() => {
    const callbacks: Array<(el: HTMLButtonElement | null) => void> = []
    for (let i = 0; i < playlist.length; i++) {
      callbacks.push((el) => {
        buttonRefs.current[i] = el
      })
    }
    return callbacks
  }, [playlist.length])

  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  useEffect(() => {
    buttonRefs.current[focusedIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [focusedIndex])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    const cols = window.innerWidth >= 1024 ? 6 : 4
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        setFocusedIndex((i) => Math.min(i + 1, playlist.length - 1))
        break
      case 'ArrowLeft':
        e.preventDefault()
        setFocusedIndex((i) => Math.max(i - 1, 0))
        break
      case 'ArrowDown':
        e.preventDefault()
        setFocusedIndex((i) => Math.min(i + cols, playlist.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setFocusedIndex((i) => Math.max(i - cols, 0))
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        void selectItem(focusedIndex)
        break
      case 'Escape':
        e.preventDefault()
        toggleGrid()
        break
    }
  }

  const handleMouseEnter = useCallback((index: number) => {
    setFocusedIndex(index)
  }, [])

  return (
    <div className="fixed inset-0 bg-background z-10000 flex flex-col overflow-hidden">
      <div className="shrink-0 flex items-center px-4 py-2 bg-background">
        <Button
          isIconOnly
          variant="ghost"
          size="sm"
          onPress={toggleGrid}
          aria-label={t('common.close')}
        >
          <X size={18} />
        </Button>
      </div>

      <GlassDivider />

      <div
        ref={containerRef}
        tabIndex={0}
        className="flex-1 overflow-y-auto p-6 outline-none"
        onKeyDown={handleKeyDown}
      >
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6">
          {playlist.map((item, index) => (
            <GridItem
              key={item.id}
              item={item}
              index={index}
              isFocused={index === focusedIndex}
              thumbnail={thumbnails[item.id] ?? null}
              onSelect={selectItem}
              onMouseEnter={handleMouseEnter}
              buttonRef={getButtonRefCallbacks[index]}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
