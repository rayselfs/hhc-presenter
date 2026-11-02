import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '@renderer/i18n'
import LocalSpeechCard from '../LocalSpeechCard'
vi.mock('@renderer/lib/env', () => ({ isElectron: () => false }))
afterEach(() => vi.unstubAllGlobals())
it('keeps unsupported browsers on manual search without starting cloud recognition', async () => {
  const start = vi.fn()
  vi.stubGlobal(
    'SpeechRecognition',
    class {
      start = start
    }
  )
  render(<LocalSpeechCard />)
  await waitFor(() => expect(screen.getByText(/cannot confirm|無法確認/)).toBeInTheDocument())
  expect(start).not.toHaveBeenCalled()
  expect(screen.queryByText(/Azure|GCP/)).toBeNull()
})
