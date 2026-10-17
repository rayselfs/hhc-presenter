import { TimerRuntime } from '@shared/timer-runtime'
import type {
  TimerRuntimeCommand,
  TimerRuntimeConfiguration,
  TimerRuntimeResult,
  TimerRuntimeSnapshot
} from '@shared/types/timer'

export type WorkerIncomingMessage =
  | { type: 'initialize'; requestId: number; configuration: TimerRuntimeConfiguration }
  | { type: 'command'; requestId: number; command: TimerRuntimeCommand }

export type WorkerOutgoingMessage =
  | { type: 'result'; requestId: number; result: TimerRuntimeResult }
  | { type: 'snapshot'; snapshot: TimerRuntimeSnapshot }

export function createTimerWorkerHost(
  send: (message: WorkerOutgoingMessage) => void,
  nowMs: () => number = () => performance.now()
): { handleMessage: (value: unknown) => void; dispose: () => void } {
  const runtime = new TimerRuntime(nowMs)
  let interval: ReturnType<typeof setInterval> | null = null
  let disposed = false

  function syncInterval(): void {
    if (disposed) return
    const snapshot = runtime.getSnapshot()
    const active = snapshot.timer.status === 'running' || snapshot.stopwatch.status === 'running'
    if (!active && interval !== null) {
      clearInterval(interval)
      interval = null
    } else if (active && interval === null) {
      interval = setInterval(() => {
        send({ type: 'snapshot', snapshot: runtime.tick() })
        syncInterval()
      }, 100)
    }
  }

  const handleMessage = (value: unknown): void => {
    if (disposed) return
    if (typeof value !== 'object' || value === null) return
    const message = value as Record<string, unknown>
    if (!Number.isSafeInteger(message.requestId) || Number(message.requestId) < 1) return
    const result =
      message.type === 'initialize'
        ? runtime.initialize(message.configuration)
        : message.type === 'command'
          ? runtime.execute(message.command)
          : { status: 'rejected' as const, reason: 'invalid-command' as const }
    syncInterval()
    send({ type: 'result', requestId: Number(message.requestId), result })
  }
  return {
    handleMessage,
    dispose: () => {
      disposed = true
      if (interval !== null) clearInterval(interval)
      interval = null
    }
  }
}
