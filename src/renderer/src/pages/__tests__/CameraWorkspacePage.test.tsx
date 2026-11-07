import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useCameraStore } from '@renderer/stores/camera'
import { useCameraLyricsStore } from '@renderer/stores/camera-lyrics'
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

it('shows only the active mode controls and restores raw framing', () => {
  useCameraLyricsStore.getState().setEnabled(false)
  render(
    <MemoryRouter>
      <CameraWorkspacePage />
    </MemoryRouter>
  )
  expect(screen.queryByRole('region', { name: 'cameraLyrics.title' })).toBeNull()
  expect(screen.getByRole('spinbutton', { name: 'camera.x' })).toBeVisible()
  act(() => useCameraLyricsStore.getState().setEnabled(true))
  expect(screen.queryByRole('spinbutton', { name: 'camera.x' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'camera.lock' })).toBeNull()
  expect(screen.queryByTestId('camera-editor')).toBeNull()
  expect(document.querySelector('video')).not.toBeNull()
  expect(screen.getByTestId('lyrics-source-preview')).toBeVisible()
  fireEvent.change(screen.getByRole('slider', { name: 'cameraLyrics.height' }), {
    target: { value: '55' }
  })
  expect(screen.getByRole('spinbutton', { name: 'cameraLyrics.height' })).toHaveValue(55)
  fireEvent.change(screen.getByRole('slider', { name: 'cameraLyrics.height' }), {
    target: { value: '40' }
  })
  expect(screen.getByRole('spinbutton', { name: 'cameraLyrics.height' })).toHaveValue(40)
  fireEvent.change(screen.getByRole('spinbutton', { name: 'cameraLyrics.height' }), {
    target: { value: '60' }
  })
  expect(useCameraLyricsStore.getState().crop.height).toBe(0.6)
  act(() => useCameraLyricsStore.getState().setEnabled(false))
  expect(screen.getByRole('spinbutton', { name: 'camera.x' })).toBeVisible()
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

it.each([320, 960])(
  'snaps camera dragging in preview pixels at width %i and clears guides',
  (width) => {
    camera.stream = {} as MediaStream
    useCameraStore.setState({
      locked: false,
      transform: { x: 380, y: 170, width: 960, height: 540 }
    })
    render(
      <MemoryRouter>
        <CameraWorkspacePage />
      </MemoryRouter>
    )
    const editor = screen.getByTestId('camera-editor')
    vi.spyOn(editor, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, width, (width * 9) / 16)
    )
    editor.setPointerCapture = vi.fn()
    editor.hasPointerCapture = () => false
    const scale = width / 1920
    const pointer = { pointerId: 1, button: 0 }
    fireEvent.pointerDown(editor, { ...pointer, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(editor, {
      ...pointer,
      clientX: 100 + 100 * scale + 5,
      clientY: 100 + 100 * scale - 5
    })
    expect(useCameraStore.getState().transform).toEqual({ x: 480, y: 270, width: 960, height: 540 })
    expect(screen.getByTestId('camera-guide-vertical')).toBeVisible()
    expect(screen.getByTestId('camera-guide-horizontal')).toBeVisible()
    fireEvent.pointerMove(editor, {
      ...pointer,
      clientX: 100 + 100 * scale + 12,
      clientY: 100 + 100 * scale - 5
    })
    expect(useCameraStore.getState().transform.x).toBeCloseTo(480 + 12 / scale)
    expect(screen.queryByTestId('camera-guide-vertical')).toBeNull()
    expect(screen.getByTestId('camera-guide-horizontal')).toBeVisible()
    fireEvent.pointerUp(editor, {
      ...pointer,
      clientX: 100 + 100 * scale,
      clientY: 100 + 100 * scale
    })
    expect(useCameraStore.getState().transform.x).toBe(480)
    expect(screen.queryByTestId('camera-guide-vertical')).toBeNull()
    expect(screen.queryByTestId('camera-guide-horizontal')).toBeNull()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'camera.x' }), {
      target: { value: '481' }
    })
    expect(useCameraStore.getState().transform.x).toBe(481)
    fireEvent.pointerDown(editor, { ...pointer, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(editor, { ...pointer, clientX: 100, clientY: 100 })
    expect(screen.getByTestId('camera-guide-vertical')).toBeVisible()
    if (width === 320) fireEvent.pointerCancel(editor, pointer)
    else fireEvent.lostPointerCapture(editor, pointer)
    expect(screen.queryByTestId('camera-guide-vertical')).toBeNull()
    fireEvent.pointerMove(editor, { ...pointer, clientX: 200, clientY: 200 })
    expect(useCameraStore.getState().transform.x).toBe(480)
    camera.stream = null
  }
)

it('shows center guides when a full-size source also aligns with every edge', () => {
  camera.stream = {} as MediaStream
  useCameraStore.setState({ locked: false, transform: { x: 0, y: 0, width: 1920, height: 1080 } })
  render(
    <MemoryRouter>
      <CameraWorkspacePage />
    </MemoryRouter>
  )
  const editor = screen.getByTestId('camera-editor')
  vi.spyOn(editor, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 960, 540))
  editor.setPointerCapture = vi.fn()
  fireEvent.pointerDown(editor, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(editor, { pointerId: 1, clientX: 105, clientY: 105 })
  expect(useCameraStore.getState().transform).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  expect(screen.getByTestId('camera-guide-vertical').style.left).toContain('50%')
  expect(screen.getByTestId('camera-guide-horizontal').style.top).toContain('50%')
  camera.stream = null
})

it('shows an accessible icon-only lock indicator and red active lock button', () => {
  camera.stream = {} as MediaStream
  useCameraStore.setState({ locked: false })
  render(
    <MemoryRouter>
      <CameraWorkspacePage />
    </MemoryRouter>
  )
  const lock = screen.getByRole('button', { name: 'camera.lock' })
  fireEvent.click(lock)
  expect(lock).toHaveAttribute('aria-pressed', 'true')
  expect(lock).toHaveAttribute('variant', 'danger')
  const indicator = screen.getByRole('status', { name: 'camera.locked' })
  expect(indicator.textContent).toBe('')
  camera.stream = null
  useCameraStore.setState({ locked: false })
})

it.each(['timer', 'bible', 'media'])(
  'explicitly reclaims projection from %s using the red page action',
  (owner) => {
    projection.activeOwner = owner
    projection.isProjectionOpen = true
    projection.startProjection.mockClear()
    useCameraStore.setState({ capturing: true })
    render(
      <MemoryRouter>
        <CameraWorkspacePage />
      </MemoryRouter>
    )
    expect(projection.startProjection).not.toHaveBeenCalled()
    const button = screen.getByRole('button', { name: 'camera.present' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(projection.startProjection).toHaveBeenCalledWith('camera')
    useCameraStore.setState({ capturing: false })
  }
)
