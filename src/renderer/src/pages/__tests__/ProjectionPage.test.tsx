import { render, screen, act, waitFor } from '@testing-library/react'
import type { TimerTickPayload, StopwatchTickPayload } from '@shared/types/timer'
import { useSettingsStore } from '@renderer/stores/settings'

vi.mock('@renderer/lib/env', () => ({
  isElectron: vi.fn(() => false),
  isWeb: vi.fn(() => true)
}))

vi.mock('@renderer/components/Projection/DefaultProjection', () => ({
  default: () => <div data-testid="default-projection">Default</div>
}))

vi.mock('@renderer/components/Projection/FileProjection', () => ({
  default: ({
    controlEvent,
    projectionSessionId
  }: {
    controlEvent?: { data: { action: string } } | null
    projectionSessionId?: string
  }) => (
    <div
      data-testid="file-projection"
      data-control-action={controlEvent?.data.action ?? ''}
      data-projection-session={projectionSessionId}
    />
  )
}))

const mockAdapter = (() => {
  const handlers = new Map<string, (data: unknown) => void>()
  return {
    setGeneration: vi.fn(),
    getGeneration: vi.fn(() => 4),
    send: vi.fn(),
    on: vi.fn((channel: string, handler: (data: unknown) => void) => {
      handlers.set(channel, handler)
      return () => {
        handlers.delete(channel)
      }
    }),
    dispose: vi.fn(),
    _trigger(channel: string, data: unknown) {
      handlers.get(channel)?.(data)
    }
  }
})()

vi.mock('@renderer/lib/projection-adapter', () => ({
  createProjectionAdapter: vi.fn(() => mockAdapter)
}))

import ProjectionPage from '../ProjectionPage'
import { createProjectionAdapter } from '@renderer/lib/projection-adapter'
import { isElectron, isWeb } from '@renderer/lib/env'

const mockProjectionVlcStop = vi.fn()

const baseTimerTick: TimerTickPayload = {
  mode: 'timer',
  remainingSeconds: 120,
  phase: 'main',
  mainDisplay: '02:00',
  subDisplay: null,
  progress: 0.5,
  overtimeSeconds: 0,
  overtimeMessage: null,
  reminderColor: null
}

const baseStopwatchTick: StopwatchTickPayload = {
  elapsedMs: 5000,
  formattedTime: '00:05.00',
  status: 'running'
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isElectron).mockReturnValue(false)
  vi.mocked(isWeb).mockReturnValue(true)
  window.location.hash = '#/projection?generation=4&session=session-1'
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      projectionVlc: {
        stop: mockProjectionVlcStop
      }
    }
  })
})

describe('ProjectionPage', () => {
  it('renders default content when no timer data received', () => {
    render(<ProjectionPage />)
    expect(screen.getByTestId('default-projection')).toBeInTheDocument()
  })

  it('announces projection route readiness with its generation', async () => {
    render(<ProjectionPage />)

    await waitFor(() => {
      expect(createProjectionAdapter).toHaveBeenCalledWith('projection', 'session-1')
      expect(mockAdapter.setGeneration).toHaveBeenCalledWith(4)
      expect(mockAdapter.send).toHaveBeenCalledWith('__system:ready', { generation: 4 })
    })
  })

  it('renegotiates readiness when a hidden projection surface starts a new session', async () => {
    const lifecycleHandlers: Array<(event: { generation: number; status: string }) => void> = []
    vi.mocked(isElectron).mockReturnValue(true)
    vi.mocked(isWeb).mockReturnValue(false)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        projection: {
          getGeneration: vi.fn(() => Promise.resolve({ generation: 4 })),
          onProjectionLifecycle: vi.fn((handler) => {
            lifecycleHandlers.push(handler)
            return () => undefined
          })
        },
        projectionVlc: { stop: mockProjectionVlcStop }
      }
    })

    render(<ProjectionPage />)
    await waitFor(() =>
      expect(mockAdapter.send).toHaveBeenCalledWith('__system:ready', { generation: 4 })
    )
    expect(
      vi.mocked(window.api.projection.onProjectionLifecycle).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(window.api.projection.getGeneration).mock.invocationCallOrder[0])

    act(() => {
      lifecycleHandlers[0]({ generation: 5, status: 'opening' })
    })

    expect(mockAdapter.setGeneration).toHaveBeenCalledWith(5)
    expect(mockAdapter.send).toHaveBeenCalledWith('__system:ready', { generation: 5 })
  })

  it('shows TimerDisplay when receiving timer:tick with mode=timer', () => {
    const { container } = render(<ProjectionPage />)
    act(() => {
      mockAdapter._trigger('__system:blank', { showDefault: false })
      mockAdapter._trigger('timer:tick', { ...baseTimerTick, mode: 'timer' })
    })
    expect(container.querySelectorAll('circle')).toHaveLength(2)
    expect(screen.getByText('02:00')).toBeInTheDocument()
  })

  it('shows ClockDisplay when receiving timer:tick with mode=clock', () => {
    render(<ProjectionPage />)
    act(() => {
      mockAdapter._trigger('__system:blank', { showDefault: false })
      mockAdapter._trigger('timer:tick', { ...baseTimerTick, mode: 'clock' })
    })
    expect(screen.getByTestId('clock-display')).toBeInTheDocument()
  })

  it('shows StopwatchDisplay when receiving timer:tick with mode=stopwatch', () => {
    render(<ProjectionPage />)
    act(() => {
      mockAdapter._trigger('__system:blank', { showDefault: false })
      mockAdapter._trigger('timer:tick', { ...baseTimerTick, mode: 'stopwatch' })
      mockAdapter._trigger('timer:stopwatch', baseStopwatchTick)
    })
    expect(screen.getByTestId('stopwatch-display')).toBeInTheDocument()
    expect(screen.getByText('00:05.00')).toBeInTheDocument()
  })

  it('shows both TimerDisplay and ClockDisplay in both mode', () => {
    const { container } = render(<ProjectionPage />)
    act(() => {
      mockAdapter._trigger('__system:blank', { showDefault: false })
      mockAdapter._trigger('timer:tick', { ...baseTimerTick, mode: 'both' })
    })
    expect(container.querySelectorAll('circle')).toHaveLength(2)
    expect(screen.getByTestId('clock-display')).toBeInTheDocument()
  })

  it('blank layer hides timer content: __system:blank with showDefault=true shows default', () => {
    render(<ProjectionPage />)
    act(() => {
      mockAdapter._trigger('timer:tick', { ...baseTimerTick, mode: 'timer' })
      mockAdapter._trigger('__system:blank', { showDefault: true })
    })
    expect(screen.getByTestId('default-projection')).toBeInTheDocument()
    expect(screen.queryByText('02:00')).not.toBeInTheDocument()
  })

  it('shows overtime message when phase is overtime', () => {
    render(<ProjectionPage />)
    act(() => {
      mockAdapter._trigger('__system:blank', { showDefault: false })
      mockAdapter._trigger('timer:tick', {
        ...baseTimerTick,
        mode: 'timer',
        phase: 'overtime',
        overtimeMessage: 'Please wrap up!'
      })
    })
    expect(screen.getByText('Please wrap up!')).toBeInTheDocument()
  })

  it('calls adapter.dispose on unmount', () => {
    const { unmount } = render(<ProjectionPage />)
    unmount()
    expect(mockAdapter.dispose).toHaveBeenCalled()
  })

  it('updates settings store timezone on settings:timezone message', () => {
    useSettingsStore.setState({ timezone: 'Asia/Taipei' })
    render(<ProjectionPage />)
    act(() => {
      mockAdapter._trigger('settings:timezone', { timezone: 'America/New_York' })
    })
    expect(useSettingsStore.getState().timezone).toBe('America/New_York')
  })

  it('updates timer ring color on settings:timer-ring-color message', () => {
    const { container } = render(<ProjectionPage />)
    act(() => {
      mockAdapter._trigger('__system:blank', { showDefault: false })
      mockAdapter._trigger('timer:tick', { ...baseTimerTick, mode: 'timer' })
      mockAdapter._trigger('settings:timer-ring-color', { color: '#ef4444' })
    })
    expect(container.querySelectorAll('circle')).toHaveLength(2)
  })

  it('keeps an early file control command until file projection mounts', () => {
    render(<ProjectionPage />)

    act(() => {
      mockAdapter._trigger('__system:blank', { showDefault: false })
      mockAdapter._trigger('file:control', { action: 'play', itemId: 'video-1' })
      mockAdapter._trigger('file:show', {
        itemId: 'video-1',
        blobId: 'blob-1',
        fileName: 'video.mkv',
        mimeType: 'video/mp4',
        playlist: [],
        currentIndex: 0,
        streamUrl: 'hhc-media://native/source-id',
        seekable: false
      })
    })

    expect(screen.getByTestId('file-projection')).toHaveAttribute('data-control-action', 'play')
    expect(screen.getByTestId('file-projection')).toHaveAttribute(
      'data-projection-session',
      'session-1'
    )
  })

  it('stops VLC when blanking file projection back to default', async () => {
    render(<ProjectionPage />)
    mockProjectionVlcStop.mockClear()

    act(() => {
      mockAdapter._trigger('__system:blank', { showDefault: false })
      mockAdapter._trigger('file:show', {
        itemId: 'video-1',
        blobId: 'blob-1',
        fileName: 'video.mkv',
        mimeType: 'video/x-matroska',
        playbackMode: 'vlc-embedded'
      })
    })
    expect(screen.getByTestId('file-projection')).toBeInTheDocument()

    act(() => {
      mockAdapter._trigger('__system:blank', { showDefault: true })
    })

    await waitFor(() => {
      expect(mockProjectionVlcStop).toHaveBeenCalled()
    })
  })

  it('renders intentional blackout instead of the internal default fallback', async () => {
    render(<ProjectionPage />)

    act(() => {
      mockAdapter._trigger('__system:blank', { showDefault: false })
      mockAdapter._trigger('file:show', {
        itemId: 'video-1',
        blobId: 'blob-1',
        fileName: 'video.mkv',
        mimeType: 'video/x-matroska',
        playbackMode: 'vlc-embedded'
      })
      mockAdapter._trigger('__system:blackout', { enabled: true })
    })

    expect(screen.getByTestId('projection-blackout')).toBeInTheDocument()
    expect(screen.queryByTestId('default-projection')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(mockProjectionVlcStop).toHaveBeenCalled()
    })
  })
})
