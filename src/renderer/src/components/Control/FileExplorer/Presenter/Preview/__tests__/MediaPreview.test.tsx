import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import MediaPreview from '../MediaPreview'
import type { MediaTypeDescriptor } from '@renderer/lib/presenter-registry'

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('MediaPreview', () => {
  it('delegates an end-screen click to the workspace close transaction', () => {
    const onExit = vi.fn()
    render(
      <MediaPreview onNext={vi.fn()} currentItem={null} descriptor={null} isEnded onExit={onExit} />
    )
    fireEvent.click(screen.getByText('presenter.endOfSlides'))
    expect(onExit).toHaveBeenCalledOnce()
  })

  it('routes preview clicks through the shared next action', () => {
    const onNext = vi.fn()
    render(
      <MediaPreview
        onNext={onNext}
        currentItem={null}
        descriptor={{ clickToAdvance: true } as MediaTypeDescriptor}
        onExit={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('presenter.noMediaSelected'))
    expect(onNext).toHaveBeenCalledOnce()
  })
})

it('measures pan against the visible stage instead of the surrounding letterbox', () => {
  useMediaProjectionStore.setState({ zoomLevel: 2, pan: { x: 0, y: 0 } })
  const { container } = render(
    <MediaPreview currentItem={null} descriptor={null} onNext={vi.fn()} onExit={vi.fn()} />
  )
  const stage = container.querySelector('.presenter-preview-stage')!
  vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 100,
    bottom: 100,
    toJSON: () => ({})
  })
  fireEvent.mouseDown(stage, { clientX: 10, clientY: 10 })
  fireEvent.mouseMove(document, { clientX: 30, clientY: 10 })
  fireEvent.mouseUp(document)
  expect(useMediaProjectionStore.getState().pan.x).toBeCloseTo(0.4)
  useMediaProjectionStore.setState({ zoomLevel: 1, pan: { x: 0, y: 0 } })
})
