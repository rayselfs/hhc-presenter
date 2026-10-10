import { render, screen, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import PresenterGrid from '../PresenterGrid'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'

const toastMocks = vi.hoisted(() => ({ danger: vi.fn() }))

vi.mock('@heroui/react/toast', () => ({ toast: toastMocks }))

// Mock out UI dependencies to render cleanly in jsdom
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn()
  }
}))

const emptyThumbnails = {}
vi.mock('@renderer/hooks/useThumbnails', () => ({
  useThumbnails: () => emptyThumbnails
}))

vi.mock('@renderer/components/Common/GlassDivider', () => ({
  default: () => <div data-testid="glass-divider" />
}))

window.HTMLElement.prototype.scrollIntoView = vi.fn()

describe('PresenterGrid Rendering Optimization', () => {
  beforeEach(() => {
    // Set up store state
    const playlist = Array.from({ length: 10 }).map((_, i) => ({
      id: `item-${i}`,
      name: `Item ${i}`,
      url: `blob:item-${i}`,
      mimeType: 'image/png',
      size: 100,
      type: 'file' as const,
      parentId: 'root',
      sortIndex: i,
      createdAt: 0,
      expiresAt: null
    }))

    useMediaProjectionStore.setState({
      playlist,
      currentIndex: 3,
      showGrid: true
    })
  })

  it('closes the file grid with G while the grid owns keyboard focus', () => {
    render(<PresenterGrid />)
    fireEvent.keyDown(document.activeElement!, { key: 'g', code: 'KeyG' })
    expect(useMediaProjectionStore.getState().showGrid).toBe(false)
  })

  it('ignores modified G and composition while the grid owns keyboard focus', () => {
    render(<PresenterGrid />)
    fireEvent.keyDown(document.activeElement!, { key: 'g', code: 'KeyG', ctrlKey: true })
    fireEvent.keyDown(document.activeElement!, { key: 'g', code: 'KeyG', isComposing: true })
    expect(useMediaProjectionStore.getState().showGrid).toBe(true)
  })

  it('only re-renders prev/next active item when currentIndex changes', () => {
    render(<PresenterGrid />)

    const initialRenderIds = Array.from({ length: 10 }).map((_, i) => {
      return screen.getByTestId(`grid-item-${i}`).getAttribute('data-render')
    })

    act(() => {
      useMediaProjectionStore.setState({ currentIndex: 4 })
    })

    const newRenderIds = Array.from({ length: 10 }).map((_, i) => {
      return screen.getByTestId(`grid-item-${i}`).getAttribute('data-render')
    })

    expect(newRenderIds[3]).not.toBe(initialRenderIds[3])
    expect(newRenderIds[4]).not.toBe(initialRenderIds[4])

    for (let i = 0; i < 10; i++) {
      if (i !== 3 && i !== 4) {
        expect(newRenderIds[i], `Item ${i} re-rendered unexpectedly`).toBe(initialRenderIds[i])
      }
    }
  })

  it('only re-renders prev/next focused item on mouse hover', async () => {
    const user = userEvent.setup()
    render(<PresenterGrid />)

    const initialRenderIds = Array.from({ length: 10 }).map((_, i) => {
      return screen.getByTestId(`grid-item-${i}`).getAttribute('data-render')
    })

    const item5 = screen.getByTestId('grid-item-5')

    await act(async () => {
      await user.hover(item5)
    })

    const newRenderIds = Array.from({ length: 10 }).map((_, i) => {
      return screen.getByTestId(`grid-item-${i}`).getAttribute('data-render')
    })

    expect(newRenderIds[3]).not.toBe(initialRenderIds[3])
    expect(newRenderIds[5]).not.toBe(initialRenderIds[5])

    for (let i = 0; i < 10; i++) {
      if (i !== 3 && i !== 5) {
        expect(newRenderIds[i], `Item ${i} re-rendered unexpectedly`).toBe(initialRenderIds[i])
      }
    }
  })

  it('limits the grid to six columns', () => {
    render(<PresenterGrid />)

    const grid = screen.getByTestId('grid-item-0').parentElement
    expect(grid?.className).toContain('lg:grid-cols-6')
    expect(grid?.className).not.toContain('xl:grid-cols-8')
  })

  it('keeps the grid open and stays quiet when navigation is superseded', async () => {
    const user = userEvent.setup()
    const jumpTo = vi.fn(async () => ({ status: 'superseded' }))
    useMediaProjectionStore.setState({ jumpTo } as never)
    render(<PresenterGrid />)

    await user.click(screen.getByTestId('grid-item-4'))

    expect(jumpTo).toHaveBeenCalledWith(4)
    expect(useMediaProjectionStore.getState().showGrid).toBe(true)
    expect(toastMocks.danger).not.toHaveBeenCalled()
  })

  it('shows the existing failure toast only when finalization is blocked', async () => {
    const user = userEvent.setup()
    const jumpTo = vi.fn(async () => ({ status: 'blocked' }))
    useMediaProjectionStore.setState({ jumpTo } as never)
    render(<PresenterGrid />)

    await user.click(screen.getByTestId('grid-item-4'))

    expect(useMediaProjectionStore.getState().showGrid).toBe(true)
    expect(toastMocks.danger).toHaveBeenCalledTimes(1)
  })
})
