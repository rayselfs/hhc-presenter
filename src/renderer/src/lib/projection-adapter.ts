import { isFilePlaybackError } from '@shared/projection-messages'
import { isCameraMessageFrom } from '@shared/camera'
import { isElectron } from '@renderer/lib/env'
import type { ProjectionChannel, ProjectionPayload } from '@shared/projection-messages'

type AdapterRole = 'main' | 'projection'

interface ProjectionAdapter {
  setGeneration(generation: number): void
  getGeneration(): number
  send<C extends ProjectionChannel>(channel: C, data: ProjectionPayload<C>): void
  on<C extends ProjectionChannel>(
    channel: C,
    handler: (data: ProjectionPayload<C>) => void
  ): () => void
  dispose(): void
}

class ElectronProjectionAdapter implements ProjectionAdapter {
  private api: Window['api']['projection']
  private handlers = new Map<
    ProjectionChannel,
    Set<(data: ProjectionPayload<ProjectionChannel>) => void>
  >()
  private role: AdapterRole
  private generation = 0
  private unsubscribeProjectionMessage: (() => void) | null = null

  constructor(api: Window['api']['projection'], role: AdapterRole) {
    this.api = api
    this.role = role
  }

  private ensureSubscribed(): void {
    if (this.unsubscribeProjectionMessage) return
    this.unsubscribeProjectionMessage = this.api.onProjectionMessage(
      (generation, channel, data) => {
        if (generation !== this.generation) return
        if (
          channel === 'file:playback-error' &&
          (this.role !== 'main' || !isFilePlaybackError(data))
        )
          return
        if (!isCameraMessageFrom(channel, data, this.role === 'main' ? 'projection' : 'main'))
          return
        this.handlers.get(channel)?.forEach((handler) => handler(data))
      }
    )
  }

  setGeneration(generation: number): void {
    if (Number.isSafeInteger(generation) && generation >= 0) this.generation = generation
  }

  getGeneration(): number {
    return this.generation
  }

  send<C extends ProjectionChannel>(channel: C, data: ProjectionPayload<C>): void {
    if (this.generation <= 0) return
    if (
      channel === 'file:playback-error' &&
      (this.role !== 'projection' || !isFilePlaybackError(data))
    )
      return
    if (!isCameraMessageFrom(channel, data, this.role)) return
    if (this.role === 'projection') {
      this.api.sendToMain(this.generation, channel, data)
    } else {
      this.api.send(this.generation, channel, data)
    }
  }

  on<C extends ProjectionChannel>(
    channel: C,
    handler: (data: ProjectionPayload<C>) => void
  ): () => void {
    this.ensureSubscribed()
    const handlers = this.handlers.get(channel) ?? new Set()
    const wrappedHandler = handler as (data: ProjectionPayload<ProjectionChannel>) => void
    handlers.add(wrappedHandler)
    this.handlers.set(channel, handlers)
    return () => {
      handlers.delete(wrappedHandler)
      if (handlers.size === 0) this.handlers.delete(channel)
    }
  }

  dispose(): void {
    this.unsubscribeProjectionMessage?.()
    this.unsubscribeProjectionMessage = null
    this.handlers.clear()
  }
}

class BroadcastChannelAdapter implements ProjectionAdapter {
  private bc: BroadcastChannel
  private windowId: string
  private role: AdapterRole
  private sessionId: string
  private listeners: Array<{ listener: (event: MessageEvent) => void }> = []
  private disposed = false
  private generation = 0

  constructor(role: AdapterRole, sessionId?: string) {
    this.bc = new BroadcastChannel('hhc-projection')
    this.windowId = crypto.randomUUID()
    this.role = role
    this.sessionId = sessionId || (role === 'main' ? crypto.randomUUID() : '')

    this.bc.addEventListener('messageerror', () => {
      console.warn('[projection-adapter] Failed to deserialize BroadcastChannel message')
    })
  }

  setGeneration(generation: number): void {
    if (Number.isSafeInteger(generation) && generation >= 0) this.generation = generation
  }

  getGeneration(): number {
    return this.generation
  }

  send<C extends ProjectionChannel>(channel: C, data: ProjectionPayload<C>): void {
    if (this.disposed || this.generation <= 0 || !this.sessionId) return
    if (
      channel === 'file:playback-error' &&
      (this.role !== 'projection' || !isFilePlaybackError(data))
    )
      return
    if (!isCameraMessageFrom(channel, data, this.role)) return
    this.bc.postMessage({
      generation: this.generation,
      sessionId: this.sessionId,
      senderRole: this.role,
      channel,
      data,
      sender: this.windowId
    })
  }

  on<C extends ProjectionChannel>(
    channel: C,
    handler: (data: ProjectionPayload<C>) => void
  ): () => void {
    const listener = (event: MessageEvent): void => {
      const msg = event.data
      if (
        !msg ||
        typeof msg !== 'object' ||
        !('generation' in msg) ||
        !('sessionId' in msg) ||
        !('senderRole' in msg) ||
        !('channel' in msg) ||
        !('sender' in msg)
      ) {
        return
      }
      if (msg.generation !== this.generation) return
      if (msg.sessionId !== this.sessionId) return
      if (msg.senderRole !== (this.role === 'main' ? 'projection' : 'main')) return
      if (msg.sender === this.windowId) return
      if (
        msg.channel === 'file:playback-error' &&
        (this.role !== 'main' || !isFilePlaybackError(msg.data))
      )
        return
      if (!isCameraMessageFrom(msg.channel, msg.data, msg.senderRole)) return
      if (msg.channel === channel) handler(msg.data as ProjectionPayload<C>)
    }
    this.bc.addEventListener('message', listener)
    this.listeners.push({ listener })
    return () => {
      this.bc.removeEventListener('message', listener)
      this.listeners = this.listeners.filter((l) => l.listener !== listener)
    }
  }

  dispose(): void {
    this.disposed = true
    this.listeners.forEach(({ listener }) => this.bc.removeEventListener('message', listener))
    this.listeners = []
    this.generation = 0
    this.bc.close()
  }
}

function createProjectionAdapter(
  role: AdapterRole = 'main',
  browserSessionId?: string
): ProjectionAdapter {
  if (isElectron()) return new ElectronProjectionAdapter(window.api.projection, role)
  return new BroadcastChannelAdapter(role, browserSessionId)
}

export type { ProjectionAdapter }
export { createProjectionAdapter }
