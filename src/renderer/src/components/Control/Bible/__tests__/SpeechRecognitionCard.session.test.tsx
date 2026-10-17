import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SpeechRecognitionCard from '../SpeechRecognitionCard'
import { loadSpeechKey } from '@renderer/lib/speech-key-storage'
import { createSpeechAdapter } from '@renderer/lib/speech-adapter'
import { useSettingsStore } from '@renderer/stores/settings'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } })
}))
vi.mock('@renderer/lib/speech-key-storage', () => ({ loadSpeechKey: vi.fn() }))
vi.mock('@renderer/lib/speech-adapter', () => ({ createSpeechAdapter: vi.fn() }))

const adapter = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  dispose: vi.fn(),
  isRecognizing: () => false,
  on: vi.fn(() => () => {})
}
let grantKey: (key: string) => void
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadSpeechKey).mockReturnValue(
    new Promise((resolve) => {
      grantKey = resolve
    })
  )
  vi.mocked(createSpeechAdapter).mockResolvedValue(adapter)
  const speech = useSettingsStore.getState().speech
  useSettingsStore.setState({
    speech: { ...speech, activeProvider: 'azure', azure: { ...speech.azure, region: 'eastus' } }
  })
})
afterEach(() => vi.restoreAllMocks())

it('allows stopping while the key is pending and never starts the late adapter', async () => {
  const card = render(<SpeechRecognitionCard />)
  fireEvent.click(screen.getByRole('button', { name: 'bible.speech.start' }))
  fireEvent.click(screen.getByRole('button', { name: 'bible.speech.stop' }))
  await act(async () => {
    grantKey('synthetic-key')
  })
  await waitFor(() => expect(adapter.dispose).toHaveBeenCalledOnce())
  expect(adapter.start).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'bible.speech.start' })).toBeEnabled()
  card.unmount()
})

it('does not start a late adapter after leaving the Card', async () => {
  const card = render(<SpeechRecognitionCard />)
  fireEvent.click(screen.getByRole('button', { name: 'bible.speech.start' }))
  card.unmount()
  await act(async () => {
    grantKey('synthetic-key')
  })
  expect(adapter.start).not.toHaveBeenCalled()
  expect(adapter.dispose).toHaveBeenCalledOnce()
})
