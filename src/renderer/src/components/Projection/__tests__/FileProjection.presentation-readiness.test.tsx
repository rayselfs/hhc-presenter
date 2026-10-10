import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FileProjection from '../FileProjection'
import type { ProjectionPayload } from '@shared/projection-messages'

const { send, renderSlide, loadFont } = vi.hoisted(() => ({
  send: vi.fn(),
  renderSlide: vi.fn().mockResolvedValue(undefined),
  loadFont: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@renderer/lib/projection-adapter', () => ({
  createProjectionAdapter: () => ({
    setGeneration: vi.fn(),
    send,
    on: vi.fn(() => vi.fn()),
    dispose: vi.fn()
  })
}))
vi.mock('@renderer/lib/font-loader', () => ({
  loadPresentationFont: loadFont,
  loadLanguageFont: vi.fn()
}))
vi.mock('@renderer/lib/presentation-source', () => ({
  readPresentationArrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0))
}))
vi.mock('@renderer/lib/pptx-renderer-service', () => ({
  openPptxViewer: vi.fn(async () => ({
    viewer: { renderSlide },
    slideCount: 1,
    slideWidth: 1280,
    slideHeight: 720,
    destroy: vi.fn()
  }))
}))

const editable: NonNullable<ProjectionPayload<'file:show'>['editablePresentation']> = {
  width: 1280,
  height: 720,
  slide: {
    id: 'slide',
    name: 'Slide',
    background: { type: 'solid', color: '#ffffff', transparency: 0 },
    elementOrder: ['image'],
    elements: {
      image: {
        id: 'image',
        type: 'image',
        assetId: 'image',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        rotation: 0,
        opacity: 1
      }
    },
    notes: ''
  },
  assets: {
    image: {
      id: 'image',
      name: 'image.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AAA='
    }
  }
}
const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode')
const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
const props = {
  initialItemId: 'deck',
  initialBlobId: 'blob',
  initialContentRevision: 1,
  initialMimeType: 'application/vnd.hhc.presenter+json',
  initialPresentation: { slideIndex: 0, slideCount: 1 },
  initialEditablePresentation: editable
}
function status(revision: number, value: string): unknown[] {
  return [
    'file:render-status',
    expect.objectContaining({ contentRevision: revision, status: value })
  ]
}

describe('presentation readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    if (originalDecode) Object.defineProperty(HTMLImageElement.prototype, 'decode', originalDecode)
    else Reflect.deleteProperty(HTMLImageElement.prototype, 'decode')
    if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts)
    else Reflect.deleteProperty(document, 'fonts')
  })

  it('reports ready again when the same PPTX slide is retried with a new revision', async () => {
    const pptxProps = {
      ...props,
      initialEditablePresentation: undefined,
      initialMimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    }
    const { rerender } = render(<FileProjection {...pptxProps} />)
    await waitFor(() => expect(send).toHaveBeenCalledWith(...status(1, 'ready')))
    rerender(<FileProjection {...pptxProps} initialContentRevision={2} />)
    await waitFor(() => expect(send).toHaveBeenCalledWith(...status(2, 'ready')))
  })

  it('waits for image decode and document fonts before reporting editable ready', async () => {
    let decode!: () => void
    let fontsReady!: () => void
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            decode = resolve
          })
      )
    })
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        ready: new Promise<void>((resolve) => {
          fontsReady = resolve
        })
      }
    })
    render(<FileProjection {...props} />)
    expect(send).not.toHaveBeenCalledWith(...status(1, 'ready'))
    await act(async () => {
      decode()
    })
    expect(send).not.toHaveBeenCalledWith(...status(1, 'ready'))
    await act(async () => {
      fontsReady()
    })
    await waitFor(() => expect(send).toHaveBeenCalledWith(...status(1, 'ready')))
  })

  it('waits for presentation font loading before reporting editable ready', async () => {
    let finishFont!: () => void
    const pendingFont = new Promise<void>((resolve) => {
      finishFont = resolve
    })
    loadFont.mockReturnValue(pendingFont)
    render(
      <FileProjection
        {...props}
        initialEditablePresentation={{
          ...editable,
          slide: {
            ...editable.slide,
            elementOrder: ['text'],
            elements: {
              text: {
                id: 'text',
                type: 'text',
                x: 0,
                y: 0,
                width: 200,
                height: 100,
                rotation: 0,
                opacity: 1,
                text: 'Hello',
                fontFamily: 'Noto Sans TC Variable',
                fontSize: 32,
                bold: false,
                italic: false,
                underline: false,
                color: '#000000',
                align: 'left',
                lineHeight: 1.2
              }
            }
          }
        }}
      />
    )
    expect(loadFont.mock.calls.map(([family]) => family)).toContain('Noto Sans TC Variable')
    expect(send).not.toHaveBeenCalledWith(...status(1, 'ready'))
    await act(async () => {
      finishFont()
    })
    await waitFor(() => expect(send).toHaveBeenCalledWith(...status(1, 'ready')))
    loadFont.mockResolvedValue(undefined)
  })

  it('reports failed when an editable image cannot be decoded', async () => {
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: vi.fn().mockRejectedValue(new Error('Broken image'))
    })
    render(<FileProjection {...props} />)
    await waitFor(() => expect(send).toHaveBeenCalledWith(...status(1, 'failed')))
    expect(send).not.toHaveBeenCalledWith(...status(1, 'ready'))
  })

  it('reports failed for a missing editable image asset', async () => {
    render(<FileProjection {...props} initialEditablePresentation={{ ...editable, assets: {} }} />)
    await waitFor(() => expect(send).toHaveBeenCalledWith(...status(1, 'failed')))
    expect(send).not.toHaveBeenCalledWith(...status(1, 'ready'))
  })

  it('ignores image completion after switching content revisions', async () => {
    const decodes: Array<() => void> = []
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            decodes.push(resolve)
          })
      )
    })
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() }
    })
    const { rerender } = render(<FileProjection {...props} />)
    rerender(<FileProjection {...props} initialContentRevision={2} />)
    await act(async () => {
      decodes[0]()
    })
    expect(send).not.toHaveBeenCalledWith(...status(2, 'ready'))
    await act(async () => {
      decodes[1]()
    })
    await waitFor(() => expect(send).toHaveBeenCalledWith(...status(2, 'ready')))
  })
})
