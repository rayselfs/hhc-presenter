import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import CameraWorkspacePage from '../CameraWorkspacePage'
vi.mock('@renderer/contexts/CameraSessionContext', () => ({
  useCameraSession: () => ({
    stream: null,
    selectSource: vi.fn(),
    enable: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    retry: vi.fn()
  })
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key })
}))
it('shows canvas and reset without duplicate header controls', () => {
  render(
    <MemoryRouter>
      <CameraWorkspacePage />
    </MemoryRouter>
  )
  expect(screen.getByTestId('camera-editor')).toBeVisible()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByRole('heading')).toBeNull()
  expect(screen.getAllByRole('button')).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'camera.lock' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'camera.reset' })).toBeDisabled()
  expect(screen.queryByText(/contain|stretch/i)).toBeNull()
})
