import { isElectron } from '../env'
import type { LyricsBlock } from './lines'
export type LyricsEngine = { recognize(image: ImageData): Promise<LyricsBlock[]>; dispose(): void }
type WorkerResponse = {
  kind: string
  requestId: number
  status: 'success' | 'error'
  payload?: unknown
  error?: { message: string }
}
export async function createLyricsEngine(signal: AbortSignal): Promise<LyricsEngine> {
  const abort = new AbortController()
  const dispose = (): void => {
    abort.abort()
    signal.removeEventListener('abort', dispose)
  }
  signal.addEventListener('abort', dispose, { once: true })
  if (signal.aborted) dispose()
  let cpuOnly = false
  const startCpu = (): Promise<LyricsEngine> => {
    cpuOnly = true
    return createWorkerEngine(abort.signal, 'wasm')
  }
  try {
    let engine: LyricsEngine
    try {
      engine = await createWorkerEngine(abort.signal, 'auto')
    } catch (error) {
      if (abort.signal.aborted) throw error
      engine = await startCpu()
    }
    return {
      async recognize(image) {
        try {
          return await engine.recognize(image)
        } catch (error) {
          if (abort.signal.aborted || cpuOnly) throw error
          // A lost GPU device must not poison the CPU recovery session.
          engine.dispose()
          engine = await startCpu()
          return engine.recognize(image)
        }
      },
      dispose
    }
  } catch (error) {
    dispose()
    throw error
  }
}

async function createWorkerEngine(
  signal: AbortSignal,
  backend: 'auto' | 'wasm'
): Promise<LyricsEngine> {
  signal.throwIfAborted()
  const packaged = isElectron() && location.protocol === 'file:'
  const baseUrl = packaged
    ? 'hhc-lyrics://runtime/lyrics-runtime/'
    : new URL('./lyrics-runtime/', document.baseURI).href
  const worker = new Worker(new URL('ocr-worker.js', baseUrl), { type: 'module' })
  let sequence = 0,
    stopped = false
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const dispose = (): void => {
    if (stopped) return
    stopped = true
    worker.terminate()
    signal.removeEventListener('abort', dispose)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new DOMException('OCR stopped', 'AbortError'))
    }
    pending.clear()
  }
  worker.onmessage = (event: MessageEvent<WorkerResponse>): void => {
    if (event.data.kind !== 'worker-transport-response') return
    const request = pending.get(event.data.requestId)
    if (!request) return
    pending.delete(event.data.requestId)
    clearTimeout(request.timer)
    if (event.data.status === 'error')
      request.reject(new Error(event.data.error?.message || 'OCR failed'))
    else request.resolve(event.data.payload)
  }
  worker.onerror = (error) => {
    console.error('[lyrics] Worker failed', error.message)
    dispose()
  }
  signal.addEventListener('abort', dispose, { once: true })
  if (signal.aborted) dispose()
  // shortcut: SDK worker transport is pinned to 0.4.2; revalidate image gates before upgrading.
  const send = (
    type: string,
    payload: unknown,
    transfer: Transferable[] = []
  ): Promise<unknown> => {
    if (stopped) return Promise.reject(new DOMException('OCR stopped', 'AbortError'))
    const requestId = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('OCR timed out'))
        dispose()
      }, 60000)
      pending.set(requestId, { resolve, reject, timer })
      worker.postMessage({ kind: 'worker-transport-request', type, payload, requestId }, transfer)
    })
  }
  try {
    const response = await fetch(new URL('pipeline.json', baseUrl), { signal })
    if (!response.ok) throw new Error('OCR configuration unavailable')
    const pipelineConfig: unknown = await response.json()
    const initialized = await send('init', {
      options: {
        pipelineConfig,
        ortOptions: { backend, numThreads: 1, wasmPaths: baseUrl, proxy: false }
      }
    })
    if (initialized && typeof initialized === 'object' && 'summary' in initialized)
      console.info('[lyrics] OCR initialized', JSON.stringify(initialized.summary))
  } catch (error) {
    dispose()
    throw error
  }
  return {
    async recognize(image) {
      const imageBitmap = await createImageBitmap(image)
      try {
        const result = await send('predict', { sources: [{ kind: 'imageBitmap', imageBitmap }] }, [
          imageBitmap
        ])
        if (!Array.isArray(result) || !result[0] || !Array.isArray(result[0].items))
          throw new Error('Invalid OCR response')
        return result[0].items as LyricsBlock[]
      } finally {
        imageBitmap.close()
      }
    },
    dispose
  }
}
