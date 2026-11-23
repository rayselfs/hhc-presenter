import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '@renderer/i18n'
import SpeechRecognitionCard from '../SpeechRecognitionCard'
import { useBibleSettingsStore } from '@renderer/stores/bible-settings'
import { useBibleStore } from '@renderer/stores/bible'
const audio = vi.hoisted(() => ({ emit: (_text: string): void => {} }))
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
  render(<SpeechRecognitionCard />)
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
})
