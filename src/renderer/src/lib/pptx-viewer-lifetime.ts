import { openPptxViewer, type PptxViewerHandle } from './pptx-renderer-service'

type PptxViewerLifetime = {
  isDisposed: () => boolean
  open: (buffer: ArrayBuffer) => Promise<PptxViewerHandle | null>
  dispose: () => void
}

export function createPptxViewerLifetime(
  container: HTMLElement,
  className: string
): PptxViewerLifetime {
  const target = document.createElement('div')
  target.className = className
  container.replaceChildren(target)
  const controller = new AbortController()
  let disposed = false
  let viewer: PptxViewerHandle | null = null

  return {
    isDisposed: (): boolean => disposed,
    async open(buffer: ArrayBuffer): Promise<PptxViewerHandle | null> {
      if (disposed) return null
      const handle = await openPptxViewer(buffer, target, {
        renderMode: 'slide',
        signal: controller.signal
      })
      if (disposed) {
        handle.destroy()
        return null
      }
      viewer = handle
      return handle
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      controller.abort()
      target.remove()
      viewer?.destroy()
      viewer = null
    }
  }
}
