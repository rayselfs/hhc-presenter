vi.unmock('@heroui/react')
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_LYRICS_STYLE } from '@shared/lyrics'
import { useCameraLyricsStore } from '@renderer/stores/camera-lyrics'
import LyricsRecognitionControls from '../LyricsRecognitionControls'
const fonts = vi.hoisted(() => ({ supported: true, desktop: true, query: vi.fn() }))
vi.mock('@renderer/lib/env', () => ({ isElectron: () => fonts.desktop }))
vi.mock('@renderer/lib/local-fonts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/local-fonts')>()),
  supportsLocalFontAccess: () => fonts.supported,
  queryLocalFontFamiliesOnce: fonts.query
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key })
}))
beforeEach(() => {
  fonts.supported = true
  fonts.desktop = true
  fonts.query.mockReset().mockResolvedValue(['Arial', 'Noto Sans TC Variable', '<script>'])
  useCameraLyricsStore.setState({
    enabled: true,
    crop: { x: 0, y: 0, width: 1, height: 0.4 },
    style: { ...DEFAULT_LYRICS_STYLE }
  })
})
it('automatically loads desktop fonts and supports search and selection without a load button', async () => {
  const user = userEvent.setup()
  render(<LyricsRecognitionControls stream={null} />)
  await waitFor(() => expect(fonts.query).toHaveBeenCalledOnce())
  expect(screen.queryByRole('button', { name: 'cameraLyrics.loadLocalFonts' })).toBeNull()
  const input = screen.getByRole('combobox', { name: 'cameraLyrics.font' })
  await user.clear(input)
  await user.type(input, 'Arial')
  await user.click(await screen.findByRole('option', { name: 'Arial' }))
  expect(useCameraLyricsStore.getState().style.font).toBe('Arial')
  fireEvent.click(screen.getByRole('button', { name: 'cameraLyrics.bold' }))
  expect(useCameraLyricsStore.getState().style.bold).toBe(false)
})
it('keeps bundled fonts usable after failure and offers retry only then', async () => {
  fonts.query.mockRejectedValueOnce(new Error('denied'))
  render(<LyricsRecognitionControls stream={null} />)
  await screen.findByText('cameraLyrics.localFontsFailed')
  fireEvent.click(screen.getByRole('button', { name: 'cameraLyrics.retryFonts' }))
  await waitFor(() => expect(screen.queryByText('cameraLyrics.localFontsFailed')).toBeNull())
  expect(fonts.query).toHaveBeenCalledTimes(2)
})
it('preserves saved custom selection when enumeration is unsupported', () => {
  fonts.supported = false
  useCameraLyricsStore.setState({ style: { ...DEFAULT_LYRICS_STYLE, font: 'Custom Font' } })
  render(<LyricsRecognitionControls stream={null} />)
  expect(screen.getByRole('combobox')).toHaveValue('Custom Font')
  expect(fonts.query).not.toHaveBeenCalled()
})
it('requests ungranted browser font access from opening the picker, not on mount', async () => {
  fonts.desktop = false
  const user = userEvent.setup()
  render(<LyricsRecognitionControls stream={null} />)
  expect(fonts.query).not.toHaveBeenCalled()
  await user.click(screen.getByRole('combobox'))
  await waitFor(() => expect(fonts.query).toHaveBeenCalledOnce())
})
it('keeps source crop preview and all settings visible without manual controls or equipment hints', () => {
  useCameraLyricsStore.setState({ crop: { x: 0, y: 0.2, width: 1, height: 0.4 } })
  render(<LyricsRecognitionControls stream={null} />)
  expect(screen.getByTestId('lyrics-source-preview').querySelector('video')).not.toBeNull()
  expect(screen.getByTestId('lyrics-crop-overlay')).toHaveStyle({ top: '20%', height: '40%' })
  expect(screen.getByRole('spinbutton', { name: 'cameraLyrics.lineHeight' })).toBeVisible()
  for (const key of ['hide', 'edit', 'resume', 'advanced', 'keyHint', 'localFontHint']) {
    expect(screen.queryByText(`cameraLyrics.${key}`)).toBeNull()
  }
  expect(screen.getByRole('spinbutton', { name: 'cameraLyrics.height' })).toHaveAttribute(
    'max',
    '80'
  )
  fireEvent.change(screen.getByRole('spinbutton', { name: 'cameraLyrics.height' }), {
    target: { value: '99' }
  })
  expect(useCameraLyricsStore.getState().crop.height).toBe(0.8)
})

it('reports subtitle overflow without rendering an extra output preview', async () => {
  useCameraLyricsStore.setState({
    lines: ['First', 'Second', 'Third'],
    error: null,
    style: { ...DEFAULT_LYRICS_STYLE, fontSize: 160, lineHeight: 2, bottom: 50 }
  })
  render(<LyricsRecognitionControls stream={null} />)
  await screen.findByText('cameraLyrics.errors.overflow')
  expect(screen.queryByTestId('lyrics-output')).toBeNull()
})
