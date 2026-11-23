import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '@renderer/i18n'
import { BiblePreview } from '../BiblePreview'
import SpeechRecognitionCard from '../SpeechRecognitionCard'
import { useBibleSettingsStore } from '@renderer/stores/bible-settings'
import { useBibleStore } from '@renderer/stores/bible'
const audio = vi.hoisted(() => ({ emit: (_text: string): void => {} }))
const projection = vi.hoisted(() => ({ startProjection: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@renderer/contexts/ProjectionContext', () => ({ useProjection: () => projection }))
vi.mock('@renderer/lib/openai-key', () => ({ hasSpeechKey: async () => true }))
vi.mock('@renderer/lib/openai-transcription', () => ({
  OpenAITranscription: class {
    constructor(options: { onText: (text: string) => void }) {
      audio.emit = options.onText
    }
    start = vi.fn().mockResolvedValue(undefined)
    close = vi.fn()
  }
}))
it('waits for an explicit verse and only navigates after selection', async () => {
  useBibleSettingsStore.setState({ selectedVersionId: 1 })
  const initial = { bookNumber: 19, chapter: 23, verse: 1 }
  useBibleStore.setState({
    currentPassage: initial,
    content: new Map([
      [
        1,
        [
          {
            number: 43,
            name: '約翰福音',
            abbreviation: '約',
            code: 'John',
            chapters: [
              {
                number: 3,
                verses: [
                  { id: 1, number: 16, text: '測試節文' },
                  { id: 2, number: 17, text: '下一節' }
                ]
              }
            ]
          }
        ]
      ]
    ])
  })
  render(
    <>
      <SpeechRecognitionCard />
      <BiblePreview
        selectedVerseIndex={0}
        onSelectedVerseIndexChange={vi.fn()}
        onContextMenu={vi.fn()}
        scrollBehaviorRef={{ current: 'instant' }}
        projectedPassage={initial}
        onProjected={vi.fn()}
      />
    </>
  )
  fireEvent.click(screen.getByRole('button', { name: /start|開始/i }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/listening|聆聽/i))
  act(() => audio.emit('約翰福音第三章'))
  expect(screen.queryByText('測試節文')).toBeNull()
  act(() => audio.emit('第十六至十七節'))
  const candidate = screen.getByRole('button', { name: /3:16–17/ })
  expect(candidate).toHaveTextContent('測試節文 下一節')
  expect(useBibleStore.getState().currentPassage).toEqual(initial)
  fireEvent.click(candidate)
  expect(useBibleStore.getState().currentPassage).toEqual({
    bookNumber: 43,
    chapter: 3,
    verse: 16,
    endVerse: 17
  })
  expect(projection.startProjection).not.toHaveBeenCalled()
  const previewVerse = screen.getByRole('button', { name: /^17\s*下一節$/ })
  act(() => audio.emit('約翰福音第三章第十六節'))
  expect(useBibleStore.getState().currentPassage?.endVerse).toBe(17)
  expect(projection.startProjection).not.toHaveBeenCalled()
  fireEvent.click(previewVerse)
  expect(projection.startProjection).toHaveBeenCalledExactlyOnceWith('bible', [
    ['bible:settings', expect.any(Object)],
    ['bible:chapter', expect.objectContaining({ bookNumber: 43, chapter: 3, currentVerse: 17 })]
  ])
})
