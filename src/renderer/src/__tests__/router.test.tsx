import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom'
import routes from '../router'
import { ThemeProvider } from '@renderer/contexts/ThemeContext'
import { ONBOARDED_KEY } from '@renderer/lib/onboarding'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { useBibleFolderStore } from '@renderer/stores/folder'

vi.mock('@renderer/lib/app-init', () => ({
  initializeApp: vi.fn(() => vi.fn()),
  prefetchRouteChunks: vi.fn(() => Promise.resolve())
}))

vi.mock('@renderer/contexts/HhcAuthContext', () => ({
  useHhcAuth: () => ({
    status: 'anonymous',
    session: null,
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    getAccessToken: vi.fn(async () => null)
  })
}))

vi.mock('@renderer/pages/BiblePage', () => ({
  default: () => <div data-testid="bible-page" />
}))

vi.mock('@renderer/pages/FilesPage', () => ({
  default: () => (
    <div data-testid="files-page">
      <Outlet />
    </div>
  )
}))

vi.mock('@renderer/pages/MediaWorkspacePage', () => ({
  default: () => <div data-testid="media-presenter" />
}))

vi.mock('@renderer/lib/timer-adapter', () => ({
  createTimerAdapter: vi.fn(() => ({
    onTick: vi.fn(),
    onFinished: vi.fn(),
    onStopwatchTick: vi.fn(),
    sendCommand: vi.fn(),
    syncMode: vi.fn(),
    dispose: vi.fn()
  }))
}))

vi.mock('@renderer/contexts/ProjectionContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/contexts/ProjectionContext')>()
  return {
    ...actual,
    useProjection: vi.fn().mockReturnValue({
      isProjectionOpen: false,
      projectionReadyCount: 0,
      activeOwner: 'timer',
      recovery: { status: 'closed', generation: 0, failure: null },
      sessionSummary: {
        owner: null,
        status: 'closed',
        label: null,
        isBlackout: false,
        failure: null
      },
      claimProjection: vi.fn(),
      startProjection: vi.fn(() => Promise.resolve({ ok: true, generation: 1 })),
      stopProjection: vi.fn(() => Promise.resolve()),
      retryProjection: vi.fn(),
      closeProjection: vi.fn(),
      blackoutProjection: vi.fn(),
      getProjectionIntentRevision: vi.fn(() => 0),
      getProjectionSnapshot: vi.fn(() => null),
      project: vi.fn(),
      send: vi.fn(),
      on: vi.fn()
    })
  }
})

function renderWithRouter(initialEntries: string[] = ['/']): ReturnType<typeof render> {
  const router = createMemoryRouter(routes, { initialEntries })
  return render(
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  )
}

describe('Router', () => {
  beforeEach(() => {
    localStorage.setItem(ONBOARDED_KEY, 'true')
    useFileExplorerStore.setState({ isInitialized: true, isLoading: false })
    useBibleFolderStore.setState({ isInitialized: true, isLoading: false })
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('renders timer page at default route /', async () => {
    renderWithRouter(['/'])
    expect(await screen.findByTestId('timer-page')).toBeInTheDocument()
  })

  it('renders timer page at /timer route', async () => {
    renderWithRouter(['/timer'])
    expect(await screen.findByTestId('timer-page')).toBeInTheDocument()
  })

  it('renders bible page at /bible route', async () => {
    renderWithRouter(['/bible'])
    expect(await screen.findByTestId('bible-page')).toBeInTheDocument()
  })

  it.each(['/service', '/soundboard'])('redirects deferred route %s to timer', async (path) => {
    renderWithRouter([path])
    expect(await screen.findByTestId('timer-page')).toBeInTheDocument()
  })

  it('renders the routed Media workspace at /media', async () => {
    renderWithRouter(['/media'])

    expect(await screen.findByTestId('media-presenter')).toBeInTheDocument()
  })

  it('navigates from timer to bible via sidebar link', async () => {
    const user = userEvent.setup()
    const router = createMemoryRouter(routes, { initialEntries: ['/'] })
    render(
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    )

    expect(await screen.findByTestId('timer-page')).toBeInTheDocument()

    const bibleLink = screen.getByRole('link', { name: /bible/i })
    await user.click(bibleLink)

    expect(await screen.findByTestId('bible-page')).toBeInTheDocument()
    expect(screen.queryByTestId('timer-page')).not.toBeInTheDocument()
  })

  it('redirects to /welcome when not onboarded', async () => {
    localStorage.removeItem(ONBOARDED_KEY)
    renderWithRouter(['/'])
    expect(await screen.findByTestId('welcome-page')).toBeInTheDocument()
  })

  it('renders timer page when already onboarded', async () => {
    localStorage.setItem(ONBOARDED_KEY, 'true')
    renderWithRouter(['/'])
    expect(await screen.findByTestId('timer-page')).toBeInTheDocument()
  })
})
