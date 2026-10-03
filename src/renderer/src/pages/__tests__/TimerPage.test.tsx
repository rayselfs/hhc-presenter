import { fireEvent, render, screen } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@renderer/i18n'
import { useTimerStore, DEFAULT_SETTINGS, DEFAULT_STATE } from '@renderer/stores/timer'
import { useStopwatchStore } from '@renderer/stores/stopwatch'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import TimerPage from '../TimerPage'

const projectionRecoveryMock = {
  recovery: { status: 'closed' as const, generation: 0, failure: null },
  vlcFailure: null,
  retryProjection: vi.fn(),
  sessionSummary: {
    owner: null,
    status: 'closed' as const,
    label: null,
    isBlackout: false,
    failure: null
  },
  ensureProjectionOpen: vi.fn(() => Promise.resolve({ ok: true as const, generation: 1 })),
  blackoutProjection: vi.fn(() => Promise.resolve()),
  getProjectionSnapshot: vi.fn(() => null)
}

vi.mock('@renderer/contexts/ProjectionContext', () => ({
  useProjection: vi.fn(() => ({
    isProjectionOpen: false,
    projectionReadyCount: 0,
    activeOwner: 'timer',
    ...projectionRecoveryMock,
    claimProjection: vi.fn(),
    startProjection: vi.fn(),
    stopProjection: vi.fn(),
    closeProjection: vi.fn(),
    project: vi.fn(),
    send: vi.fn(),
    on: vi.fn()
  }))
}))

function renderTimerPage(): RenderResult {
  return render(
    <I18nextProvider i18n={i18n}>
      <TimerPage />
    </I18nextProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useTimerStore.setState({
    ...DEFAULT_SETTINGS,
    ...DEFAULT_STATE,
    targetEndTime: null,
    presets: []
  })
  useStopwatchStore.setState({
    status: 'stopped',
    elapsedMs: 0,
    startTimestamp: null,
    accumulatedMs: 0
  })
})

describe('TimerPage — TIMER mode', () => {
  it('renders TimerDisplay (SVG ring) in timer mode', () => {
    useTimerStore.setState({ mode: 'timer' })
    const { container } = renderTimerPage()
    expect(container.querySelector('svg circle')).toBeInTheDocument()
  })

  it('renders TimerControls start button in timer mode', () => {
    useTimerStore.setState({ mode: 'timer', status: 'stopped' })
    renderTimerPage()
    expect(screen.getByTestId('btn-start')).toBeInTheDocument()
  })

  it('does not render ClockDisplay in timer mode', () => {
    useTimerStore.setState({ mode: 'timer' })
    renderTimerPage()
    expect(screen.queryByTestId('clock-display')).not.toBeInTheDocument()
  })

  it('does not render StopwatchDisplay in timer mode', () => {
    useTimerStore.setState({ mode: 'timer' })
    renderTimerPage()
    expect(screen.queryByTestId('stopwatch-display')).not.toBeInTheDocument()
  })
})

describe('TimerPage — CLOCK mode', () => {
  it('renders TimerDisplay (SVG ring) in clock mode', () => {
    useTimerStore.setState({ mode: 'clock' })
    const { container } = renderTimerPage()
    expect(container.querySelector('svg circle')).toBeInTheDocument()
  })

  it('renders TimerControls with enabled start in clock mode (auto-switches to both)', () => {
    useTimerStore.setState({ mode: 'clock', status: 'stopped' })
    renderTimerPage()
    expect(screen.getByTestId('btn-start')).not.toBeDisabled()
  })

  it('does not render ClockDisplay in clock mode (only on projection)', () => {
    useTimerStore.setState({ mode: 'clock' })
    renderTimerPage()
    expect(screen.queryByTestId('clock-display')).not.toBeInTheDocument()
  })
})

describe('TimerPage — BOTH mode', () => {
  it('renders TimerDisplay (SVG ring) in both mode', () => {
    useTimerStore.setState({ mode: 'both' })
    const { container } = renderTimerPage()
    expect(container.querySelector('svg circle')).toBeInTheDocument()
  })

  it('renders TimerControls start button in both mode', () => {
    useTimerStore.setState({ mode: 'both', status: 'stopped' })
    renderTimerPage()
    expect(screen.getByTestId('btn-start')).toBeInTheDocument()
    expect(screen.getByTestId('btn-start')).not.toBeDisabled()
  })

  it('does not render ClockDisplay in both mode (only on projection)', () => {
    useTimerStore.setState({ mode: 'both' })
    renderTimerPage()
    expect(screen.queryByTestId('clock-display')).not.toBeInTheDocument()
  })

  it('does not render StopwatchDisplay in both mode', () => {
    useTimerStore.setState({ mode: 'both' })
    renderTimerPage()
    expect(screen.queryByTestId('stopwatch-display')).not.toBeInTheDocument()
  })
})

describe('TimerPage — STOPWATCH mode', () => {
  it('renders StopwatchDisplay in stopwatch mode', () => {
    useTimerStore.setState({ mode: 'stopwatch' })
    renderTimerPage()
    expect(screen.getByTestId('stopwatch-display')).toBeInTheDocument()
  })

  it('renders TimerControls (start button) in stopwatch mode', () => {
    useTimerStore.setState({ mode: 'stopwatch' })
    renderTimerPage()
    expect(screen.getByTestId('btn-start')).toBeInTheDocument()
  })

  it('renders a static full ring (no progress arc) in stopwatch mode', () => {
    useTimerStore.setState({ mode: 'stopwatch' })
    const { container } = renderTimerPage()
    expect(container.querySelectorAll('circle')).toHaveLength(2)
  })

  it('displays formatted stopwatch time from store', () => {
    useTimerStore.setState({ mode: 'stopwatch' })
    useStopwatchStore.setState({ elapsedMs: 83000 })
    renderTimerPage()
    expect(screen.getByText('01:23')).toBeInTheDocument()
  })
})

describe('TimerPage — TimeInputPopover gating', () => {
  it('timer display is editable when timer is stopped', () => {
    useTimerStore.setState({ mode: 'timer', status: 'stopped' })
    renderTimerPage()
    expect(screen.getByRole('button', { name: /set duration/i })).toBeInTheDocument()
  })

  it('timer display is NOT editable when timer is running', () => {
    useTimerStore.setState({
      mode: 'timer',
      status: 'running',
      totalDuration: 300,
      targetEndTime: Date.now() + 300000
    })
    renderTimerPage()
    expect(screen.queryByRole('button', { name: /set duration/i })).not.toBeInTheDocument()
  })

  it('timer display is NOT editable when timer is paused', () => {
    useTimerStore.setState({
      mode: 'timer',
      status: 'paused',
      totalDuration: 300,
      remainingSeconds: 200
    })
    renderTimerPage()
    expect(screen.queryByRole('button', { name: /set duration/i })).not.toBeInTheDocument()
  })

  it('timer display IS editable in clock mode when stopped', () => {
    useTimerStore.setState({ mode: 'clock', status: 'stopped' })
    renderTimerPage()
    expect(screen.getByRole('button', { name: /set duration/i })).toBeInTheDocument()
  })
})

describe('TimerPage — projection ownership', () => {
  it.each(
    (['camera', 'bible', 'media'] as const).flatMap((owner) =>
      (['timer', 'clock', 'stopwatch'] as const).map((mode) => ({ owner, mode }))
    )
  )(
    'sends a complete $mode snapshot when returning from $owner with no running countdown',
    ({ owner, mode }) => {
      const send = vi.fn()
      vi.mocked(useProjection).mockReturnValue({
        ...useProjection(),
        isProjectionOpen: true,
        activeOwner: owner,
        send
      })
      useTimerStore.setState({ mode, status: 'stopped' })
      useStopwatchStore.setState({ showOnProjection: true })
      renderTimerPage()
      expect(send).toHaveBeenCalledWith('timer:tick', expect.objectContaining({ mode }))
      expect(send).toHaveBeenCalledWith('settings:timezone', expect.any(Object))
      expect(send).toHaveBeenCalledWith('settings:timer-ring-color', expect.any(Object))
      if (mode === 'stopwatch') {
        expect(send).toHaveBeenCalledWith('timer:stopwatch', expect.any(Object))
      }
    }
  )

  it('claims timer ownership with unblank when projection opens while timer is running', () => {
    const mockClaimProjection = vi.fn()

    vi.mocked(useProjection).mockReturnValue({
      isProjectionOpen: false,
      projectionReadyCount: 0,
      activeOwner: 'timer',
      ...projectionRecoveryMock,
      claimProjection: mockClaimProjection,
      startProjection: vi.fn(),
      stopProjection: vi.fn(),
      closeProjection: vi.fn(),
      project: vi.fn(),
      send: vi.fn(),
      on: vi.fn()
    })

    useTimerStore.setState({ status: 'running' })
    const { rerender } = renderTimerPage()

    vi.mocked(useProjection).mockReturnValue({
      isProjectionOpen: true,
      projectionReadyCount: 0,
      activeOwner: 'timer',
      ...projectionRecoveryMock,
      claimProjection: mockClaimProjection,
      startProjection: vi.fn(),
      stopProjection: vi.fn(),
      closeProjection: vi.fn(),
      project: vi.fn(),
      send: vi.fn(),
      on: vi.fn()
    })

    rerender(
      <I18nextProvider i18n={i18n}>
        <TimerPage />
      </I18nextProvider>
    )

    expect(mockClaimProjection).toHaveBeenCalledWith('timer', { unblank: true })
  })

  it('claims timer ownership without unblank when projection opens while timer is stopped', () => {
    const mockClaimProjection = vi.fn()

    vi.mocked(useProjection).mockReturnValue({
      isProjectionOpen: false,
      projectionReadyCount: 0,
      activeOwner: 'timer',
      ...projectionRecoveryMock,
      claimProjection: mockClaimProjection,
      startProjection: vi.fn(),
      stopProjection: vi.fn(),
      closeProjection: vi.fn(),
      project: vi.fn(),
      send: vi.fn(),
      on: vi.fn()
    })

    useTimerStore.setState({ status: 'stopped' })
    const { rerender } = renderTimerPage()

    vi.mocked(useProjection).mockReturnValue({
      isProjectionOpen: true,
      projectionReadyCount: 0,
      activeOwner: 'timer',
      ...projectionRecoveryMock,
      claimProjection: mockClaimProjection,
      startProjection: vi.fn(),
      stopProjection: vi.fn(),
      closeProjection: vi.fn(),
      project: vi.fn(),
      send: vi.fn(),
      on: vi.fn()
    })

    rerender(
      <I18nextProvider i18n={i18n}>
        <TimerPage />
      </I18nextProvider>
    )

    expect(mockClaimProjection).toHaveBeenCalledWith('timer', { unblank: false })
  })

  it('does not claim projection when projection is closed', () => {
    const mockClaimProjection = vi.fn()

    vi.mocked(useProjection).mockReturnValue({
      isProjectionOpen: false,
      projectionReadyCount: 0,
      activeOwner: 'timer',
      ...projectionRecoveryMock,
      claimProjection: mockClaimProjection,
      startProjection: vi.fn(),
      stopProjection: vi.fn(),
      closeProjection: vi.fn(),
      project: vi.fn(),
      send: vi.fn(),
      on: vi.fn()
    })

    useTimerStore.setState({ status: 'running' })
    renderTimerPage()

    expect(mockClaimProjection).not.toHaveBeenCalled()
  })
})

describe('TimerPage — Space projection action', () => {
  function mockProjectionForShortcut(): ReturnType<typeof vi.fn> {
    const startProjection = vi.fn(() => Promise.resolve({ ok: true as const, generation: 1 }))
    vi.mocked(useProjection).mockReturnValue({
      isProjectionOpen: true,
      projectionReadyCount: 1,
      activeOwner: 'timer',
      ...projectionRecoveryMock,
      claimProjection: vi.fn(),
      startProjection,
      stopProjection: vi.fn(),
      closeProjection: vi.fn(),
      project: vi.fn(),
      send: vi.fn(),
      on: vi.fn()
    })
    return startProjection
  }

  it('starts projection and timer when Space is pressed from stopped', () => {
    const startProjection = mockProjectionForShortcut()
    useTimerStore.setState({ status: 'stopped' })
    renderTimerPage()

    fireEvent.keyDown(document.body, { code: 'Space' })

    expect(startProjection).toHaveBeenCalledWith(
      'timer',
      expect.arrayContaining([['timer:tick', expect.any(Object)]])
    )
    expect(useTimerStore.getState().status).toBe('running')
  })

  it('starts projection and resumes timer when Space is pressed from paused', () => {
    const startProjection = mockProjectionForShortcut()
    useTimerStore.setState({ status: 'paused', remainingSeconds: 30 })
    renderTimerPage()

    fireEvent.keyDown(document.body, { code: 'Space' })

    expect(startProjection).toHaveBeenCalledWith(
      'timer',
      expect.arrayContaining([['timer:tick', expect.any(Object)]])
    )
    expect(useTimerStore.getState().status).toBe('running')
  })

  it('pauses without foregrounding when Space is pressed while running', () => {
    const startProjection = mockProjectionForShortcut()
    useTimerStore.setState({
      status: 'running',
      targetEndTime: Date.now() + 30_000,
      remainingSeconds: 30
    })
    renderTimerPage()

    fireEvent.keyDown(document.body, { code: 'Space' })

    expect(startProjection).not.toHaveBeenCalled()
    expect(useTimerStore.getState().status).toBe('paused')
  })
})
