import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Grid2X2, Highlighter, Search, Undo2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BulletinHighlight, BulletinPosition } from '@shared/bulletin-reader'
import type { BulletinProjectionView } from '@shared/bulletin-projection'
import type { WeeklyDocument, WeeklyIssue } from '@shared/weekly-reader'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import {
  bulletinHighlightKey,
  useBulletinHighlightsStore
} from '@renderer/stores/bulletin-highlights'
import BulletinPageView from './BulletinPageView'

const control =
  'inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-lg px-2 hover:bg-default/60 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 aria-pressed:bg-accent aria-pressed:text-accent-foreground'

interface Props {
  document: WeeklyDocument
  issue: WeeklyIssue
  accountId: string
  onExit: () => void
}

export default function BulletinPresentation({
  document,
  issue,
  accountId,
  onExit
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const { activeOwner, recovery, startProjection, stopProjection, getProjectionSnapshot, send } =
    useProjection()
  const [index, setIndex] = useState(0)
  const [grid, setGrid] = useState(false)
  const [zoom, setZoom] = useState(false)
  const [noteMode, setNoteMode] = useState(false)
  const [scale, setScale] = useState(1)
  const page = document.pages[index]
  const edition = bulletinHighlightKey(
    accountId,
    issue.documentId,
    issue.series,
    issue.locale,
    issue.revision
  )
  const groups = useBulletinHighlightsStore((state) => state.byEdition[edition])
  const highlights = useMemo(() => {
    const ids = new Set(
      page?.blocks.flatMap((block) => block.fragments.map((fragment) => fragment.sentenceId))
    )
    return groups?.flat().filter((range) => ids.has(range.sentenceId)) ?? []
  }, [groups, page])
  const add = useCallback(
    (ranges: BulletinHighlight[]) => useBulletinHighlightsStore.getState().add(edition, ranges),
    [edition]
  )
  const scroll = useRef<{ pageId: string; position: BulletinPosition } | null>(null)
  const view = useRef<BulletinProjectionView | null>(null)

  useLayoutEffect(() => {
    view.current = page
      ? {
          page,
          fontScale: scale,
          highlights,
          traceCode: document.traceCode,
          position: scroll.current?.pageId === page.id ? scroll.current.position : null
        }
      : null
    if (getProjectionSnapshot()?.owner === 'bulletin') send('bulletin:view', view.current)
  }, [document.traceCode, getProjectionSnapshot, highlights, page, scale, send])

  const present = useCallback((): void => {
    if (view.current) void startProjection('bulletin', [['bulletin:view', view.current]])
  }, [startProjection])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) present()
    })
    return () => {
      active = false
      if (getProjectionSnapshot()?.owner !== 'bulletin') return
      send('bulletin:view', null)
      void stopProjection()
    }
  }, [getProjectionSnapshot, present, send, stopProjection])

  const syncPosition = useCallback(
    (position: BulletinPosition): void => {
      if (!view.current || !page || view.current.page.id !== page.id) return
      scroll.current = { pageId: page.id, position }
      view.current = { ...view.current, position }
      if (getProjectionSnapshot()?.owner === 'bulletin') send('bulletin:scroll', scroll.current)
    },
    [getProjectionSnapshot, page, send]
  )

  const goTo = useCallback(
    (next: number): void => {
      if (next !== index) scroll.current = null
      setIndex(next)
      setGrid(false)
    },
    [index]
  )

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !window.getSelection()?.isCollapsed ||
        (event.target instanceof HTMLElement &&
          (event.target.isContentEditable || event.target.closest('input, textarea, select')))
      )
        return
      if (event.key === 'Escape') {
        if (grid) setGrid(false)
        else if (zoom) setZoom(false)
        else onExit()
      } else if (event.key === 'ArrowLeft' && index > 0) goTo(index - 1)
      else if (event.key === 'ArrowRight' && index < document.pages.length - 1) goTo(index + 1)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [document.pages.length, goTo, grid, index, onExit, zoom])

  const title = [issue.issueNumber, issue.title].filter(Boolean).join(' - ')
  const needsProjection =
    recovery.status === 'failed' || recovery.status === 'closed' || activeOwner !== 'bulletin'
  const pageChoice = (candidate: typeof page, i: number, thumbnail = false): React.JSX.Element => (
    <button
      key={candidate.id}
      type="button"
      aria-current={index === i ? 'page' : undefined}
      onClick={() => goTo(i)}
      className={`rounded-xl border border-default/70 p-3 text-start hover:border-accent aria-[current=page]:border-accent aria-[current=page]:bg-accent/10 ${thumbnail ? 'min-h-32' : ''}`}
    >
      <span className="block text-sm font-semibold">{candidate.label}</span>
      <span className="mt-1 line-clamp-2 text-xs text-muted">
        {
          candidate.blocks
            .flatMap((block) => block.fragments)
            .find((fragment) => fragment.text.trim())?.text
        }
      </span>
    </button>
  )

  return (
    <div className="flex h-full flex-col gap-2 bg-background p-3 text-foreground">
      <header className="flex flex-wrap items-center gap-2">
        <button type="button" className={control} onClick={onExit} aria-label={t('common.close')}>
          <X size={20} />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
        {needsProjection && (
          <button type="button" className={control} onClick={present}>
            {t('fileExplorer.presenter.retryProjection')}
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 gap-3">
        <nav
          aria-label={t('bulletinPresentation.pages')}
          className="flex w-28 shrink-0 flex-col gap-2 overflow-y-auto md:w-48"
        >
          {document.pages.map((candidate, i) => pageChoice(candidate, i))}
        </nav>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-default/70">
          {page && (
            <div className="min-h-0 flex-1">
              <BulletinPageView
                page={page}
                fontScale={scale}
                noteMode={noteMode}
                highlights={highlights}
                onHighlight={add}
                onPositionChange={syncPosition}
              />
            </div>
          )}
          <div className="flex justify-between bg-[#fffdf7] px-4 pb-1 text-xs text-[#59554b]">
            <span>{page?.label}</span>
            <span>{document.traceCode}</span>
          </div>
          {grid && (
            <div
              role="group"
              aria-label={t('bulletinPresentation.grid')}
              className="absolute inset-0 grid auto-rows-min grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3 overflow-y-auto bg-background p-4"
            >
              {document.pages.map((candidate, i) => pageChoice(candidate, i, true))}
            </div>
          )}
        </div>
      </div>
      <footer className="presenter-toolbar relative flex shrink-0 flex-wrap items-center justify-center gap-2 py-1">
        <div className="flex flex-wrap items-center gap-1 sm:mr-auto">
          {' '}
          <button
            type="button"
            className={`presenter-control-button rounded-full ${control}`}
            aria-label={t('bulletinPresentation.grid')}
            title={t('bulletinPresentation.grid')}
            aria-pressed={grid}
            onClick={() => setGrid(!grid)}
          >
            <Grid2X2 className="presenter-control-icon" />
          </button>
          <button
            type="button"
            className={`presenter-control-button rounded-full ${control}`}
            aria-label={t('bulletinPresentation.zoom')}
            title={t('bulletinPresentation.zoom')}
            aria-expanded={zoom}
            onClick={() => setZoom(!zoom)}
          >
            <Search className="presenter-control-icon" />
          </button>
          <button
            type="button"
            className={`presenter-control-button rounded-full ${control}`}
            aria-label={t('bulletinPresentation.note')}
            title={t('bulletinPresentation.note')}
            aria-pressed={noteMode}
            onClick={() => setNoteMode(!noteMode)}
          >
            <Highlighter className="presenter-control-icon" />
          </button>
          {noteMode && (
            <button
              type="button"
              className={`presenter-control-button rounded-full ${control}`}
              aria-label={t('bulletinPresentation.undo')}
              title={t('bulletinPresentation.undo')}
              disabled={!groups?.length}
              onClick={() => useBulletinHighlightsStore.getState().undo(edition)}
            >
              <Undo2 className="presenter-control-icon" />
            </button>
          )}
          {zoom && (
            <label className="flex items-center flex-wrap gap-3 px-2 text-sm">
              {t('bulletinPresentation.zoom')}
              <input
                type="range"
                min="0.75"
                max="2"
                step="0.05"
                value={scale}
                onChange={(event) => setScale(Number(event.target.value))}
              />
              <output>{Math.round(scale * 100)}%</output>
            </label>
          )}
        </div>
        <button
          type="button"
          className={control}
          disabled={index === 0}
          aria-label={t('bulletinPresentation.previous')}
          onClick={() => goTo(index - 1)}
        >
          <ChevronLeft />
        </button>
        <span className="tabular-nums">
          {index + 1} / {document.pages.length}
        </span>
        <button
          type="button"
          className={control}
          disabled={index >= document.pages.length - 1}
          aria-label={t('bulletinPresentation.next')}
          onClick={() => goTo(index + 1)}
        >
          <ChevronRight />
        </button>
      </footer>
    </div>
  )
}
