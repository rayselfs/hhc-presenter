import { useEffect, useLayoutEffect, useRef } from 'react'
import type { BulletinPage, BulletinHighlight, BulletinPosition } from '@shared/bulletin-reader'
import { followPosition, highlightRuns, readPosition, selectedHighlights } from './bulletin-text'

interface Props {
  page: BulletinPage
  fontScale: number
  highlights: BulletinHighlight[]
  noteMode?: boolean
  position?: BulletinPosition | null
  onPositionChange?: (position: BulletinPosition) => void
  onHighlight?: (ranges: BulletinHighlight[]) => void
}

export default function BulletinPageView({
  page,
  fontScale,
  highlights,
  noteMode = false,
  position,
  onPositionChange,
  onHighlight
}: Props): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const anchor = useRef<BulletinPosition | null>(null)
  const frame = useRef<number | null>(null)
  useLayoutEffect(() => {
    const root = scroller.current
    if (root) root.scrollTop = 0
    anchor.current = null
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [page.id])

  useLayoutEffect(() => {
    const root = scroller.current
    if (!root) return
    if (position !== undefined) anchor.current = position
    if (anchor.current) followPosition(root, anchor.current)
  }, [page.id, position, fontScale])

  useEffect(() => {
    const root = scroller.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (anchor.current) followPosition(root, anchor.current)
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  function publishPosition(): void {
    if (!onPositionChange || frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const root = scroller.current
      const next = root && readPosition(root)
      if (next) {
        anchor.current = next
        onPositionChange!(next)
      }
    })
  }

  function commitSelection(): void {
    const root = scroller.current
    const selection = root?.ownerDocument.getSelection()
    if (!noteMode || !onHighlight || !root || !selection) return
    const ranges = selectedHighlights(root, selection)
    if (!ranges.length) return
    onHighlight(ranges)
    selection.removeAllRanges()
  }

  return (
    <div
      ref={scroller}
      role="region"
      aria-label={page.label}
      tabIndex={onPositionChange ? 0 : undefined}
      className={`h-full min-h-0 w-full overflow-y-auto overscroll-contain bg-[#fffdf7] text-[#25231e] [container-type:inline-size] ${noteMode ? 'select-text' : 'select-none'}`}
      onScroll={publishPosition}
      onLoadCapture={() => {
        if (scroller.current && anchor.current) followPosition(scroller.current, anchor.current)
      }}
      onPointerUp={(event) => {
        if (event.button === 0) commitSelection()
      }}
      onKeyUp={(event) => {
        if (event.key === 'Shift') commitSelection()
      }}
    >
      <article
        className="mx-auto w-full max-w-[38em] px-[7%] py-[1.2em] leading-[1.65] [overflow-wrap:anywhere]"
        style={{ fontSize: `calc(clamp(1.25rem, 3.8cqw, 4.5rem) * ${fontScale})` }}
      >
        {page.blocks.map((block) => {
          const Tag = block.kind === 'heading' ? 'h2' : 'p'
          return (
            <div key={block.id} className="mb-[0.75em] last:mb-0">
              {block.image && block.image.src.startsWith('data:image/png;base64,') && (
                <img
                  src={block.image.src}
                  alt={block.image.alt}
                  className="mx-auto h-auto max-w-full"
                />
              )}
              <Tag
                className={`whitespace-pre-wrap ${block.kind === 'heading' ? 'font-bold leading-snug' : ''}`}
              >
                {block.fragments.map((fragment) => (
                  <span
                    key={JSON.stringify([fragment.sentenceId, fragment.start])}
                    data-bulletin-sentence={fragment.sentenceId}
                    data-start={fragment.start}
                  >
                    {highlightRuns(fragment, highlights).map((run) =>
                      run.marked ? (
                        <mark key={run.start} className="bg-[#ffeb58] text-[#221e10]">
                          {run.text}
                        </mark>
                      ) : (
                        <span key={run.start}>{run.text}</span>
                      )
                    )}
                  </span>
                ))}
              </Tag>
            </div>
          )
        })}
      </article>
    </div>
  )
}
