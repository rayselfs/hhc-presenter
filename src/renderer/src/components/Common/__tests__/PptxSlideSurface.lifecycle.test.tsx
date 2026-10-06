import { act, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PptxSlideSurface from '../PptxSlideSurface'

const { open, read } = vi.hoisted(() => ({ open: vi.fn(), read: vi.fn() }))
vi.mock('@renderer/lib/pptx-renderer-service', () => ({ openPptxViewer: open }))
vi.mock('@renderer/lib/presentation-source', () => ({ readPresentationArrayBuffer: read }))

describe('PPTX render completion', () => {
  it('reports readiness only after rendering and ignores a replaced viewer failure', async () => {
    read.mockResolvedValue(new ArrayBuffer(0))
    let rejectOld!: (error: Error) => void
    let resolveNew!: () => void
    const firstRender = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOld = reject
        })
    )
    const secondRender = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveNew = resolve
        })
    )
    open
      .mockResolvedValueOnce({
        viewer: { renderSlide: firstRender },
        slideCount: 2,
        slideWidth: 100,
        slideHeight: 50,
        destroy: vi.fn()
      })
      .mockResolvedValueOnce({
        viewer: { renderSlide: secondRender },
        slideCount: 3,
        slideWidth: 100,
        slideHeight: 50,
        destroy: vi.fn()
      })
    const onReady = vi.fn()
    const onError = vi.fn()
    const { rerender } = render(
      <PptxSlideSurface
        source={{
          id: 'old',
          url: 'blob:old',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        }}
        slideIndex={0}
        onReady={onReady}
        onError={onError}
      />
    )
    await waitFor(() => expect(firstRender).toHaveBeenCalled())
    expect(onReady).not.toHaveBeenCalled()
    rerender(
      <PptxSlideSurface
        source={{
          id: 'new',
          url: 'blob:new',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        }}
        slideIndex={0}
        onReady={onReady}
        onError={onError}
      />
    )
    await waitFor(() => expect(secondRender).toHaveBeenCalled())
    await act(async () => {
      rejectOld(new Error('obsolete render'))
      resolveNew()
    })
    expect(onError).not.toHaveBeenCalled()
    expect(onReady).toHaveBeenCalledWith({ slideCount: 3, width: 100, height: 50 })
  })
})
