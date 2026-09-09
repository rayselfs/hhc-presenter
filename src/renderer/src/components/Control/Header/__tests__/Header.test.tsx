import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import '@renderer/i18n'
import i18n from '@renderer/i18n'
import { useTimerStore } from '@renderer/stores/timer'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import { useBibleProjectionStore } from '@renderer/stores/bible-projection'
import type { FileItemRecord } from '@shared/types/folder'
import type { ContentMessageTuple } from '@renderer/contexts/ProjectionContext'
import { ConfirmDialogProvider } from '@renderer/contexts/ConfirmDialogContext'
import { ShortcutScopeProvider } from '@renderer/contexts/ShortcutScopeContext'
import type { useProjection as useProjectionHook } from '@renderer/contexts/ProjectionContext'
import ConfirmDialog from '../../../Common/ConfirmDialog'
import Header from '../Header'

vi.mock('@renderer/contexts/ProjectionContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/contexts/ProjectionContext')>()
  return {
    ...actual,
    useProjection: vi.fn()
  }
})

type MockProjectionContext = ReturnType<typeof useProjectionHook>

function makeFile(id: string, overrides: Partial<FileItemRecord> = {}): FileItemRecord {
  return {
    id,
    name: `${id}.png`,
    mimeType: 'image/png',
    type: 'file',
    sortIndex: 0,
    parentId: 'file-root',
    size: 1,
    url: `blob:${id}`,
    createdAt: Date.now(),
    expiresAt: null,
    ...overrides
  }
}

async function mockProjectionContext(
  overrides: Record<string, unknown> = {}
): Promise<MockProjectionContext> {
  const { useProjection } = await import('@renderer/contexts/ProjectionContext')
  const context = { ...baseProjectionContext(), ...overrides } as MockProjectionContext
  vi.mocked(useProjection).mockReturnValue(context)
  return context
}

function baseProjectionContext(): MockProjectionContext {
  return {
    isProjectionOpen: false,
    projectionReadyCount: 0,
    activeOwner: 'timer' as const,
    recovery: { status: 'closed', generation: 0, failure: null },
    vlcFailure: null,
    sessionSummary: {
      owner: null,
      status: 'closed',
      label: null,
      isBlackout: false,
      failure: null
    },
    claimProjection: vi.fn<MockProjectionContext['claimProjection']>(),
    ensureProjectionOpen: vi.fn<MockProjectionContext['ensureProjectionOpen']>(() =>
      Promise.resolve({ ok: true, generation: 1 })
    ),
    startProjection: vi.fn<MockProjectionContext['startProjection']>(() =>
      Promise.resolve({ ok: true, generation: 1 })
    ),
    stopProjection: vi.fn<MockProjectionContext['stopProjection']>(() => Promise.resolve()),
    retryProjection: vi.fn<MockProjectionContext['retryProjection']>(() =>
      Promise.resolve({ ok: true, generation: 1 })
    ),
    closeProjection: vi.fn<MockProjectionContext['closeProjection']>(() => Promise.resolve()),
    blackoutProjection: vi.fn<MockProjectionContext['blackoutProjection']>(() => Promise.resolve()),
    getProjectionSnapshot: vi.fn<MockProjectionContext['getProjectionSnapshot']>(() => null),
    project: vi.fn<MockProjectionContext['project']>(() => Promise.resolve()),
    send: vi.fn<MockProjectionContext['send']>(),
    on: vi.fn(() => vi.fn()) as MockProjectionContext['on']
  }
}

function renderWithRouter(initialEntries: string[] = ['/']): ReturnType<typeof render> {
  const element = (
    <ShortcutScopeProvider>
      <ConfirmDialogProvider>
        <Header />
        <ConfirmDialog />
      </ConfirmDialogProvider>
    </ShortcutScopeProvider>
  )
  const router = createMemoryRouter(
    [
      { path: '/', element },
      { path: '/timer', element },
      { path: '/bible', element },
      { path: '/files', element },
      { path: '/cloud-files', element },
      { path: '/media', element: <div data-testid="media-workspace" /> }
    ],
    { initialEntries }
  )
  return render(<RouterProvider router={router} />)
}

describe('Header', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useFileExplorerStore.setState({
      currentFolderId: 'file-root',
      _itemsArray: []
    })
    useBibleProjectionStore.getState().clearLastPayloads()
  })

  it('renders a header element', async () => {
    await i18n.changeLanguage('en')
    await mockProjectionContext()
    renderWithRouter(['/'])
    expect(document.querySelector('header')).toBeInTheDocument()
  })

  it('labels the cloud root breadcrumb as Home', async () => {
    await i18n.changeLanguage('en')
    await mockProjectionContext()
    useFileExplorerStore.setState({
      currentFolderId: 'personal-root',
      folders: {
        'personal-root': {
          id: 'personal-root',
          personalOwnerId: 'alice',
          name: 'Cloud documents',
          parentId: 'file-root',
          sortIndex: 0,
          createdAt: 1,
          expiresAt: null
        }
      }
    })

    renderWithRouter(['/cloud-files'])

    expect(screen.getByRole('navigation', { name: 'Folder path' })).toHaveTextContent('Home')
    expect(screen.getByRole('navigation', { name: 'Folder path' })).not.toHaveTextContent(
      'Cloud documents'
    )
  })

  it('starts timer projection from the timer route', async () => {
    await i18n.changeLanguage('en')
    const startProjection = vi.fn(() => Promise.resolve())
    await mockProjectionContext({ isProjectionOpen: false, startProjection })
    renderWithRouter(['/timer'])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Start projection' }))
    expect(startProjection).toHaveBeenCalledWith(
      'timer',
      expect.arrayContaining([['timer:tick', expect.objectContaining({ mode: 'timer' })]])
    )
  })

  it('starts timer projection from the timer route with F5', async () => {
    await i18n.changeLanguage('en')
    const startProjection = vi.fn(() => Promise.resolve())
    await mockProjectionContext({ isProjectionOpen: false, startProjection })
    renderWithRouter(['/timer'])

    fireEvent.keyDown(document, { code: 'F5', key: 'F5' })

    await waitFor(() =>
      expect(startProjection).toHaveBeenCalledWith(
        'timer',
        expect.arrayContaining([['timer:tick', expect.objectContaining({ mode: 'timer' })]])
      )
    )
  })

  it('disables bible projection start until a bible payload exists', async () => {
    await i18n.changeLanguage('en')
    await mockProjectionContext({ isProjectionOpen: false })
    renderWithRouter(['/bible'])
    expect(screen.getByRole('button', { name: 'Start projection' })).toBeDisabled()
  })

  it('does not start bible projection with F5 until a bible payload exists', async () => {
    await i18n.changeLanguage('en')
    const startProjection = vi.fn(() => Promise.resolve())
    await mockProjectionContext({ isProjectionOpen: false, startProjection })
    renderWithRouter(['/bible'])

    fireEvent.keyDown(document, { code: 'F5', key: 'F5' })

    expect(startProjection).not.toHaveBeenCalled()
  })

  it('replays the last bible projection payload from the bible route', async () => {
    await i18n.changeLanguage('en')
    const startProjection = vi.fn(() => Promise.resolve())
    const payloads: ContentMessageTuple[] = [
      ['bible:settings', { fontSize: 90 }],
      [
        'bible:chapter',
        {
          bookNumber: 43,
          chapter: 3,
          chapterVerses: [{ number: 16, text: 'For God so loved the world' }],
          currentVerse: 16
        }
      ]
    ]
    useBibleProjectionStore.getState().setLastPayloads(payloads)
    await mockProjectionContext({ isProjectionOpen: false, startProjection })

    renderWithRouter(['/bible'])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Start projection' }))

    expect(startProjection).toHaveBeenCalledWith('bible', payloads)
  })

  it('replays the last bible projection payload from the bible route with F5', async () => {
    await i18n.changeLanguage('en')
    const startProjection = vi.fn(() => Promise.resolve())
    const payloads: ContentMessageTuple[] = [
      ['bible:settings', { fontSize: 90 }],
      [
        'bible:chapter',
        {
          bookNumber: 43,
          chapter: 3,
          chapterVerses: [{ number: 16, text: 'For God so loved the world' }],
          currentVerse: 16
        }
      ]
    ]
    useBibleProjectionStore.getState().setLastPayloads(payloads)
    await mockProjectionContext({ isProjectionOpen: false, startProjection })
    renderWithRouter(['/bible'])

    fireEvent.keyDown(document, { code: 'F5', key: 'F5' })

    await waitFor(() => expect(startProjection).toHaveBeenCalledWith('bible', payloads))
  })

  it('disables files projection start when the current folder has no presentable item', async () => {
    await i18n.changeLanguage('en')
    await mockProjectionContext({ isProjectionOpen: false })
    renderWithRouter(['/files'])
    expect(screen.getByRole('button', { name: 'Start projection' })).toBeDisabled()
  })

  it('does not start files projection with F5 when the current folder has no presentable item', async () => {
    await i18n.changeLanguage('en')
    await mockProjectionContext({ isProjectionOpen: false })
    const startPresentationWithReadiness = vi.fn(() =>
      Promise.resolve({ summary: { ready: 1, unsupported: 0, failed: 0 } })
    )
    useMediaProjectionStore.setState({
      startPresentationWithReadiness
    } as never)
    renderWithRouter(['/files'])

    fireEvent.keyDown(document, { code: 'F5', key: 'F5' })

    expect(startPresentationWithReadiness).not.toHaveBeenCalled()
  })

  it('starts presentation from the current files folder', async () => {
    await i18n.changeLanguage('en')
    await mockProjectionContext({ isProjectionOpen: false })
    const startPresentationWithReadiness = vi.fn(() =>
      Promise.resolve({ summary: { ready: 1, unsupported: 0, failed: 0 } })
    )
    useFileExplorerStore.setState({
      currentFolderId: 'file-root',
      _itemsArray: [makeFile('image-1')]
    })
    useMediaProjectionStore.setState({
      startPresentationWithReadiness
    } as never)

    renderWithRouter(['/files'])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Start projection' }))

    expect(startPresentationWithReadiness).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'image-1' })],
      0
    )
    expect(await screen.findByTestId('media-workspace')).toBeInTheDocument()
  })

  it('starts the current files folder without PPTX entries', async () => {
    await i18n.changeLanguage('en')
    await mockProjectionContext({ isProjectionOpen: false })
    const startPresentationWithReadiness = vi.fn(() =>
      Promise.resolve({ summary: { ready: 1, unsupported: 0, failed: 0 } })
    )
    const image = makeFile('image-1')
    const deck = makeFile('deck-1', {
      name: 'Deck.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    })
    useFileExplorerStore.setState({
      currentFolderId: 'file-root',
      _itemsArray: [image, deck]
    })
    useMediaProjectionStore.setState({ startPresentationWithReadiness } as never)

    renderWithRouter(['/files'])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Start projection' }))

    expect(startPresentationWithReadiness).toHaveBeenCalledWith([image], 0)
  })

  it('disables files projection when the current folder contains only PPTX files', async () => {
    await i18n.changeLanguage('en')
    await mockProjectionContext({ isProjectionOpen: false })
    useFileExplorerStore.setState({
      currentFolderId: 'file-root',
      _itemsArray: [
        makeFile('deck-1', {
          name: 'Deck.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        })
      ]
    })

    renderWithRouter(['/files'])

    expect(screen.getByRole('button', { name: 'Start projection' })).toBeDisabled()
  })

  it('starts current folder presentation with F5 from the files route', async () => {
    await i18n.changeLanguage('en')
    await mockProjectionContext({ isProjectionOpen: false })
    const startPresentationWithReadiness = vi.fn(() =>
      Promise.resolve({ summary: { ready: 1, unsupported: 0, failed: 0 } })
    )
    useFileExplorerStore.setState({
      currentFolderId: 'file-root',
      _itemsArray: [makeFile('image-1')]
    })
    useMediaProjectionStore.setState({
      startPresentationWithReadiness
    } as never)
    renderWithRouter(['/files'])

    fireEvent.keyDown(document, { code: 'F5', key: 'F5' })

    await waitFor(() =>
      expect(startPresentationWithReadiness).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'image-1' })],
        0
      )
    )
    expect(await screen.findByTestId('media-workspace')).toBeInTheDocument()
  })

  it('renders stop projection button with correct aria-label in English when open', async () => {
    await i18n.changeLanguage('en')
    await mockProjectionContext({ isProjectionOpen: true })
    renderWithRouter(['/'])
    expect(screen.getByRole('button', { name: 'Stop projection' })).toBeInTheDocument()
  })

  it('renders the projection action as an ungrouped round header button', async () => {
    await i18n.changeLanguage('en')
    await mockProjectionContext()
    renderWithRouter(['/timer'])

    const button = screen.getByRole('button', { name: 'Start projection' })
    expect(button).toHaveClass('size-10', 'min-w-10', 'rounded-full', 'p-0')
    expect(button.closest('[role="group"]')).toBeNull()
  })

  it('calls stopProjection without confirmation when projection is open', async () => {
    await i18n.changeLanguage('en')
    const stopProjection = vi.fn(() => Promise.resolve())
    await mockProjectionContext({ isProjectionOpen: true, stopProjection })

    renderWithRouter(['/'])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Stop projection' }))

    expect(stopProjection).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
  })

  it('does not stop or switch projection with F5 when projection is already open', async () => {
    await i18n.changeLanguage('en')
    const stopProjection = vi.fn(() => Promise.resolve())
    const startProjection = vi.fn(() => Promise.resolve())
    await mockProjectionContext({ isProjectionOpen: true, stopProjection, startProjection })
    renderWithRouter(['/timer'])

    fireEvent.keyDown(document, { code: 'F5', key: 'F5' })

    expect(stopProjection).not.toHaveBeenCalled()
    expect(startProjection).not.toHaveBeenCalled()
  })

  it.each(['/timer', '/bible', '/files'])(
    'only stops projection from %s when projection is already open',
    async (route) => {
      await i18n.changeLanguage('en')
      const stopProjection = vi.fn(() => Promise.resolve())
      const startProjection = vi.fn(() => Promise.resolve())
      await mockProjectionContext({ isProjectionOpen: true, stopProjection, startProjection })

      renderWithRouter([route])
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Stop projection' }))

      expect(stopProjection).toHaveBeenCalled()
      expect(startProjection).not.toHaveBeenCalled()
    }
  )

  it('renders stop projection button with correct aria-label in zh-TW', async () => {
    await i18n.changeLanguage('zh-TW')
    await mockProjectionContext({ isProjectionOpen: true })
    renderWithRouter(['/'])
    expect(screen.getByRole('button', { name: '停止投影' })).toBeInTheDocument()
    await act(() => i18n.changeLanguage('en'))
  })

  describe('route-aware ModeSelector', () => {
    it('shows ModeSelector tabs on /timer route', async () => {
      await i18n.changeLanguage('en')
      useTimerStore.setState({ mode: 'timer' })
      await mockProjectionContext()
      renderWithRouter(['/timer'])
      expect(screen.getByTestId('mode-timer')).toBeInTheDocument()
      expect(screen.getByTestId('mode-clock')).toBeInTheDocument()
      expect(screen.getByTestId('mode-both')).toBeInTheDocument()
      expect(screen.getByTestId('mode-stopwatch')).toBeInTheDocument()
    })

    it('hides ModeSelector on non-timer routes via opacity', async () => {
      await i18n.changeLanguage('en')
      await mockProjectionContext()
      renderWithRouter(['/'])
      const wrapper = screen.getByTestId('mode-timer')?.closest('.absolute')
      expect(wrapper?.className).toContain('opacity-0')
    })
  })
})
