import type { TimerRuntimeCommand, TimerRuntimeResult } from '@shared/types/timer'

type TimerCommandClient = (command: TimerRuntimeCommand) => Promise<TimerRuntimeResult>
let current: TimerCommandClient | null = null

export function bindTimerRuntimeClient(client: TimerCommandClient): () => void {
  current = client
  return () => {
    if (current === client) current = null
  }
}

export async function executeTimerRuntimeCommand(
  command: TimerRuntimeCommand
): Promise<TimerRuntimeResult> {
  if (!current) return { status: 'rejected', reason: 'host-unavailable' }
  const result = await current(command)
  if (result.status === 'rejected') console.warn('[timer] Command rejected', result.reason)
  return result
}
