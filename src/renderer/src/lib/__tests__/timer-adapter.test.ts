import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimerRuntime } from '@shared/timer-runtime'
import type {
  TimerRuntimeCommand,
  TimerRuntimeConfiguration,
  TimerRuntimeResult,
  TimerRuntimeSnapshot,
  TimerTickPayload
} from '@shared/types/timer'
import type { WorkerIncomingMessage, WorkerOutgoingMessage } from '@renderer/workers/timer.worker'
import { DEFAULT_SETTINGS } from '@renderer/stores/timer'

vi.mock('../env', () => ({ isElectron: vi.fn() }))
import { isElectron } from '../env'
import {
  BrowserTimerAdapter,
  ElectronTimerAdapter,
  createTimerAdapter,
  type TimerAdapter
} from '../timer-adapter'

const configuration: TimerRuntimeConfiguration = {
  settings: { ...DEFAULT_SETTINGS },
  reminderMode: 'subtract'
}
class TransportWorker extends EventTarget {
  static instance: TransportWorker
  postMessage = vi.fn<(message: WorkerIncomingMessage) => void>()
  terminate = vi.fn()
  constructor() {
    super()
    TransportWorker.instance = this
  }
  receive(message: WorkerOutgoingMessage): void {
    this.dispatchEvent(new MessageEvent('message', { data: message }))
  }
}
let adapter: TimerAdapter
let runtime: TimerRuntime
beforeEach(() => {
  runtime = new TimerRuntime(() => 0)
  runtime.initialize(configuration)
  vi.stubGlobal('Worker', TransportWorker)
})
afterEach(() => {
  adapter?.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

for (const mode of ['browser', 'electron'] as const) {
  describe(`${mode} TimerAdapter`, () => {
    let requests: Array<{
      message:
        | { type: 'initialize'; configuration: TimerRuntimeConfiguration }
        | {
            type: 'command'
            command: TimerRuntimeCommand
          }
      resolve: (result: TimerRuntimeResult) => void
      reject: (error: Error) => void
    }>
    let publish: (snapshot: TimerRuntimeSnapshot) => void
    let cleanup: ReturnType<typeof vi.fn>
    beforeEach(() => {
      requests = []
      cleanup = vi.fn()
      vi.mocked(isElectron).mockReturnValue(mode === 'electron')
      if (mode === 'browser') {
        adapter = createTimerAdapter()
        TransportWorker.instance.postMessage.mockImplementation((message) => {
          requests.push({
            message,
            resolve: (result) =>
              TransportWorker.instance.receive({
                type: 'result',
                requestId: message.requestId,
                result
              }),
            reject: () => TransportWorker.instance.dispatchEvent(new Event('error'))
          })
        })
        publish = (snapshot) => TransportWorker.instance.receive({ type: 'snapshot', snapshot })
      } else {
        let listener: ((payload: TimerTickPayload) => void) | undefined
        const request = (
          message: (typeof requests)[number]['message']
        ): Promise<TimerRuntimeResult> =>
          new Promise((resolve, reject) => {
            requests.push({ message, resolve, reject })
          })
        vi.stubGlobal('api', {
          timer: {
            runtimeInitialize: (config: TimerRuntimeConfiguration) =>
              request({ type: 'initialize', configuration: config }),
            runtimeCommand: (command: TimerRuntimeCommand) => request({ type: 'command', command }),
            onTimerTick: (callback: (payload: TimerTickPayload) => void) => {
              listener = callback
              return cleanup
            }
          }
        })
        adapter = createTimerAdapter()
        publish = (snapshot) =>
          listener?.({
            runtime: snapshot,
            mode: 'timer',
            remainingSeconds: snapshot.timer.remainingSeconds,
            phase: snapshot.timer.phase,
            mainDisplay: '',
            subDisplay: null,
            progress: 1,
            overtimeSeconds: 0,
            overtimeMessage: null,
            reminderColor: null
          })
      }
    })
    const accepted = (): TimerRuntimeResult => ({ status: 'accepted', snapshot: runtime.tick() })

    it('chooses the platform adapter', () => {
      expect(adapter).toBeInstanceOf(
        mode === 'browser' ? BrowserTimerAdapter : ElectronTimerAdapter
      )
    })
    it('serializes initialization before commands and keeps seconds unchanged', async () => {
      const initialized = adapter.initialize(configuration)
      const changed = adapter.execute({ type: 'addTime', seconds: 30 })
      await Promise.resolve()
      expect(requests).toHaveLength(1)
      expect(requests[0].message).toMatchObject({ type: 'initialize', configuration })
      requests[0].resolve(accepted())
      await initialized
      await Promise.resolve()
      expect(requests).toHaveLength(2)
      expect(requests[1].message).toMatchObject({
        type: 'command',
        command: { type: 'addTime', seconds: 30 }
      })
      requests[1].resolve(accepted())
      await changed
    })
    it.each<TimerRuntimeCommand>([
      { type: 'setMode', mode: 'stopwatch' },
      { type: 'removeTime', seconds: 10 },
      { type: 'startStopwatch' },
      { type: 'pauseStopwatch' },
      { type: 'resumeStopwatch' }
    ])('relays the explicit command $type without status-derived commands', async (command) => {
      const pending = adapter.execute(command)
      await Promise.resolve()
      expect(requests[0].message).toMatchObject({ type: 'command', command })
      requests[0].resolve(accepted())
      await pending
      expect(requests).toHaveLength(1)
    })
    it('publishes accepted state before resolving the command', async () => {
      const listener = vi.fn()
      adapter.onSnapshot(listener)
      const pending = adapter.execute({ type: 'start' })
      await Promise.resolve()
      const result = accepted()
      requests[0].resolve(result)
      await pending
      expect(listener).toHaveBeenCalledWith(result.status === 'accepted' ? result.snapshot : null)
    })
    it('does not overwrite a newer pushed frame with a late initial response', async () => {
      const listener = vi.fn()
      adapter.onSnapshot(listener)
      const old = accepted()
      const pending = adapter.initialize(configuration)
      await Promise.resolve()
      const current = runtime.tick()
      publish(current)
      requests[0].resolve(old)
      await pending
      expect(listener).toHaveBeenCalledExactlyOnceWith(current)
    })
    it('ignores repeated and older frames and replays only the latest to new listeners', () => {
      const old = runtime.tick()
      const current = runtime.tick()
      const listener = vi.fn()
      adapter.onSnapshot(listener)
      publish(current)
      publish(old)
      publish(current)
      expect(listener).toHaveBeenCalledExactlyOnceWith(current)
      const late = vi.fn()
      adapter.onSnapshot(late)
      expect(late).toHaveBeenCalledExactlyOnceWith(current)
    })
    it('unsubscribes only the selected listener', () => {
      const first = vi.fn()
      const second = vi.fn()
      const unsubscribe = adapter.onSnapshot(first)
      adapter.onSnapshot(second)
      unsubscribe()
      const frame = runtime.tick()
      publish(frame)
      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledWith(frame)
    })
    it('keeps rejected commands from publishing or fabricating state', async () => {
      const listener = vi.fn()
      adapter.onSnapshot(listener)
      const pending = adapter.execute({ type: 'start' })
      await Promise.resolve()
      const rejected = { status: 'rejected', reason: 'not-initialized' } as const
      requests[0].resolve(rejected)
      await expect(pending).resolves.toEqual(rejected)
      expect(listener).not.toHaveBeenCalled()
    })
    it('settles in-flight and queued commands on disposal and ignores late frames', async () => {
      const listener = vi.fn()
      adapter.onSnapshot(listener)
      const inFlight = adapter.execute({ type: 'start' })
      const queued = adapter.execute({ type: 'pause' })
      await Promise.resolve()
      adapter.dispose()
      adapter.dispose()
      await expect(inFlight).resolves.toEqual({ status: 'rejected', reason: 'disposed' })
      await expect(queued).resolves.toEqual({ status: 'rejected', reason: 'disposed' })
      requests[0].resolve(accepted())
      publish(runtime.tick())
      expect(requests).toHaveLength(1)
      expect(listener).not.toHaveBeenCalled()
      expect(
        mode === 'browser' ? TransportWorker.instance.terminate : cleanup
      ).toHaveBeenCalledOnce()
    })
    it('does not send requests or register callbacks after disposal', async () => {
      adapter.dispose()
      await expect(adapter.execute({ type: 'start' })).resolves.toEqual({
        status: 'rejected',
        reason: 'disposed'
      })
      const listener = vi.fn()
      adapter.onSnapshot(listener)
      publish(runtime.tick())
      expect(requests).toHaveLength(0)
      expect(listener).not.toHaveBeenCalled()
    })
    it('reports transport failures without a renderer fallback', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const listener = vi.fn()
      adapter.onSnapshot(listener)
      const pending = adapter.execute({ type: 'start' })
      await Promise.resolve()
      requests[0].reject(new Error('transport failed'))
      await expect(pending).resolves.toEqual({ status: 'rejected', reason: 'host-unavailable' })
      expect(listener).not.toHaveBeenCalled()
      if (mode === 'browser') {
        await expect(adapter.execute({ type: 'pause' })).resolves.toEqual({
          status: 'rejected',
          reason: 'host-unavailable'
        })
        expect(requests).toHaveLength(1)
      }
    })
  })
}
it('rejects an incomplete Electron API rather than using legacy void commands', async () => {
  const legacy = vi.fn()
  vi.stubGlobal('api', { timer: { timerCommand: legacy } })
  adapter = new ElectronTimerAdapter()
  await expect(adapter.initialize(configuration)).resolves.toEqual({
    status: 'rejected',
    reason: 'host-unavailable'
  })
  expect(legacy).not.toHaveBeenCalled()
})
