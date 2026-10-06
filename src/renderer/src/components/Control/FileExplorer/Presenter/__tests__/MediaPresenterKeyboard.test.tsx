import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MediaPresenter from '../MediaPresenter'
import type { ShortcutHandler } from '@renderer/hooks/useKeyboardShortcuts'
import type { FileItemRecord } from '@shared/types/folder'

const {
  mockShortcuts,
  mockNext,
  mockPrev,
  mockExit,
  mockEndSession,
  mockResetZoom,
  mockToggleGrid,
  mockSend,
  mockProject,
  mockOn,
  mockStopProjection,
  mockClaimProjection,
  mockPauseTimer,
  mockToastDanger,
  storeState
} = vi.hoisted(() => {
  const videoItem: FileItemRecord = {
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
  return {
    mockShortcuts: [] as ShortcutHandler[],
    mockNext: vi.fn(),
    mockPrev: vi.fn(),
    mockExit: vi.fn(),
    mockEndSession: vi.fn(),
    mockResetZoom: vi.fn(),
    mockToggleGrid: vi.fn(),
    mockSend: vi.fn(),
    mockProject: vi.fn(),
    mockOn: vi.fn(() => vi.fn()),
    mockStopProjection: vi.fn(),
    mockClaimProjection: vi.fn(),
    mockPauseTimer: vi.fn(),
    mockToastDanger: vi.fn(),
    storeState: {
      playlist: [videoItem],
      showGrid: false,
      zoomLevel: 1,
      isEnded: false,
      currentFile: videoItem,
      typeStates: {
        video: { hasStarted: false, isPlaying: false, isEnded: false },
        pdf: { viewMode: 'slide' as const },
        presentation: undefined as { slideIndex: number; slideCount?: number } | undefined
      },
      currentItem: () => videoItem,
      exit: vi.fn(),
      next: vi.fn(),
      prev: vi.fn(),
      jumpTo: vi.fn(),
      jumpToSlide: vi.fn(),
      toggleGrid: vi.fn(),
      setZoomLevel: vi.fn(),
      resetZoom: vi.fn()
    }
  }
})

vi.mock('@renderer/hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: (shortcuts: ShortcutHandler[]) => {
    mockShortcuts.length = 0
    mockShortcuts.push(...shortcuts)
  }
}))

vi.mock('@renderer/contexts/ProjectionContext', () => ({
  useProjection: () => ({
    claimProjection: mockClaimProjection,
    startProjection: vi.fn(),
    stopProjection: mockStopProjection,
    send: mockSend,
    project: mockProject,
    on: mockOn
  })
}))

vi.mock('@renderer/stores/timer-runtime', () => ({
  useTimerRuntimeStore: {
    getState: () => ({ status: 'idle', pause: mockPauseTimer })
  }
}))

vi.mock('@renderer/stores/media-projection', () => ({
  resolveMediaProjectionAction: async (result: unknown) => {
    const resolved = await result
    return typeof resolved === 'boolean' ? { status: resolved ? 'success' : 'noop' } : resolved
  },
  useMediaProjectionStore: Object.assign(
    vi.fn((selector: (state: typeof storeState) => unknown) => selector(storeState)),
    {
      getState: () => ({
        ...storeState,
        next: mockNext,
        prev: mockPrev,
        exit: mockEndSession,
        resetZoom: mockResetZoom,
        toggleGrid: mockToggleGrid
      })
    }
  )
}))

vi.mock('@heroui/react/toast', () => ({ toast: { danger: mockToastDanger } }))

vi.mock('@renderer/lib/media-projection-sync', () => ({
  useMediaProjectionSync: vi.fn()
}))

vi.mock('@renderer/lib/shortcut-registry', () => ({
  setPresenterActive: vi.fn()
}))

vi.mock('@renderer/hooks/usePreviewCache', () => ({
  usePreviewCache: () => ({ pdfPageThumbs: {} })
}))

vi.mock('@renderer/hooks/useThumbnails', () => ({
  useThumbnails: () => ({})
}))

vi.mock('../PresenterHeader', () => ({
  default: () => <div />
}))
vi.mock('../PresenterNavigation', () => ({
  default: () => <div />
}))
vi.mock('../PresenterSidebar', () => ({
  default: () => <div data-testid="presenter-sidebar" />
}))
vi.mock('../PresenterGrid', () => ({
  default: () => <div />
}))
vi.mock('../Preview/MediaPreview', () => ({
  default: () => <div data-testid="media-preview" />
}))
vi.mock('../MediaToolbar', () => ({
  default: () => <div />
}))
vi.mock('@renderer/components/Common/GlassDivider', () => ({
  default: () => <div />
}))

function findShortcut(code: string): ShortcutHandler {
  const shortcut = mockShortcuts.find((item) => item.config.code === code)
  if (!shortcut) throw new Error(`Missing shortcut ${code}`)
  return shortcut
}

function findShortcutByConfig(config: { code: string; metaOrCtrl?: boolean }): ShortcutHandler {
  const shortcut = mockShortcuts.find(
    (item) =>
      item.config.code === config.code &&
      Boolean(item.config.metaOrCtrl) === Boolean(config.metaOrCtrl)
  )
  if (!shortcut) throw new Error(`Missing shortcut ${config.code}`)
  return shortcut
}

beforeEach(() => {
  vi.clearAllMocks()
  mockShortcuts.length = 0
  storeState.isEnded = false
  storeState.showGrid = false
  storeState.zoomLevel = 1
  storeState.typeStates.presentation = undefined
  storeState.currentItem = () => storeState.currentFile
  storeState.typeStates.video = { hasStarted: false, isPlaying: false, isEnded: false }
  mockNext.mockReturnValue(true)
  mockPrev.mockReturnValue(true)
  storeState.jumpTo.mockReturnValue(true)
  storeState.jumpToSlide.mockReturnValue(true)
})

describe('MediaPresenter video keyboard behavior', () => {
  it('keeps next-item preview and notes to the right of the media controls', () => {
    render(<MediaPresenter onExit={mockExit} />)

    expect(screen.getByTestId('media-preview')).toAppearBefore(
      screen.getByTestId('presenter-sidebar')
    )
  })

  it('does not stop live output when the workspace unmounts', () => {
    const { unmount } = render(<MediaPresenter onExit={mockExit} />)

    unmount()

    expect(mockStopProjection).not.toHaveBeenCalled()
  })

  it('uses item navigation before video playback starts', () => {
    render(<MediaPresenter onExit={mockExit} />)

    findShortcut('ArrowRight').handler(new KeyboardEvent('keydown', { code: 'ArrowRight' }))
    findShortcut('ArrowLeft').handler(new KeyboardEvent('keydown', { code: 'ArrowLeft' }))

    expect(mockNext).toHaveBeenCalledOnce()
    expect(mockPrev).toHaveBeenCalledOnce()
  })

  it('reports blocked shared navigation as a save failure', async () => {
    mockNext.mockResolvedValueOnce({ status: 'blocked' })
    render(<MediaPresenter onExit={mockExit} />)
    findShortcut('ArrowRight').handler(new KeyboardEvent('keydown', { code: 'ArrowRight' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(mockToastDanger).toHaveBeenCalledOnce()
  })

  it('does not show a save failure toast when keyboard navigation is superseded', async () => {
    mockNext.mockResolvedValueOnce({ status: 'superseded' })
    render(<MediaPresenter onExit={mockExit} />)

    findShortcut('ArrowRight').handler(new KeyboardEvent('keydown', { code: 'ArrowRight' }))
    await Promise.resolve()
    await Promise.resolve()

    expect(mockToastDanger).not.toHaveBeenCalled()
  })

  it('uses item navigation for single left and right even while video is playing', () => {
    storeState.typeStates.video = { hasStarted: true, isPlaying: true, isEnded: false }
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    render(<MediaPresenter onExit={mockExit} />)

    findShortcut('ArrowRight').handler(new KeyboardEvent('keydown', { code: 'ArrowRight' }))
    findShortcut('ArrowLeft').handler(new KeyboardEvent('keydown', { code: 'ArrowLeft' }))

    expect(mockNext).toHaveBeenCalledOnce()
    expect(mockPrev).toHaveBeenCalledOnce()
    expect(dispatchSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'media:videoSeekRelative' })
    )
    dispatchSpy.mockRestore()
  })

  it('seeks video with modifier left and right after playback starts', () => {
    storeState.typeStates.video = { hasStarted: true, isPlaying: true, isEnded: false }
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    render(<MediaPresenter onExit={mockExit} />)

    findShortcutByConfig({ code: 'ArrowRight', metaOrCtrl: true }).handler(
      new KeyboardEvent('keydown', { code: 'ArrowRight', metaKey: true })
    )
    findShortcutByConfig({ code: 'ArrowLeft', metaOrCtrl: true }).handler(
      new KeyboardEvent('keydown', { code: 'ArrowLeft', metaKey: true })
    )

    expect(mockNext).not.toHaveBeenCalled()
    expect(mockPrev).not.toHaveBeenCalled()
    expect(dispatchSpy).toHaveBeenCalledTimes(2)
    expect(dispatchSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'media:videoSeekRelative' })
    )
    expect(dispatchSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'media:videoSeekRelative' })
    )
    dispatchSpy.mockRestore()
  })

  it('ignores modifier video seek before playback starts', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    render(<MediaPresenter onExit={mockExit} />)

    findShortcutByConfig({ code: 'ArrowRight', metaOrCtrl: true }).handler(
      new KeyboardEvent('keydown', { code: 'ArrowRight', metaKey: true })
    )

    expect(dispatchSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'media:videoSeekRelative' })
    )
    dispatchSpy.mockRestore()
  })

  it('uses item navigation after video playback has ended', () => {
    storeState.typeStates.video = { hasStarted: true, isPlaying: false, isEnded: true }
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    render(<MediaPresenter onExit={mockExit} />)

    findShortcut('ArrowRight').handler(new KeyboardEvent('keydown', { code: 'ArrowRight' }))
    findShortcut('ArrowLeft').handler(new KeyboardEvent('keydown', { code: 'ArrowLeft' }))

    expect(mockNext).toHaveBeenCalledOnce()
    expect(mockPrev).toHaveBeenCalledOnce()
    expect(dispatchSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'media:videoSeekRelative' })
    )
    dispatchSpy.mockRestore()
  })

  it('pauses the video on Escape only when video is playing', () => {
    storeState.typeStates.video = { hasStarted: true, isPlaying: true, isEnded: false }
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    render(<MediaPresenter onExit={mockExit} />)

    findShortcut('Escape').handler(new KeyboardEvent('keydown', { code: 'Escape' }))

    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'media:pauseVideo' }))
    expect(mockExit).not.toHaveBeenCalled()
    dispatchSpy.mockRestore()
  })

  it('pauses a playing video before opening the grid', () => {
    storeState.typeStates.video = { hasStarted: true, isPlaying: true, isEnded: false }
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    render(<MediaPresenter onExit={mockExit} />)

    findShortcut('KeyG').handler(new KeyboardEvent('keydown', { code: 'KeyG' }))

    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'media:pauseVideo' }))
    expect(mockToggleGrid).toHaveBeenCalledOnce()
    dispatchSpy.mockRestore()
  })

  it('uses modifier up and down for PDF pages', () => {
    const pdfItem: FileItemRecord = {
      id: 'pdf-1',
      parentId: 'root',
      type: 'file',
      sortIndex: 1,
      createdAt: 1,
      expiresAt: null,
      name: 'slides.pdf',
      url: 'blob:pdf-1',
      size: 10,
      mimeType: 'application/pdf'
    }
    storeState.currentItem = () => pdfItem
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    render(<MediaPresenter onExit={mockExit} />)

    findShortcutByConfig({ code: 'ArrowDown', metaOrCtrl: true }).handler(
      new KeyboardEvent('keydown', { code: 'ArrowDown', metaKey: true })
    )
    findShortcutByConfig({ code: 'ArrowUp', metaOrCtrl: true }).handler(
      new KeyboardEvent('keydown', { code: 'ArrowUp', metaKey: true })
    )

    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'media:pdfNextPage' }))
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'media:pdfPrevPage' }))
    dispatchSpy.mockRestore()
  })

  it('returns to Files without ending the live session on final Escape', () => {
    render(<MediaPresenter onExit={mockExit} />)

    findShortcut('Escape').handler(new KeyboardEvent('keydown', { code: 'Escape' }))

    expect(mockExit).toHaveBeenCalledOnce()
    expect(mockEndSession).not.toHaveBeenCalled()
  })
})

it('exits the projection session when advancing from its end screen', () => {
  storeState.isEnded = true
  render(<MediaPresenter onExit={mockExit} />)
  findShortcut('ArrowRight').handler(new KeyboardEvent('keydown', { code: 'ArrowRight' }))
  expect(mockExit).toHaveBeenCalledOnce()
  expect(mockNext).not.toHaveBeenCalled()
})

it('Home and End select presentation pages instead of playlist files', () => {
  storeState.currentItem = () => ({
    ...storeState.currentFile,
    mimeType: 'application/vnd.hhc.presenter+json'
  })
  storeState.typeStates.presentation = { slideIndex: 4, slideCount: 10 }
  render(<MediaPresenter onExit={mockExit} />)
  findShortcut('Home').handler(new KeyboardEvent('keydown', { code: 'Home' }))
  findShortcut('End').handler(new KeyboardEvent('keydown', { code: 'End' }))
  expect(storeState.jumpToSlide).toHaveBeenNthCalledWith(1, 0)
  expect(storeState.jumpToSlide).toHaveBeenNthCalledWith(2, 9)
  expect(storeState.jumpTo).not.toHaveBeenCalled()
})

it('End does not navigate a presentation while its count is unknown', () => {
  storeState.currentItem = () => ({
    ...storeState.currentFile,
    mimeType: 'application/vnd.hhc.presenter+json'
  })
  storeState.typeStates.presentation = { slideIndex: 0 }
  render(<MediaPresenter onExit={mockExit} />)
  findShortcut('End').handler(new KeyboardEvent('keydown', { code: 'End' }))
  expect(storeState.jumpToSlide).not.toHaveBeenCalled()
  expect(storeState.jumpTo).not.toHaveBeenCalled()
})
