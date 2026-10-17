import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPptxViewerLifetime } from '../pptx-viewer-lifetime'

const { open } = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../pptx-renderer-service', () => ({ openPptxViewer: open }))

function handle(): { destroy: ReturnType<typeof vi.fn> } {
  return { destroy: vi.fn() }
}

describe('PPTX viewer lifetime', () => {
  beforeEach(() => vi.clearAllMocks())

  it('aborts and destroys an installed viewer exactly once', async () => {
    const viewer = handle()
    open.mockResolvedValue(viewer)
    const container = document.createElement('div')
    const lifetime = createPptxViewerLifetime(container, 'w-full')
    expect(await lifetime.open(new ArrayBuffer(1))).toBe(viewer)
    const signal = open.mock.calls[0][2].signal as AbortSignal
    expect(signal.aborted).toBe(false)
    lifetime.dispose()
    lifetime.dispose()
    expect(signal.aborted).toBe(true)
    expect(container.childElementCount).toBe(0)
    expect(viewer.destroy).toHaveBeenCalledTimes(1)
    expect(await lifetime.open(new ArrayBuffer(1))).toBeNull()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('destroys a late viewer without changing a newer lifetime host', async () => {
    let resolve!: (value: ReturnType<typeof handle>) => void
    open.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const container = document.createElement('div')
    const previous = createPptxViewerLifetime(container, 'old')
    const pending = previous.open(new ArrayBuffer(1))
    const oldTarget = container.firstElementChild
    previous.dispose()
    const current = createPptxViewerLifetime(container, 'current')
    const currentTarget = container.firstElementChild
    const late = handle()
    resolve(late)
    expect(await pending).toBeNull()
    expect(late.destroy).toHaveBeenCalledTimes(1)
    expect(oldTarget?.parentElement).toBeNull()
    expect(container.firstElementChild).toBe(currentTarget)
    expect(current.isDisposed()).toBe(false)
    current.dispose()
  })

  it('preserves renderer rejection and still releases its host', async () => {
    const failure = new Error('Invalid PPTX')
    open.mockRejectedValue(failure)
    const container = document.createElement('div')
    const lifetime = createPptxViewerLifetime(container, '')
    await expect(lifetime.open(new ArrayBuffer(1))).rejects.toBe(failure)
    lifetime.dispose()
    expect(container.childElementCount).toBe(0)
  })
})
