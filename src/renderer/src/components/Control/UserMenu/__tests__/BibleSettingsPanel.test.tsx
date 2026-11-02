import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import '@renderer/i18n'
import BibleSettingsPanel from '../BibleSettingsPanel'
import { useSettingsStore } from '@renderer/stores/settings'
it('offers two plain-language choices without provider keys or model directories', async () => {
  useSettingsStore.getState().setSpeech({ recognitionLanguage: 'zh', microphoneId: '' })
  render(<BibleSettingsPanel />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button'))
  await user.click(await screen.findByRole('option', { name: 'English' }))
  expect(useSettingsStore.getState().speech.recognitionLanguage).toBe('en')
  expect(screen.queryByText(/Azure|GCP|modelDir/)).toBeNull()
})
