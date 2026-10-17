import { renderHook, act } from '@testing-library/react'
import { useTimerStore, DEFAULT_SETTINGS, DEFAULT_STATE } from '@renderer/stores/timer'
import { useStopwatchStore } from '@renderer/stores/stopwatch'
import { useSettingsStore } from '@renderer/stores/settings'

const mockProject = vi.fn()
const mockSend = vi.fn()
let mockIsProjectionOpen = false

vi.mock('@renderer/contexts/ProjectionContext', () => ({
  useProjection: vi.fn(() => ({
    project: mockProject,
    isProjectionOpen: mockIsProjectionOpen,
    projectionReadyCount: 0,
    activeOwner: 'timer',
    claimProjection: vi.fn(),
    startProjection: vi.fn(),
    stopProjection: vi.fn(),
    closeProjection: vi.fn(),
    send: mockSend,
    on: vi.fn()
  }))
}))

import TimerProjectionBridge from '../TimerProjectionBridge'

function renderBridge(): ReturnType<typeof renderHook<null, unknown>> {
  return renderHook(() => null, {
    wrapper: ({ children }) => (
      <>
        <TimerProjectionBridge />
        {children}
      </>
    )
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsProjectionOpen = false
  useTimerStore.setState({
    ...DEFAULT_SETTINGS,
    ...DEFAULT_STATE,
    presets: []
  })
  useStopwatchStore.setState({
    status: 'stopped',
    elapsedMs: 0,

    showOnProjection: false
  })
  useSettingsStore.setState({
    timezone: 'Asia/Taipei',
    timerRingColor: '#3b82f6',
    timerRingColorEnabled: true
  })
})

describe('TimerProjectionBridge — timer:tick projection', () => {
  it('sends timer:tick on mount with initial state', () => {
    useTimerStore.setState({ mode: 'timer' })
    renderBridge()
    expect(mockProject).toHaveBeenCalledWith(
      'timer:tick',
      expect.objectContaining({
        mode: 'timer',
        phase: 'idle'
      })
    )
  })

  it('sends timer:tick without unblank options when timer is running', () => {
    useTimerStore.setState({
      mode: 'timer',
      status: 'running',
      totalDuration: 300
    })
    renderBridge()
    expect(mockProject).toHaveBeenCalledWith(
      'timer:tick',
      expect.objectContaining({ mode: 'timer' })
    )
  })

  it('sends timer:tick without unblank options when timer is stopped', () => {
    useTimerStore.setState({ mode: 'timer', status: 'stopped' })
    renderBridge()
    expect(mockProject).toHaveBeenCalledWith(
      'timer:tick',
      expect.objectContaining({ mode: 'timer' })
    )
  })

  it('sends mode clock when stopwatch showOnProjection is false', () => {
    useTimerStore.setState({ mode: 'stopwatch' })
    useStopwatchStore.setState({ showOnProjection: false })
    renderBridge()

    expect(mockProject).toHaveBeenCalledWith(
      'timer:tick',
      expect.objectContaining({ mode: 'clock' })
    )
  })
})

describe('TimerProjectionBridge — timer:stopwatch projection', () => {
  it('sends timer:stopwatch when showOnProjection is true', () => {
    useTimerStore.setState({ mode: 'stopwatch' })
    useStopwatchStore.setState({
      status: 'stopped',
      elapsedMs: 0,
      showOnProjection: true
    })
    renderBridge()

    expect(mockProject).toHaveBeenCalledWith(
      'timer:stopwatch',
      expect.objectContaining({
        elapsedMs: 0,
        formattedTime: '00:00',
        status: 'stopped'
      })
    )
  })

  it('sends updated timer:stopwatch when stopwatch state changes', async () => {
    useTimerStore.setState({ mode: 'stopwatch' })
    useStopwatchStore.setState({
      status: 'stopped',
      elapsedMs: 0,
      showOnProjection: true
    })
    renderBridge()
    mockProject.mockClear()

    await act(async () => {
      useStopwatchStore.setState({
        status: 'running',
        elapsedMs: 1500
      })
    })

    expect(mockProject).toHaveBeenCalledWith(
      'timer:stopwatch',
      expect.objectContaining({
        elapsedMs: 1500,
        formattedTime: '00:01',
        status: 'running'
      })
    )
  })

  it('does not send timer:stopwatch when showOnProjection is false', () => {
    useTimerStore.setState({ mode: 'stopwatch' })
    useStopwatchStore.setState({
      status: 'stopped',
      elapsedMs: 0,
      showOnProjection: false
    })
    renderBridge()

    const stopwatchCalls = mockProject.mock.calls.filter(
      (c: unknown[]) => c[0] === 'timer:stopwatch'
    )
    expect(stopwatchCalls).toHaveLength(0)
  })

  it('does not send timer:stopwatch when not in stopwatch mode', () => {
    useTimerStore.setState({ mode: 'timer' })
    renderBridge()

    const stopwatchCalls = mockProject.mock.calls.filter(
      (c: unknown[]) => c[0] === 'timer:stopwatch'
    )
    expect(stopwatchCalls).toHaveLength(0)
  })
})

describe('TimerProjectionBridge — settings:timezone sync', () => {
  it('sends settings:timezone when projection is open', () => {
    mockIsProjectionOpen = true
    renderBridge()
    expect(mockSend).toHaveBeenCalledWith('settings:timezone', { timezone: 'Asia/Taipei' })
  })

  it('does not send settings:timezone when projection is closed', () => {
    mockIsProjectionOpen = false
    renderBridge()
    expect(mockSend).not.toHaveBeenCalledWith('settings:timezone', expect.anything())
  })

  it('sends updated timezone when settings change while projection is open', async () => {
    mockIsProjectionOpen = true
    renderBridge()
    mockSend.mockClear()

    await act(async () => {
      useSettingsStore.setState({ timezone: 'America/New_York' })
    })

    expect(mockSend).toHaveBeenCalledWith('settings:timezone', { timezone: 'America/New_York' })
  })
})

describe('TimerProjectionBridge — settings:timer-ring-color sync', () => {
  it('sends settings:timer-ring-color when projection is open', () => {
    mockIsProjectionOpen = true
    renderBridge()
    expect(mockSend).toHaveBeenCalledWith('settings:timer-ring-color', { color: '#3b82f6' })
  })

  it('does not send settings:timer-ring-color when projection is closed', () => {
    mockIsProjectionOpen = false
    renderBridge()
    expect(mockSend).not.toHaveBeenCalledWith('settings:timer-ring-color', expect.anything())
  })

  it('sends updated timer ring color when settings change while projection is open', async () => {
    mockIsProjectionOpen = true
    renderBridge()
    mockSend.mockClear()

    await act(async () => {
      useSettingsStore.setState({ timerRingColor: '#ef4444', timerRingColorEnabled: true })
    })

    expect(mockSend).toHaveBeenCalledWith('settings:timer-ring-color', { color: '#ef4444' })
  })
})
