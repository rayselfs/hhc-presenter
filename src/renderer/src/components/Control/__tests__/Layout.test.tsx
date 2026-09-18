import { act, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import '@renderer/i18n'
import i18n from '@renderer/i18n'
import routes from '@renderer/router'
import { ThemeProvider } from '@renderer/contexts/ThemeContext'
import { ONBOARDED_KEY } from '@renderer/lib/onboarding'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { useBibleFolderStore } from '@renderer/stores/folder'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import { useTimerStore } from '@renderer/stores/timer'
import type { ProjectionPayload } from '@shared/projection-messages'
import type { HhcSession } from '@shared/hhc-auth'
import type { SyncRuntimeOptions } from '@renderer/lib/sync-runtime'

const projectionEvents = vi.hoisted(() => ({
  playback: null as ((data: ProjectionPayload<'file:playback-state'>) => void) | null
}))
const projectionRuntime = vi.hoisted(() => ({
  isProjectionOpen: false,
  recovery: {
    status: 'closed' as 'closed' | 'ready',
    generation: 0,
    failure: null
  }
}))
const authRuntime = vi.hoisted(() => ({
  session: null as HhcSession | null,
  generation: 0,
  getAuthGeneration: vi.fn(() => authRuntime.generation),
  getAccessToken: vi.fn(async () => null as string | null),
  refreshAfterUnauthorized: vi.fn(async () => null as string | null),
  endSession: vi.fn(async () => undefined)
}))
const accessRuntime = vi.hoisted(() => ({
  revokeRoot: vi.fn(async () => undefined)
}))
const initializeAppMock = vi.hoisted(() =>
  vi.fn<(options?: SyncRuntimeOptions) => () => void>(() => vi.fn())
)

vi.mock('@renderer/lib/app-init', () => ({
  initializeApp: initializeAppMock,
  prefetchRouteChunks: vi.fn(() => Promise.resolve())
}))

vi.mock('@renderer/lib/hhc-line-access', () => ({
  revokeHhcLineRootAccess: accessRuntime.revokeRoot
}))

vi.mock('@renderer/contexts/HhcAuthContext', () => ({
  useHhcAuth: () => ({
    status: authRuntime.session ? 'authenticated' : 'anonymous',
    session: authRuntime.session,
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    endSession: authRuntime.endSession,
    getAuthGeneration: authRuntime.getAuthGeneration,
    getAccessToken: authRuntime.getAccessToken,
    refreshAfterUnauthorized: authRuntime.refreshAfterUnauthorized
  })
}))

vi.mock('@renderer/pages/BiblePage', () => ({
  default: () => <div data-testid="bible-page" />
}))

vi.mock('@renderer/pages/TimerPage', () => ({
  default: () => <div data-testid="timer-page" />
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
    useProjection: vi.fn().mockImplementation(() => ({
      isProjectionOpen: projectionRuntime.isProjectionOpen,
      projectionReadyCount: 0,
      activeOwner: 'timer',
      recovery: projectionRuntime.recovery,
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
      getProjectionSnapshot: vi.fn(() => null),
      project: vi.fn(),
      send: vi.fn(),
      on: vi.fn(
        (channel: string, handler: (data: ProjectionPayload<'file:playback-state'>) => void) => {
          if (channel === 'file:playback-state') projectionEvents.playback = handler
          return vi.fn()
        }
      )
    }))
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

describe('Layout', () => {
  beforeEach(() => {
    localStorage.setItem(ONBOARDED_KEY, 'true')
    useFileExplorerStore.setState({ isInitialized: true, isLoading: false })
    useBibleFolderStore.setState({ isInitialized: true, isLoading: false })
    projectionEvents.playback = null
    projectionRuntime.isProjectionOpen = false
    projectionRuntime.recovery = { status: 'closed', generation: 0, failure: null }
    authRuntime.session = null
    authRuntime.generation = 0
    initializeAppMock.mockClear()
    useMediaProjectionStore.getState().endLiveSession()
    useTimerStore.setState({ status: 'stopped' })
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('renders a header element', async () => {
    await i18n.changeLanguage('en')
    renderWithRouter(['/'])
    await screen.findByTestId('timer-page')
    expect(document.querySelector('header')).toBeInTheDocument()
  })

  it('renders a main element', async () => {
    await i18n.changeLanguage('en')
    renderWithRouter(['/'])
    await screen.findByTestId('timer-page')
    expect(document.querySelector('main')).toBeInTheDocument()
  })

  it('renders timer-page content at route /', async () => {
    await i18n.changeLanguage('en')
    renderWithRouter(['/'])
    expect(await screen.findByTestId('timer-page')).toBeInTheDocument()
  })

  it('renders bible-page content at route /bible', async () => {
    await i18n.changeLanguage('en')
    renderWithRouter(['/bible'])
    expect(await screen.findByTestId('bible-page')).toBeInTheDocument()
  })

  it('renders sidebar timer and bible labels', async () => {
    await i18n.changeLanguage('en')
    renderWithRouter(['/'])
    await screen.findByTestId('timer-page')
    expect(screen.getByRole('link', { name: /timer/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /bible/i })).toBeInTheDocument()
  })

  it('gives the Media workspace the full control window without global navigation', async () => {
    await i18n.changeLanguage('en')
    useMediaProjectionStore.getState().startPresentation(
      [
        {
          id: 'image-1',
          parentId: 'root',
          type: 'file',
          sortIndex: 0,
          createdAt: 1,
          expiresAt: null,
          name: 'image.png',
          url: 'blob:image-1',
          size: 10,
          mimeType: 'image/png'
        }
      ],
      0
    )
    useTimerStore.setState({ status: 'running', progress: 0.5, remainingSeconds: 30 })

    renderWithRouter(['/media'])

    await waitFor(() => expect(document.querySelector('main')).toHaveClass('overflow-hidden'))
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Timer' })).not.toBeInTheDocument()
  })

  it('does not have a divider between header and main (no border-b on header)', async () => {
    await i18n.changeLanguage('en')
    renderWithRouter(['/'])
    const header = await screen.findByRole('banner')
    expect(header.classList.contains('border-b')).toBe(false)
  })

  it('does not render an hr element between header and main', async () => {
    await i18n.changeLanguage('en')
    renderWithRouter(['/'])
    await screen.findByTestId('timer-page', {}, { timeout: 5_000 })
    expect(document.querySelector('hr')).not.toBeInTheDocument()
  })

  it('keeps the global Media bridge subscribed outside the Media workspace', async () => {
    projectionRuntime.isProjectionOpen = true
    projectionRuntime.recovery = { status: 'ready', generation: 1, failure: null }
    useMediaProjectionStore.setState({
      playlist: [
        {
          id: 'video-1',
          parentId: 'root',
          type: 'file',
          sortIndex: 0,
          createdAt: 1,
          expiresAt: null,
          name: 'clip.mp4',
          url: 'blob:video-1',
          size: 10,
          mimeType: 'video/mp4'
        }
      ],
      currentIndex: 0,
      isPresenting: false,
      typeStates: { pdf: { viewMode: 'slide' } }
    })

    renderWithRouter(['/timer'])
    await waitFor(() => expect(projectionEvents.playback).not.toBeNull(), { timeout: 5_000 })
    projectionEvents.playback?.({
      itemId: 'video-1',
      phase: 'playing',
      currentTime: 12,
      duration: 60,
      isPlaying: true,
      isEnded: false
    })

    expect(useMediaProjectionStore.getState().typeStates.video).toMatchObject({
      currentTime: 12,
      duration: 60,
      isPlaying: true,
      isEnded: false
    })
  })

  it('keeps one live sync auth facade across StrictMode auth changes', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/'] })
    const tree = (): React.JSX.Element => (
      <StrictMode>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </StrictMode>
    )
    render(tree())
    await waitFor(() => expect(initializeAppMock).toHaveBeenCalled())
    const initialCalls = initializeAppMock.mock.calls.length
    const options = initializeAppMock.mock.calls.at(-1)?.[0]
    const hhcAuth = options?.hhcAuth
    expect(hhcAuth?.getSession()).toBeNull()
    expect(hhcAuth?.endSession).toBe(authRuntime.endSession)
    expect(options?.getHhcAuthGeneration?.()).toBe(0)

    authRuntime.session = {
      userId: 'user-1',
      displayName: 'Ada',
      roles: ['media_sync_user']
    }
    await act(() => router.navigate('/bible'))

    expect(initializeAppMock).toHaveBeenCalledTimes(initialCalls)
    expect(hhcAuth?.getSession()).toMatchObject({ userId: 'user-1' })
    expect(options?.getHhcAuthGeneration?.()).toBe(0)

    authRuntime.generation = 1
    expect(options?.getHhcAuthGeneration?.()).toBe(1)

    await options?.onHhcAccessRevoked?.({
      connectionId: 'hhc-line:user-1',
      rootFolderId: 'root-1'
    })
    expect(accessRuntime.revokeRoot).toHaveBeenCalledWith({
      kind: 'root',
      providerConnectionId: 'hhc-line:user-1',
      rootFolderId: 'root-1'
    })
  })
})
