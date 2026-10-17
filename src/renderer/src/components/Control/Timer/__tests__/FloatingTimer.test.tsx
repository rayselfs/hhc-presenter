import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useLocation, useNavigate } from 'react-router-dom'
import FloatingTimer from '../FloatingTimer'
import { useTimerStore } from '@renderer/stores/timer'
import { DEFAULT_STATE, DEFAULT_SETTINGS } from '@renderer/stores/timer'

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useLocation: vi.fn(),
    useNavigate: vi.fn()
  }
})

const mockNavigate = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  useTimerStore.setState({
    ...DEFAULT_SETTINGS,
    ...DEFAULT_STATE
  })
  vi.mocked(useNavigate).mockReturnValue(mockNavigate)
})

describe('FloatingTimer', () => {
  it('renders when status is running and route is not /', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/bible' } as ReturnType<typeof useLocation>)
    useTimerStore.setState({ status: 'running', progress: 0.75, remainingSeconds: 90 })

    render(<FloatingTimer />)

    expect(screen.getByRole('button', { name: /timer/i })).toBeInTheDocument()
    const svg = screen.getByRole('button', { name: /timer/i }).querySelector('svg')
    expect(svg).toBeInTheDocument()
    expect(screen.getByText('01:30')).toBeInTheDocument()
  })

  it('returns null when route is /timer (timer page) even when running', () => {
    vi.mocked(useLocation).mockReturnValue({
      pathname: '/timer'
    } as ReturnType<typeof useLocation>)
    useTimerStore.setState({ status: 'running', progress: 0.75, remainingSeconds: 90 })

    const { container } = render(<FloatingTimer />)

    expect(container.firstChild).toBeNull()
  })

  it('returns null when status is stopped regardless of route', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/bible' } as ReturnType<typeof useLocation>)
    useTimerStore.setState({ status: 'stopped', progress: 1, remainingSeconds: 300 })

    const { container } = render(<FloatingTimer />)

    expect(container.firstChild).toBeNull()
  })

  it('returns null when status is paused', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/bible' } as ReturnType<typeof useLocation>)
    useTimerStore.setState({ status: 'paused', progress: 0.5, remainingSeconds: 150 })

    const { container } = render(<FloatingTimer />)

    expect(container.firstChild).toBeNull()
  })

  it('navigates to /timer when clicked', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/bible' } as ReturnType<typeof useLocation>)
    useTimerStore.setState({ status: 'running', progress: 0.75, remainingSeconds: 90 })

    render(<FloatingTimer />)
    fireEvent.click(screen.getByRole('button', { name: /timer/i }))

    expect(mockNavigate).toHaveBeenCalledWith('/timer')
  })

  it('formats remaining seconds as MM:SS', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/bible' } as ReturnType<typeof useLocation>)
    useTimerStore.setState({ status: 'running', progress: 0.5, remainingSeconds: 125 })

    render(<FloatingTimer />)

    expect(screen.getByText('02:05')).toBeInTheDocument()
  })

  it('shows 00:00 when remainingSeconds is 0', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/bible' } as ReturnType<typeof useLocation>)
    useTimerStore.setState({ status: 'running', progress: 0, remainingSeconds: 0 })

    render(<FloatingTimer />)

    expect(screen.getByText('00:00')).toBeInTheDocument()
  })
})
