import { createLyricsEngine } from '../engine'

const workers: TestWorker[] = []
let failInit = false
let failPredict = false
let holdPredict = false
let failCpu = false
class TestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  backend = ''
  terminate = vi.fn()
  constructor() {
    workers.push(this)
  }
  postMessage(message: {
    type: string
    requestId: number
    payload: { options?: { ortOptions: { backend: string } } }
  }): void {
    if (message.type === 'init') this.backend = message.payload.options!.ortOptions.backend
    if (message.type === 'predict' && holdPredict) return
    const failed =
      this.backend === 'wasm' ? failCpu : message.type === 'init' ? failInit : failPredict
    queueMicrotask(() =>
      this.onmessage?.({
        data: {
          kind: 'worker-transport-response',
          requestId: message.requestId,
          status: failed ? 'error' : 'success',
          error: failed ? { message: 'GPU device lost' } : undefined,
          payload:
            message.type === 'init'
              ? { summary: { detProvider: this.backend, recProvider: this.backend } }
              : [
                  {
                    items: [
                      {
                        text: '祂',
                        score: 1,
                        poly: [
                          [0, 0],
                          [1, 0],
                          [1, 1],
                          [0, 1]
                        ]
                      }
                    ]
                  }
                ]
        }
      } as MessageEvent)
    )
  }
}
beforeEach(() => {
  workers.length = 0
  failInit = failPredict = holdPredict = failCpu = false
  vi.stubGlobal('Worker', TestWorker)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockImplementation(async () => ({ close: vi.fn() }))
  )
})
afterEach(() => vi.unstubAllGlobals())
const image = { width: 1, height: 1, data: new Uint8ClampedArray(4) } as ImageData

it('prefers automatic GPU selection while retaining recognition output', async () => {
  const engine = await createLyricsEngine(new AbortController().signal)
  expect(workers[0].backend).toBe('auto')
  expect(await engine.recognize(image)).toMatchObject([{ text: '祂' }])
  engine.dispose()
  expect(workers[0].terminate).toHaveBeenCalledOnce()
})

it.each(['init', 'predict'])('recovers a GPU %s failure in a fresh CPU worker', async (failure) => {
  failInit = failure === 'init'
  failPredict = failure === 'predict'
  const engine = await createLyricsEngine(new AbortController().signal)
  expect(await engine.recognize(image)).toMatchObject([{ text: '祂' }])
  expect(workers.map((worker) => worker.backend)).toEqual(['auto', 'wasm'])
  expect(workers[0].terminate).toHaveBeenCalledOnce()
  await engine.recognize(image)
  expect(workers).toHaveLength(2)
  engine.dispose()
  expect(workers[1].terminate).toHaveBeenCalledOnce()
})

it.each(['abort', 'dispose'])('does not revive a disabled session after %s', async (action) => {
  const abort = new AbortController()
  const engine = await createLyricsEngine(abort.signal)
  holdPredict = true
  const prediction = engine.recognize(image)
  const rejected = expect(prediction).rejects.toMatchObject({ name: 'AbortError' })
  await Promise.resolve()
  if (action === 'abort') abort.abort()
  else engine.dispose()
  await rejected
  expect(workers).toHaveLength(1)
  expect(workers[0].terminate).toHaveBeenCalledOnce()
})

it('reports CPU recovery failure without retrying or keeping workers alive', async () => {
  failInit = failCpu = true
  await expect(createLyricsEngine(new AbortController().signal)).rejects.toThrow('GPU device lost')
  expect(workers).toHaveLength(2)
  for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce()
})

it('does not allocate a worker for an already cancelled session', async () => {
  const abort = new AbortController()
  abort.abort()
  await expect(createLyricsEngine(abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(workers).toHaveLength(0)
})
