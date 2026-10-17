import type { WorkerIncomingMessage, WorkerOutgoingMessage } from '@renderer/workers/timer.worker'
import type {
  TimerRuntimeCommand,
  TimerRuntimeConfiguration,
  TimerRuntimeResult,
  TimerRuntimeSnapshot
} from '@shared/types/timer'
import { isElectron } from './env'

export interface TimerAdapter {
  initialize(configuration: TimerRuntimeConfiguration): Promise<TimerRuntimeResult>
  execute(command: TimerRuntimeCommand): Promise<TimerRuntimeResult>
  onSnapshot(callback: (snapshot: TimerRuntimeSnapshot) => void): () => void
  dispose(): void
}

type RuntimeRequest =
  | { type: 'initialize'; configuration: TimerRuntimeConfiguration }
  | { type: 'command'; command: TimerRuntimeCommand }
interface TimerAdapterSession extends TimerAdapter {
  acceptSnapshot(snapshot: TimerRuntimeSnapshot): void
}
const disposedResult: TimerRuntimeResult = { status: 'rejected', reason: 'disposed' }
const unavailableResult: TimerRuntimeResult = { status: 'rejected', reason: 'host-unavailable' }

function createTimerSession(
  request: (message: RuntimeRequest) => Promise<TimerRuntimeResult>,
  close: () => void
): TimerAdapterSession {
  let disposed = false
  let latest: TimerRuntimeSnapshot | null = null
  let queue = Promise.resolve()
  const listeners = new Set<(snapshot: TimerRuntimeSnapshot) => void>()
  const cancellations = new Set<(result: TimerRuntimeResult) => void>()

  function acceptSnapshot(snapshot: TimerRuntimeSnapshot): void {
    if (disposed || (latest && snapshot.revision <= latest.revision)) return
    latest = snapshot
    for (const listener of [...listeners]) listener(snapshot)
  }
  function enqueue(message: RuntimeRequest): Promise<TimerRuntimeResult> {
    const pending = queue.then(async (): Promise<TimerRuntimeResult> => {
      if (disposed) return disposedResult
      let cancel!: (result: TimerRuntimeResult) => void
      const cancelled = new Promise<TimerRuntimeResult>((resolve) => {
        cancel = resolve
      })
      cancellations.add(cancel)
      try {
        const result = await Promise.race([request(message), cancelled])
        if (disposed) return disposedResult
        if (result.status === 'accepted') acceptSnapshot(result.snapshot)
        return result
      } catch (error) {
        console.error('[timer] Runtime request failed', error)
        return unavailableResult
      } finally {
        cancellations.delete(cancel)
      }
    })
    queue = pending.then(() => {})
    return pending
  }
  return {
    initialize: (configuration) => enqueue({ type: 'initialize', configuration }),
    execute: (command) => enqueue({ type: 'command', command }),
    acceptSnapshot,
    onSnapshot: (listener) => {
      if (disposed) return () => {}
      listeners.add(listener)
      if (latest) listener(latest)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const cancel of cancellations) cancel(disposedResult)
      cancellations.clear()
      listeners.clear()
      close()
    }
  }
}

export class BrowserTimerAdapter implements TimerAdapter {
  private readonly worker: Worker
  private readonly session: TimerAdapterSession
  private readonly pending = new Map<number, (result: TimerRuntimeResult) => void>()
  private requestId = 0
  private unavailable = false

  constructor() {
    this.worker = new Worker(new URL('../workers/timer.worker.ts', import.meta.url), {
      type: 'module'
    })
    const message = (event: MessageEvent<WorkerOutgoingMessage>): void => {
      const data = event.data
      if (data.type === 'snapshot') this.session.acceptSnapshot(data.snapshot)
      else if (data.type === 'result') {
        const resolve = this.pending.get(data.requestId)
        this.pending.delete(data.requestId)
        resolve?.(data.result)
      }
    }
    const failed = (): void => {
      this.unavailable = true
      for (const resolve of this.pending.values()) resolve(unavailableResult)
      this.pending.clear()
      console.error('[timer] Worker unavailable')
    }
    this.session = createTimerSession(
      (request) => {
        if (this.unavailable) return Promise.resolve(unavailableResult)
        const requestId = ++this.requestId
        return new Promise((resolve, reject) => {
          this.pending.set(requestId, resolve)
          try {
            this.worker.postMessage({ ...request, requestId } satisfies WorkerIncomingMessage)
          } catch (error) {
            this.pending.delete(requestId)
            reject(error)
          }
        })
      },
      () => {
        this.worker.removeEventListener('message', message)
        this.worker.removeEventListener('error', failed)
        this.worker.terminate()
        for (const resolve of this.pending.values()) resolve(disposedResult)
        this.pending.clear()
      }
    )
    this.worker.addEventListener('message', message)
    this.worker.addEventListener('error', failed)
  }

  initialize(configuration: TimerRuntimeConfiguration): Promise<TimerRuntimeResult> {
    return this.session.initialize(configuration)
  }
  execute(command: TimerRuntimeCommand): Promise<TimerRuntimeResult> {
    return this.session.execute(command)
  }
  onSnapshot(callback: (snapshot: TimerRuntimeSnapshot) => void): () => void {
    return this.session.onSnapshot(callback)
  }
  dispose(): void {
    this.session.dispose()
  }
}

export class ElectronTimerAdapter implements TimerAdapter {
  private readonly session: TimerAdapterSession

  constructor() {
    const api = window.api?.timer
    this.session = createTimerSession(
      (request) => {
        if (!api?.runtimeInitialize || !api.runtimeCommand)
          return Promise.resolve(unavailableResult)
        return request.type === 'initialize'
          ? api.runtimeInitialize(request.configuration)
          : api.runtimeCommand(request.command)
      },
      () => {
        cleanup?.()
      }
    )
    const cleanup = api?.onTimerTick?.((payload) => {
      if (payload.runtime) this.session.acceptSnapshot(payload.runtime)
    })
  }

  initialize(configuration: TimerRuntimeConfiguration): Promise<TimerRuntimeResult> {
    return this.session.initialize(configuration)
  }
  execute(command: TimerRuntimeCommand): Promise<TimerRuntimeResult> {
    return this.session.execute(command)
  }
  onSnapshot(callback: (snapshot: TimerRuntimeSnapshot) => void): () => void {
    return this.session.onSnapshot(callback)
  }
  dispose(): void {
    this.session.dispose()
  }
}

export function createTimerAdapter(): TimerAdapter {
  return isElectron() ? new ElectronTimerAdapter() : new BrowserTimerAdapter()
}
