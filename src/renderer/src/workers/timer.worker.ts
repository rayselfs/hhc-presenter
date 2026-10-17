import { createTimerWorkerHost } from './timer-worker-host'
export type { WorkerIncomingMessage, WorkerOutgoingMessage } from './timer-worker-host'

const host = createTimerWorkerHost((message) => self.postMessage(message))
self.onmessage = (event: MessageEvent<unknown>) => host.handleMessage(event.data)
