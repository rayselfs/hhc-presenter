import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useCameraStore } from '@renderer/stores/camera'
import CameraWorkspacePage from '../CameraWorkspacePage'
const projection = vi.hoisted(() => ({
  activeOwner: 'timer',
  isProjectionOpen: true,
  startProjection: vi.fn().mockResolvedValue({ ok: true })
}))
vi.mock('@renderer/contexts/ProjectionContext', () => ({ useProjection: () => projection }))
const camera = vi.hoisted(() => ({ stream: null as MediaStream | null, reset: vi.fn() }))
vi.mock('@renderer/components/Common/CameraStage', () => ({ default: () => null }))
vi.mock('@renderer/contexts/CameraSessionContext', () => ({
  useCameraSession: () => ({
    stream: camera.stream,
    selectSource: vi.fn(),
    enable: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    reset: camera.reset,
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
  expect(screen.getAllByRole('button')).toHaveLength(3)
  expect(screen.getByRole('button', { name: 'camera.present' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'camera.lock' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'camera.reset' })).toBeDisabled()
  expect(screen.queryByText(/contain|stretch/i)).toBeNull()
})

it('explicitly presents the camera into an already open projection', () => {
  useCameraStore.setState({ capturing: true })
  render(
    <MemoryRouter>
      <CameraWorkspacePage />
    </MemoryRouter>
  )
  fireEvent.click(screen.getByRole('button', { name: 'camera.present' }))
  expect(projection.startProjection).toHaveBeenCalledWith('camera')
  useCameraStore.setState({ capturing: false })
})

it('requires confirmation before resetting framing and cancellation preserves it', async () => {
  camera.stream = {} as MediaStream
  useCameraStore.setState({ locked: false })
  render(
    <MemoryRouter>
      <CameraWorkspacePage />
    </MemoryRouter>
  )
  fireEvent.click(screen.getByRole('button', { name: 'camera.reset' }))
  expect(camera.reset).not.toHaveBeenCalled()
  await screen.findByText('camera.resetTitle')
  fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
  expect(camera.reset).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'camera.reset' }))
  fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }))
  expect(camera.reset).toHaveBeenCalledOnce()
  camera.stream = null
})
