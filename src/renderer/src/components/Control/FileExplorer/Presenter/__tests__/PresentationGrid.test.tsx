import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import PresenterGrid from '../PresenterGrid'
import PresenterNavigation from '../PresenterNavigation'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createTextElement
} from '@renderer/lib/editable-presentation'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  read: vi.fn(),
  destroy: vi.fn(),
  render: vi.fn(),
  danger: vi.fn(),
  load: vi.fn(),
  session: vi.fn()
}))
vi.mock('@renderer/lib/editable-presentation', async (original) => ({
  ...(await original<typeof import('@renderer/lib/editable-presentation')>()),
  loadEditablePresentation: mocks.load
}))
vi.mock('@renderer/lib/pptx-renderer-service', () => ({ openPptxViewer: mocks.open }))
vi.mock('@renderer/lib/presentation-source', () => ({ readPresentationArrayBuffer: mocks.read }))
vi.mock('@renderer/contexts/PresentationSessionRegistryContext', () => ({
  usePresentationSessionRegistry: () => ({ get: mocks.session })
}))
vi.mock('@renderer/hooks/useThumbnails', () => ({ useThumbnails: () => ({}) }))
vi.mock('@heroui/react/toast', () => ({ toast: { danger: mocks.danger } }))
const item = {
  id: 'deck',
  name: 'Ten pages.pptx',
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  type: 'file' as const,
  url: 'blob:deck',
  size: 100,
  parentId: 'root',
  sortIndex: 0,
  createdAt: 0,
  expiresAt: null
}
const originalJump = useMediaProjectionStore.getState().jumpToSlide
let resizeCallback: ResizeObserverCallback
let observerCallback: IntersectionObserverCallback
let observed: Element[]
let disposed: ReturnType<typeof vi.fn>[]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockReturnValue(undefined)
  observed = []
  disposed = []
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback
      }
      observe(element: Element): void {
        observed.push(element)
      }
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(180)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
  mocks.read.mockResolvedValue(new ArrayBuffer(0))
  mocks.render.mockImplementation((_index: number, container: HTMLElement) => {
    const dispose = vi.fn()
    disposed.push(dispose)
    container.textContent = 'Rendered page'
    return { ready: Promise.resolve(), dispose }
  })
  mocks.open.mockResolvedValue({
    slideCount: 10,
    slideWidth: 1280,
    slideHeight: 720,
    destroy: mocks.destroy,
    viewer: { renderThumbnailToContainer: mocks.render }
  })
  useMediaProjectionStore.setState({
    playlist: [item],
    currentIndex: 0,
    isPresenting: true,
    isEnded: false,
    showGrid: true,
    typeStates: { presentation: { slideIndex: 0, slideCount: 10 } },
    jumpToSlide: originalJump
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useMediaProjectionStore.setState({ jumpToSlide: originalJump })
})

function intersect(elements: Element[], visible: boolean): void {
  observerCallback(
    elements.map((target) => ({ target, isIntersecting: visible })) as IntersectionObserverEntry[],
    {} as IntersectionObserver
  )
}

describe('presentation page grid', () => {
  it('fits thumbnails to the card and recreates only active handles after resize', async () => {
    const { unmount } = render(<PresenterGrid />)
    await waitFor(() => expect(observed).toHaveLength(10))
    await act(async () => intersect(observed.slice(0, 1), true))
    expect(mocks.render).toHaveBeenLastCalledWith(0, observed[0], { width: 180, height: 100 })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(140)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(75)
    await act(async () =>
      resizeCallback([{ target: observed[0] }] as ResizeObserverEntry[], {} as ResizeObserver)
    )
    expect(disposed[0]).toHaveBeenCalledOnce()
    expect(mocks.render).toHaveBeenLastCalledWith(0, observed[0], { width: 140, height: 75 })
    expect(mocks.render).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('does not reopen or close a newer grid when a pending page jump finishes', async () => {
    let finish!: (result: { status: 'success' }) => void
    useMediaProjectionStore.setState({
      jumpToSlide: vi.fn(
        () =>
          new Promise<{ status: 'success' }>((resolve) => {
            finish = resolve
          })
      )
    })
    const { unmount } = render(<PresenterGrid />)
    fireEvent.click(await screen.findByTestId('grid-slide-6'))
    act(() => useMediaProjectionStore.getState().toggleGrid())
    unmount()
    act(() => useMediaProjectionStore.getState().toggleGrid())
    await act(async () => finish({ status: 'success' }))
    expect(useMediaProjectionStore.getState().showGrid).toBe(true)
  })

  it('shows every page and selecting page 7 retains the source file', async () => {
    render(<PresenterGrid />)
    await waitFor(() => expect(screen.getAllByTestId(/^grid-slide-/)).toHaveLength(10))
    fireEvent.click(screen.getByTestId('grid-slide-6'))
    await waitFor(() => expect(useMediaProjectionStore.getState().showGrid).toBe(false))
    expect(useMediaProjectionStore.getState().currentItem()?.id).toBe('deck')
    expect(useMediaProjectionStore.getState().typeStates.presentation?.slideIndex).toBe(6)
    expect(mocks.open).toHaveBeenCalledOnce()
  })

  it('renders only intersecting pages and releases handles when hidden or closed', async () => {
    mocks.open.mockResolvedValue({
      slideCount: 1000,
      slideWidth: 1280,
      slideHeight: 720,
      destroy: mocks.destroy,
      viewer: { renderThumbnailToContainer: mocks.render }
    })
    const { unmount } = render(<PresenterGrid />)
    await waitFor(() => expect(observed).toHaveLength(1000))
    expect(mocks.render).not.toHaveBeenCalled()
    await act(async () => intersect(observed.slice(0, 3), true))
    expect(mocks.render).toHaveBeenCalledTimes(3)
    await act(async () => intersect(observed.slice(0, 3), false))
    expect(disposed.every((dispose) => dispose.mock.calls.length === 1)).toBe(true)
    await act(async () => intersect(observed.slice(10, 12), true))
    unmount()
    expect(disposed.every((dispose) => dispose.mock.calls.length === 1)).toBe(true)
    expect(mocks.destroy).toHaveBeenCalledOnce()
  })

  it('keeps grid and active page unchanged when a jump is blocked or superseded', async () => {
    useMediaProjectionStore.setState({
      jumpToSlide: vi
        .fn()
        .mockResolvedValueOnce({ status: 'blocked' })
        .mockResolvedValueOnce({ status: 'superseded' })
    })
    render(<PresenterGrid />)
    await screen.findByTestId('grid-slide-6')
    fireEvent.click(screen.getByTestId('grid-slide-6'))
    await waitFor(() => expect(mocks.danger).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByTestId('grid-slide-7'))
    await act(async () => {})
    expect(mocks.danger).toHaveBeenCalledOnce()
    expect(useMediaProjectionStore.getState().showGrid).toBe(true)
    expect(useMediaProjectionStore.getState().typeStates.presentation?.slideIndex).toBe(0)
  })

  it('destroys a viewer that finishes opening after grid closes', async () => {
    let finish!: (value: unknown) => void
    mocks.open.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const { unmount } = render(<PresenterGrid />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
    unmount()
    await act(async () => finish({ slideCount: 10, destroy: mocks.destroy }))
    expect(mocks.destroy).toHaveBeenCalledOnce()
  })
  it('selects the keyboard-focused page with Enter', async () => {
    render(<PresenterGrid />)
    const page = await screen.findByTestId('grid-slide-6')
    fireEvent.focus(page)
    fireEvent.keyDown(page, { key: 'Enter' })
    await waitFor(() =>
      expect(useMediaProjectionStore.getState().typeStates.presentation?.slideIndex).toBe(6)
    )
  })

  it.each([false, true])(
    'renders actual editable pages from an open session: %s',
    async (openSession) => {
      let document = createBlankEditablePresentationDocument('Editable deck')
      const template = document.slides[document.slideOrder[0]]
      document.slideOrder = []
      document.slides = {}
      for (let index = 0; index < 10; index++) {
        const id = `slide-${index}`
        document.slideOrder.push(id)
        document.slides[id] = { ...template, id, name: `Page ${index + 1}` }
        document = addElementToSlide(
          document,
          id,
          createTextElement({ text: `Actual page ${index + 1}` })
        )
      }
      if (openSession) {
        const snapshot = { history: { present: document } }
        mocks.session.mockReturnValue({ subscribe: () => () => {}, getSnapshot: () => snapshot })
      } else mocks.load.mockResolvedValue(document)
      useMediaProjectionStore.setState({
        playlist: [
          { ...item, name: 'Editable.lpdeck', mimeType: 'application/vnd.hhc.presenter+json' }
        ]
      })
      render(<PresenterGrid />)
      await waitFor(() => expect(screen.getAllByTestId(/^grid-slide-/)).toHaveLength(10))
      await act(async () => intersect([observed[6]], true))
      expect(await screen.findByText('Actual page 7')).toBeVisible()
      expect(mocks.open).not.toHaveBeenCalled()
      if (openSession) expect(mocks.load).not.toHaveBeenCalled()
    }
  )

  it('ignores a previous source that opens after replacement', async () => {
    let finish!: (value: unknown) => void
    mocks.open.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    render(<PresenterGrid />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
    const oldDestroy = vi.fn()
    act(() =>
      useMediaProjectionStore.setState({ playlist: [{ ...item, id: 'new', url: 'blob:new' }] })
    )
    await screen.findByTestId('grid-slide-9')
    await act(async () => finish({ slideCount: 1, destroy: oldDestroy }))
    expect(oldDestroy).toHaveBeenCalledOnce()
    expect(screen.getAllByTestId(/^grid-slide-/)).toHaveLength(10)
    expect(useMediaProjectionStore.getState().typeStates.presentation?.slideCount).toBe(10)
  })
})

it('does not show complete progress while presentation pages are loading', () => {
  useMediaProjectionStore.setState({ typeStates: { presentation: { slideIndex: 0 } } })
  render(<PresenterNavigation onNext={vi.fn()} />)
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
})

it('closes the presentation grid with G from its focused viewport', async () => {
  render(<PresenterGrid />)
  await waitFor(() => expect(observed).toHaveLength(10))
  fireEvent.keyDown(document.activeElement!, { key: 'g', code: 'KeyG' })
  expect(useMediaProjectionStore.getState().showGrid).toBe(false)
})
