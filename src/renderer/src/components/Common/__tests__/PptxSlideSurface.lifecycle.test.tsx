import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PptxSlideSurface from '../PptxSlideSurface'

const { open, read } = vi.hoisted(() => ({ open: vi.fn(), read: vi.fn() }))
vi.mock('@renderer/lib/pptx-renderer-service', () => ({ openPptxViewer: open }))
vi.mock('@renderer/lib/presentation-source', () => ({ readPresentationArrayBuffer: read }))

describe('PPTX render completion', () => {
  beforeEach(() => {
    open.mockReset()
    read.mockReset()
  })

  it('reuses a healthy viewer for slide progression and same-slide revisions', async () => {
    read.mockResolvedValue(new ArrayBuffer(0))
    const renderSlide = vi.fn().mockResolvedValue(undefined)
    open.mockResolvedValue({
      viewer: { renderSlide },
      slideCount: 2,
      slideWidth: 100,
      slideHeight: 50,
      destroy: vi.fn()
    })
    const onReady = vi.fn()
    const source = {
      id: 'deck',
      url: 'blob:deck',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    }
    const { rerender } = render(
      <PptxSlideSurface source={source} slideIndex={0} renderRevision={1} onReady={onReady} />
    )
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
    rerender(
      <PptxSlideSurface source={source} slideIndex={1} renderRevision={2} onReady={onReady} />
    )
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(2))
    rerender(
      <PptxSlideSurface source={source} slideIndex={1} renderRevision={3} onReady={onReady} />
    )
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(3))
    expect(open).toHaveBeenCalledOnce()
    expect(renderSlide.mock.calls).toEqual([[0], [1], [1]])
  })

  it.each(['open', 'render'])('retries a failed %s only on a new revision', async (failure) => {
    read.mockResolvedValue(new ArrayBuffer(0))
    const destroy = vi.fn()
    if (failure === 'open') open.mockRejectedValueOnce(new Error('Failed'))
    else
      open.mockResolvedValueOnce({
        viewer: { renderSlide: vi.fn().mockRejectedValue(new Error('Failed')) },
        slideCount: 2,
        slideWidth: 100,
        slideHeight: 50,
        destroy
      })
    open.mockResolvedValueOnce({
      viewer: { renderSlide: vi.fn().mockResolvedValue(undefined) },
      slideCount: 2,
      slideWidth: 100,
      slideHeight: 50,
      destroy: vi.fn()
    })
    const source = {
      id: 'deck',
      url: 'blob:deck',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    }
    const onReady = vi.fn()
    const onError = vi.fn()
    const { rerender } = render(
      <PptxSlideSurface
        source={source}
        slideIndex={0}
        renderRevision={1}
        onReady={onReady}
        onError={onError}
      />
    )
    await waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(open).toHaveBeenCalledOnce()
    rerender(
      <PptxSlideSurface
        source={source}
        slideIndex={0}
        renderRevision={2}
        onReady={onReady}
        onError={onError}
      />
    )
    await waitFor(() => expect(onReady).toHaveBeenCalledOnce())
    expect(open).toHaveBeenCalledTimes(2)
    expect(destroy).toHaveBeenCalledTimes(failure === 'render' ? 1 : 0)
  })

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
  it('isolates a cancelled open so its late destroy cannot clear the new slide', async () => {
    read.mockResolvedValue(new ArrayBuffer(0))
    let resolveOld!: (handle: object) => void
    let oldHost!: HTMLElement
    let oldSignal: AbortSignal | undefined
    const oldDestroy = vi.fn(() => {
      oldHost.innerHTML = ''
    })
    open
      .mockImplementationOnce((_buffer, host, options) => {
        oldHost = host
        oldSignal = options.signal
        return new Promise((resolve) => {
          resolveOld = resolve
        })
      })
      .mockImplementationOnce(async (_buffer, host: HTMLElement) => ({
        viewer: {
          renderSlide: async () => {
            host.textContent = 'Current slide'
          }
        },
        slideCount: 3,
        slideWidth: 100,
        slideHeight: 50,
        destroy: vi.fn(() => {
          host.innerHTML = ''
        })
      }))
    const { rerender, container } = render(
      <PptxSlideSurface
        source={{
          id: 'old',
          url: 'blob:old',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        }}
        slideIndex={0}
      />
    )
    await waitFor(() => expect(oldHost).toBeDefined())
    rerender(
      <PptxSlideSurface
        source={{
          id: 'new',
          url: 'blob:new',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        }}
        slideIndex={0}
      />
    )
    await waitFor(() => expect(container).toHaveTextContent('Current slide'))
    await act(async () =>
      resolveOld({
        viewer: { renderSlide: vi.fn() },
        slideCount: 2,
        slideWidth: 100,
        slideHeight: 50,
        destroy: oldDestroy
      })
    )
    expect(oldDestroy).toHaveBeenCalledOnce()
    expect(container).toHaveTextContent('Current slide')
    expect(oldSignal?.aborted).toBe(true)
    expect(oldHost.isConnected).toBe(false)
  })
})
