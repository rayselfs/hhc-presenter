import { useEffect, useState, useCallback, useRef } from 'react'
import { useBibleStore } from '@renderer/stores/bible'
import { useBibleSettingsStore } from '@renderer/stores/bible-settings'
import { useBibleHistoryStore } from '@renderer/stores/bible-history'
import { BiblePreview } from '@renderer/components/Control/Bible/BiblePreview'
import BibleMultiFunction from '@renderer/components/Control/Bible/BibleMultiFunction'
import SpeechRecognitionCard from '@renderer/components/Control/Bible/SpeechRecognitionCard'
import { BibleSelectorDialog } from '@renderer/components/Control/Bible/BibleSelectorDialog'
import { useBibleContextMenu } from '@renderer/components/Control/Bible/useBibleContextMenu'
import type { VerseMenuData } from '@renderer/components/Control/Bible/useBibleContextMenu'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import { useBibleProjectionStore } from '@renderer/stores/bible-projection'
import { useAppInit } from '@renderer/contexts/AppInitContext'
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts'
import { SHORTCUTS } from '@renderer/config/shortcuts'
import { EVENTS } from '@renderer/config/events'
import { buildVerseHistoryItem } from '@renderer/lib/bible-utils'
import { getBibleProjectionSettingsPayload } from '@renderer/lib/bible-projection-settings'
import { startBibleProjection } from '@renderer/lib/projection-actions'
import type { BiblePassage } from '@shared/types/bible'
import type { ContentMessageTuple } from '@renderer/contexts/ProjectionContext'

type ProjectedPassage = { bookNumber: number; chapter: number; verse: number }

export default function BiblePage(): React.JSX.Element {
  const initialized = useAppInit()
  const {
    getCurrentVerses,
    getCurrentBook,
    getCurrentChapter,
    navigateTo,
    nextChapter,
    prevChapter
  } = useBibleStore.getState()
  const fontSize = useBibleSettingsStore((s) => s.fontSize)
  const scriptureTemplateId = useBibleSettingsStore((s) => s.scriptureTemplateId)
  const speechEnabled = useBibleSettingsStore((s) => s.speechEnabled)
  const [isSelectorOpen, setSelectorOpen] = useState(false)
  const [selectedVerseIndex, setSelectedVerseIndex] = useState(0)
  const [projectedPassage, setProjectedPassage] = useState<ProjectedPassage | null>(null)
  const scrollBehaviorRef = useRef<ScrollBehavior>('instant')
  const { showPreviewMenu } = useBibleContextMenu()
  const { project, startProjection, isProjectionOpen, activeOwner } = useProjection()

  const selectedVerseIndexRef = useRef(0)

  useEffect(() => {
    selectedVerseIndexRef.current = selectedVerseIndex
  })

  useEffect(() => {
    const settings = getBibleProjectionSettingsPayload()
    useBibleProjectionStore.getState().updateSettingsPayload(settings)
    if (isProjectionOpen) project('bible:settings', settings)
  }, [fontSize, scriptureTemplateId, isProjectionOpen, project])

  useEffect(() => {
    const handler = (): void => setSelectorOpen(true)
    window.addEventListener(EVENTS.OPEN_BIBLE_SELECTOR, handler)
    return () => window.removeEventListener(EVENTS.OPEN_BIBLE_SELECTOR, handler)
  }, [])

  const bookNumber = useBibleStore((s) => s.currentPassage?.bookNumber)
  const chapterNumber = useBibleStore((s) => s.currentPassage?.chapter)
  const passageVerse = useBibleStore((s) => s.currentPassage?.verse)
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      scrollBehaviorRef.current = 'instant'
      if (passageVerse && passageVerse > 1) {
        const verses = getCurrentVerses()
        const idx = verses ? verses.findIndex((v) => v.number === passageVerse) : -1
        setSelectedVerseIndex(idx >= 0 ? idx : 0)
      } else {
        setSelectedVerseIndex(0)
      }
    })
    return () => cancelAnimationFrame(id)
  }, [bookNumber, chapterNumber, passageVerse, getCurrentVerses])

  const projectVerse = useCallback(
    (verseIndex: number, skipHistory = false) => {
      window.dispatchEvent(new Event('bible:pause-speech'))
      const verses = getCurrentVerses()
      if (!verses || verses.length === 0) return
      const clamped = Math.max(0, Math.min(verseIndex, verses.length - 1))
      const verse = verses[clamped]
      if (!verse) return

      const book = getCurrentBook()
      const chapter = getCurrentChapter()
      if (!book || !chapter) return

      const payloads = [
        ['bible:settings', getBibleProjectionSettingsPayload()],
        [
          'bible:chapter',
          {
            bookNumber: book.number,
            chapter: chapter.number,
            chapterVerses: verses.map((v) => ({ number: v.number, text: v.text })),
            currentVerse: verse.number
          }
        ]
      ] satisfies ContentMessageTuple[]
      void startBibleProjection(payloads, { startProjection })
      navigateTo({ bookNumber: book.number, chapter: chapter.number, verse: verse.number })
      setSelectedVerseIndex(clamped)
      setProjectedPassage({ bookNumber: book.number, chapter: chapter.number, verse: verse.number })

      if (!skipHistory) {
        const { selectedVersionId } = useBibleSettingsStore.getState()
        const historyItem = buildVerseHistoryItem({
          versionId: selectedVersionId,
          bookNumber: book.number,
          chapter: chapter.number,
          verseNumber: verse.number,
          text: verse.text
        })
        useBibleHistoryStore.getState().addToHistory(historyItem)
      }
    },
    [getCurrentVerses, getCurrentBook, getCurrentChapter, startProjection, navigateTo]
  )

  const restoreCommittedPassage = useCallback((): number => {
    window.dispatchEvent(new Event('bible:pause-speech'))
    if (isProjectionOpen && activeOwner === 'bible') {
      const chapter = useBibleProjectionStore
        .getState()
        .lastPayloads?.find(([channel]) => channel === 'bible:chapter')
      if (chapter?.[0] === 'bible:chapter') {
        const payload = chapter[1]
        navigateTo({
          bookNumber: payload.bookNumber,
          chapter: payload.chapter,
          verse: payload.currentVerse
        })
        return Math.max(
          0,
          getCurrentVerses()?.findIndex((verse) => verse.number === payload.currentVerse) ?? 0
        )
      }
    }
    return selectedVerseIndexRef.current
  }, [isProjectionOpen, activeOwner, navigateTo, getCurrentVerses])

  const handleNextVerse = useCallback(() => {
    const baseIndex = restoreCommittedPassage()
    const verses = getCurrentVerses()
    if (!verses || verses.length === 0) return
    const next = Math.min(baseIndex + 1, verses.length - 1)
    scrollBehaviorRef.current = 'smooth'
    projectVerse(next, true)
  }, [getCurrentVerses, projectVerse, restoreCommittedPassage])

  const handlePrevVerse = useCallback(() => {
    const prev = Math.max(restoreCommittedPassage() - 1, 0)
    scrollBehaviorRef.current = 'smooth'
    projectVerse(prev, true)
  }, [projectVerse, restoreCommittedPassage])

  const handleNextChapter = useCallback(() => {
    restoreCommittedPassage()
    nextChapter()
    scrollBehaviorRef.current = 'instant'
    projectVerse(0, true)
  }, [nextChapter, projectVerse, restoreCommittedPassage])

  const handlePrevChapter = useCallback(() => {
    restoreCommittedPassage()
    prevChapter()
    scrollBehaviorRef.current = 'instant'
    projectVerse(0, true)
  }, [prevChapter, projectVerse, restoreCommittedPassage])

  const handleOpenSelector = useCallback(() => {
    setSelectorOpen(true)
  }, [])

  const handleCloseDialog = useCallback(() => {
    setSelectorOpen(false)
  }, [])

  const handleFocusSearch = useCallback(() => {
    const searchInput = document.querySelector<HTMLInputElement>('[data-bible-search]')
    searchInput?.focus()
  }, [])

  useKeyboardShortcuts(
    [
      {
        config: SHORTCUTS.BIBLE.PREV_VERSE,
        handler: handlePrevVerse,
        preventDefault: true
      },
      {
        config: SHORTCUTS.BIBLE.NEXT_VERSE,
        handler: handleNextVerse,
        preventDefault: true
      },
      {
        config: SHORTCUTS.BIBLE.NEXT_VERSE_ALT,
        handler: handleNextVerse,
        preventDefault: true
      },
      {
        config: SHORTCUTS.BIBLE.PREV_CHAPTER,
        handler: handlePrevChapter,
        preventDefault: true
      },
      {
        config: SHORTCUTS.BIBLE.NEXT_CHAPTER,
        handler: handleNextChapter,
        preventDefault: true
      },
      {
        config: SHORTCUTS.BIBLE.OPEN_SELECTOR,
        handler: handleOpenSelector,
        preventDefault: true
      },
      {
        config: SHORTCUTS.BIBLE.FOCUS_SEARCH,
        handler: handleFocusSearch,
        preventDefault: true
      },
      {
        config: SHORTCUTS.BIBLE.CLOSE_DIALOG,
        handler: handleCloseDialog,
        preventDefault: false
      }
    ],
    { enabled: true, sectionKey: 'bible' }
  )

  const handleSelectPassage = (passage: BiblePassage): void => {
    useBibleStore.getState().navigateTo(passage)
  }

  const handleContextMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const verseNumber = Number(event.currentTarget.dataset.verseNumber)
    if (!verseNumber) return
    const verses = getCurrentVerses()
    const book = getCurrentBook()
    const chapter = getCurrentChapter()
    if (!verses || !book || !chapter) return
    const verse = verses.find((v) => v.number === verseNumber)
    if (!verse) return
    const menuData: VerseMenuData = {
      bookNumber: book.number,
      chapter: chapter.number,
      verse: verse.number,
      text: verse.text
    }
    showPreviewMenu(menuData, event)
  }

  return (
    <div data-testid="bible-page" className="flex flex-row gap-4 h-full">
      {!initialized ? (
        <div className="flex items-center justify-center h-full w-full">
          <span className="text-default-400">Loading...</span>
        </div>
      ) : (
        <>
          <BiblePreview
            onContextMenu={handleContextMenu}
            selectedVerseIndex={selectedVerseIndex}
            onSelectedVerseIndexChange={setSelectedVerseIndex}
            scrollBehaviorRef={scrollBehaviorRef}
            projectedPassage={projectedPassage}
            onProjected={setProjectedPassage}
          />
          <div className="flex min-h-0 flex-col gap-4 flex-1 max-lg:flex-4">
            <div className={speechEnabled ? 'flex-1 min-h-0' : 'h-full min-h-0'}>
              <BibleMultiFunction onProjected={setProjectedPassage} />
            </div>
            {speechEnabled && (
              <div className="flex-1 min-h-0">
                <SpeechRecognitionCard />
              </div>
            )}
          </div>
          <BibleSelectorDialog
            isOpen={isSelectorOpen}
            onOpenChange={setSelectorOpen}
            onSelect={handleSelectPassage}
          />
        </>
      )}
    </div>
  )
}
