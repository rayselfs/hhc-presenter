import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUpdateNotes = vi.fn()
const mockCurrentItem = vi.fn()
const mockNextItem = vi.fn()
const mockTypeStates: { presentation: { slideIndex: number; slideCount?: number } } = {
  presentation: { slideIndex: 0, slideCount: 13 }
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@heroui/react', () => ({
  Button: ({
    children,
    onPress,
    isIconOnly: _isIconOnly,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    onPress?: () => void
    isIconOnly?: boolean
  }) => (
    <button {...props} onClick={onPress}>
      {children}
    </button>
  )
}))

vi.mock('@renderer/components/Common/GlassDivider', () => ({
  default: () => <div data-testid="glass-divider" />
}))

vi.mock('../Preview/NextItemPreview', () => ({
  default: ({ slideIndex }: { slideIndex?: number }) => (
    <div data-testid="next-item-preview">{slideIndex}</div>
  )
}))

vi.mock('@renderer/stores/media-projection', () => ({
  useMediaProjectionStore: Object.assign(
    (
      selector: (state: {
        nextItem: typeof mockNextItem
        currentItem: typeof mockCurrentItem
        typeStates: typeof mockTypeStates
        updateNotes: typeof mockUpdateNotes
      }) => unknown
    ) =>
      selector({
        nextItem: mockNextItem,
        currentItem: mockCurrentItem,
        typeStates: mockTypeStates,
        updateNotes: mockUpdateNotes
      }),
    {
      getState: () => ({
        nextItem: mockNextItem,
        currentItem: mockCurrentItem,
        typeStates: mockTypeStates,
        updateNotes: mockUpdateNotes
      })
    }
  )
}))

import PresenterSidebar from '../PresenterSidebar'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'

describe('PresenterSidebar', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockTypeStates.presentation = { slideIndex: 0, slideCount: 13 }
    void useMediaProjectionStore.getState()
    mockCurrentItem.mockReturnValue({ id: 'b', notes: 'initial' })
    mockNextItem.mockReturnValue(null)
  })

  it('previews the next slide instead of the end of a single-file deck', () => {
    mockCurrentItem.mockReturnValue({
      id: 'deck',
      url: 'blob:deck',
      mimeType: 'application/vnd.hhc.presenter+json'
    })
    render(<PresenterSidebar previewCache={{}} onNext={vi.fn()} />)
    expect(screen.queryByText('presenter.endOfSlides')).not.toBeInTheDocument()
    expect(screen.getByTestId('next-item-preview')).toHaveTextContent('1')
  })

  it('shows the end only after the final slide', () => {
    mockCurrentItem.mockReturnValue({
      id: 'deck',
      url: 'blob:deck',
      mimeType: 'application/vnd.hhc.presenter+json'
    })
    mockTypeStates.presentation = { slideIndex: 12, slideCount: 13 }
    render(<PresenterSidebar previewCache={{}} onNext={vi.fn()} />)
    expect(screen.getByText('presenter.endOfSlides')).toBeInTheDocument()
    expect(screen.queryByTestId('next-item-preview')).not.toBeInTheDocument()
  })

  it('waits for the page count before announcing the end', () => {
    mockCurrentItem.mockReturnValue({
      id: 'deck',
      url: 'blob:deck',
      mimeType: 'application/vnd.hhc.presenter+json'
    })
    mockTypeStates.presentation = { slideIndex: 0 }
    render(<PresenterSidebar previewCache={{}} onNext={vi.fn()} />)
    expect(screen.getByText('presenter.loading')).toBeInTheDocument()
    expect(screen.queryByText('presenter.endOfSlides')).not.toBeInTheDocument()
  })

  it('updates local notes immediately and debounces store update', () => {
    render(<PresenterSidebar previewCache={{}} onNext={vi.fn()} />)

    const textarea = screen.getByPlaceholderText('presenter.notesPlaceholder')
    fireEvent.change(textarea, { target: { value: 'hello' } })

    expect(textarea).toHaveValue('hello')
    expect(mockUpdateNotes).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(mockUpdateNotes).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(mockUpdateNotes).toHaveBeenCalledTimes(1)
    expect(mockUpdateNotes).toHaveBeenCalledWith('b', 'hello')
  })

  afterEach(() => {
    vi.useRealTimers()
  })
})
