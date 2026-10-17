import { TimerRuntime } from '@shared/timer-runtime'
import type { TimerRuntimeSnapshot } from '@shared/types/timer'
import { applyTimerRuntimeSnapshot, getTimerRuntimeConfiguration } from '@renderer/stores/timer'
import { bindTimerRuntimeClient } from '@renderer/lib/timer-runtime-client'

export function installTimerRuntimeHarness(): {
  runtime: TimerRuntime
  tickAt: (nowMs: number) => TimerRuntimeSnapshot
  advance: (elapsedMs: number) => TimerRuntimeSnapshot
  publish: () => TimerRuntimeSnapshot
  dispose: () => void
} {
  let now = Date.now()
  const runtime = new TimerRuntime(() => now)
  const publish = (): TimerRuntimeSnapshot => {
    const snapshot = runtime.getSnapshot()
    applyTimerRuntimeSnapshot(snapshot)
    return snapshot
  }
  const initialized = runtime.initialize(getTimerRuntimeConfiguration())
  if (initialized.status === 'rejected') throw new Error(initialized.reason)
  publish()
  const dispose = bindTimerRuntimeClient((command) => {
    const result = runtime.execute(command)
    if (result.status === 'accepted') applyTimerRuntimeSnapshot(result.snapshot)
    return Promise.resolve(result)
  })
  const tickAt = (nowMs: number): TimerRuntimeSnapshot => {
    now = nowMs
    runtime.tick()
    return publish()
  }
  return { runtime, tickAt, advance: (elapsedMs) => tickAt(now + elapsedMs), publish, dispose }
}
