import { useState, useRef, useCallback } from 'react'

export interface RubberBandRect {
  left: number
  top: number
  width: number
  height: number
}

export interface UseItemSelectionReturn {
  selectedIds: Set<string>
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>
  lastSelectedId: string | null
  clearSelection: () => void
  selectAll: (orderedIds?: string[]) => void
  handleItemClick: (itemId: string, event: React.MouseEvent, orderedIds?: string[]) => void
  handleContainerClick: (event: React.MouseEvent) => void
  handleContainerMouseDown: (e: React.MouseEvent) => void
  rubberBandRect: RubberBandRect | null
  containerRef: React.RefObject<HTMLDivElement | null>
  justRubberBandedRef: React.MutableRefObject<boolean>
}

const EMPTY_IDS: string[] = []

export function useItemSelection(allIds: string[] = EMPTY_IDS): UseItemSelectionReturn {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null)
  const [rubberBandRect, setRubberBandRect] = useState<RubberBandRect | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const justRubberBandedRef = useRef(false)

  const clearSelection = useCallback((): void => {
    setSelectedIds(new Set())
    setLastSelectedId(null)
  }, [])

  const selectAll = useCallback(
    (orderedIds = allIds): void => {
      setSelectedIds(new Set(orderedIds))
    },
    [allIds]
  )

  const handleItemClick = useCallback(
    (itemId: string, event: React.MouseEvent, orderedIds = allIds): void => {
      event.stopPropagation()

      if (event.shiftKey && lastSelectedId) {
        const lastIndex = orderedIds.indexOf(lastSelectedId)
        const currentIndex = orderedIds.indexOf(itemId)
        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex)
          const end = Math.max(lastIndex, currentIndex)
          setSelectedIds(new Set(orderedIds.slice(start, end + 1)))
          return
        }
      }

      if (event.ctrlKey || event.metaKey) {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(itemId)) next.delete(itemId)
          else next.add(itemId)
          return next
        })
      } else {
        setSelectedIds(new Set([itemId]))
      }

      setLastSelectedId(itemId)
    },
    [allIds, lastSelectedId]
  )

  const handleContainerClick = useCallback(
    (event: React.MouseEvent): void => {
      if ((event.target as Element).closest('[data-file-item]')) return
      if (justRubberBandedRef.current) {
        justRubberBandedRef.current = false
        return
      }
      clearSelection()
    },
    [clearSelection]
  )

  const handleContainerMouseDown = useCallback((e: React.MouseEvent): void => {
    if (e.button !== 0) return
    if ((e.target as Element).closest('[data-file-item]')) return

    const startX = e.clientX
    const startY = e.clientY
    let currentRect: RubberBandRect | null = null

    const handleMouseMove = (moveEvent: MouseEvent): void => {
      const left = Math.min(startX, moveEvent.clientX)
      const top = Math.min(startY, moveEvent.clientY)
      const width = Math.abs(moveEvent.clientX - startX)
      const height = Math.abs(moveEvent.clientY - startY)
      currentRect = { left, top, width, height }
      setRubberBandRect(currentRect)

      const container = containerRef.current
      if (!container) return
      const newSelected = new Set<string>()
      container.querySelectorAll<HTMLElement>('[data-item-id]').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.left < left + width && r.right > left && r.top < top + height && r.bottom > top) {
          const id = el.dataset.itemId
          if (id) newSelected.add(id)
        }
      })
      setSelectedIds(newSelected)
      setLastSelectedId(null)
    }

    const handleMouseUp = (): void => {
      if (currentRect && (currentRect.width > 5 || currentRect.height > 5)) {
        justRubberBandedRef.current = true
      }
      setRubberBandRect(null)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }, [])

  return {
    selectedIds,
    setSelectedIds,
    lastSelectedId,
    clearSelection,
    selectAll,
    handleItemClick,
    handleContainerClick,
    handleContainerMouseDown,
    rubberBandRect,
    containerRef,
    justRubberBandedRef
  }
}
