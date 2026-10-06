import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@renderer/lib/env', () => ({
  isElectron: vi.fn()
}))

import { isElectron } from '@renderer/lib/env'
import { createProjectionAdapter } from '../projection-adapter'

const mockPostMessage = vi.fn()
const mockAddEventListener = vi.fn()
const mockRemoveEventListener = vi.fn()
const mockClose = vi.fn()

const mockBroadcastChannelInstance = {
  postMessage: mockPostMessage,
  addEventListener: mockAddEventListener,
  removeEventListener: mockRemoveEventListener,
  close: mockClose
}

function MockBroadcastChannelFn(this: unknown): typeof mockBroadcastChannelInstance {
  return mockBroadcastChannelInstance
}
const MockBroadcastChannel = vi.fn(MockBroadcastChannelFn)
vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)

const mockProjectionUnsubscribe = vi.fn()
const mockProjectionApi = {
  send: vi.fn<(generation: number, channel: string, data: unknown) => void>(),
  sendToMain: vi.fn<(generation: number, channel: string, data: unknown) => void>(),
  onProjectionMessage: vi.fn<
    (callback: (generation: number, ch: string, d: unknown) => void) => () => void
  >(() => mockProjectionUnsubscribe)
}

function setupWindowApi(): void {
  Object.defineProperty(window, 'api', {
    value: { projection: mockProjectionApi },
    writable: true,
    configurable: true
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  MockBroadcastChannel.mockImplementation(MockBroadcastChannelFn)
  mockProjectionApi.onProjectionMessage.mockReturnValue(mockProjectionUnsubscribe)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BroadcastChannelAdapter', () => {
  beforeEach(() => {
    vi.mocked(isElectron).mockReturnValue(false)
  })

  it('send() includes the browser session and sender role', () => {
    const adapter = createProjectionAdapter('main', 'session-1')
    adapter.setGeneration(5)
    const payload = { message: 'hello' }
    adapter.send('timer:overtime-message', payload)

    expect(mockPostMessage).toHaveBeenCalledOnce()
    const arg = mockPostMessage.mock.calls[0][0]
    expect(arg.channel).toBe('timer:overtime-message')
    expect(arg.generation).toBe(5)
    expect(arg.data).toEqual(payload)
    expect(arg.sessionId).toBe('session-1')
    expect(arg.senderRole).toBe('main')
    expect(typeof arg.sender).toBe('string')
    expect(arg.sender.length).toBeGreaterThan(0)
  })

  it('starts at generation zero and does not send until assigned', () => {
    const adapter = createProjectionAdapter()

    expect(adapter.getGeneration()).toBe(0)
    adapter.send('timer:overtime-message', { message: 'not-ready' })
    expect(mockPostMessage).not.toHaveBeenCalled()

    adapter.setGeneration(5)
    expect(adapter.getGeneration()).toBe(5)
  })

  it('on() registers a message event listener on bc', () => {
    const adapter = createProjectionAdapter()
    adapter.on('timer:overtime-message', vi.fn())

    expect(mockAddEventListener).toHaveBeenCalledTimes(2)
    expect(mockAddEventListener.mock.calls[0][0]).toBe('messageerror')
    expect(mockAddEventListener.mock.calls[1][0]).toBe('message')
  })

  it('on() — handler is called when message arrives with matching channel and different sender', () => {
    const adapter = createProjectionAdapter('main', 'session-1')
    adapter.setGeneration(5)
    const handler = vi.fn()
    adapter.on('timer:overtime-message', handler)

    const payload = { message: 'hello' }
    const [, listener] = mockAddEventListener.mock.calls[1] as [string, (e: MessageEvent) => void]
    listener({
      data: {
        generation: 5,
        channel: 'timer:overtime-message',
        data: payload,
        sender: 'other-window-id',
        senderRole: 'projection',
        sessionId: 'session-1'
      }
    } as MessageEvent)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(payload)
  })

  it('ignores messages from another browser projection session', () => {
    const adapter = createProjectionAdapter('main', 'session-1')
    adapter.setGeneration(5)
    const handler = vi.fn()
    adapter.on('timer:overtime-message', handler)
    const [, listener] = mockAddEventListener.mock.calls[1] as [
      string,
      (event: MessageEvent) => void
    ]

    listener({
      data: {
        generation: 5,
        channel: 'timer:overtime-message',
        data: { message: 'wrong session' },
        sender: 'other',
        senderRole: 'projection',
        sessionId: 'session-2'
      }
    } as MessageEvent)

    expect(handler).not.toHaveBeenCalled()
  })

  it('ignores messages from the same browser role', () => {
    const adapter = createProjectionAdapter('main', 'session-1')
    adapter.setGeneration(5)
    const handler = vi.fn()
    adapter.on('timer:overtime-message', handler)
    const [, listener] = mockAddEventListener.mock.calls[1] as [
      string,
      (event: MessageEvent) => void
    ]

    listener({
      data: {
        generation: 5,
        channel: 'timer:overtime-message',
        data: { message: 'another control tab' },
        sender: 'other',
        senderRole: 'main',
        sessionId: 'session-1'
      }
    } as MessageEvent)

    expect(handler).not.toHaveBeenCalled()
  })

  it('on() — handler is NOT called when sender === own windowId (self-filter)', () => {
    const adapter = createProjectionAdapter()
    adapter.setGeneration(5)
    const handler = vi.fn()
    adapter.on('timer:overtime-message', handler)

    const payload = { message: 'test' }
    adapter.send('timer:overtime-message', payload)
    const ownSender = mockPostMessage.mock.calls[0][0].sender

    const [, listener] = mockAddEventListener.mock.calls[1] as [string, (e: MessageEvent) => void]
    listener({
      data: {
        generation: 5,
        channel: 'timer:overtime-message',
        data: { message: 'hello' },
        sender: ownSender
      }
    } as MessageEvent)

    expect(handler).not.toHaveBeenCalled()
  })

  it('on() — handler is NOT called when channel does not match', () => {
    const adapter = createProjectionAdapter()
    adapter.setGeneration(5)
    const handler = vi.fn()
    adapter.on('timer:overtime-message', handler)

    const [, listener] = mockAddEventListener.mock.calls[1] as [string, (e: MessageEvent) => void]
    listener({
      data: {
        generation: 5,
        channel: '__system:ping',
        data: null,
        sender: 'other-window-id'
      }
    } as MessageEvent)

    expect(handler).not.toHaveBeenCalled()
  })

  it('on() returns unsubscribe fn; after calling it, subsequent messages do not trigger handler', () => {
    const adapter = createProjectionAdapter()
    const handler = vi.fn()
    const unsubscribe = adapter.on('timer:overtime-message', handler)

    unsubscribe()

    expect(mockRemoveEventListener).toHaveBeenCalledOnce()
    expect(mockRemoveEventListener.mock.calls[0][0]).toBe('message')
  })

  it('dispose() removes listeners and closes the channel', () => {
    const adapter = createProjectionAdapter()
    adapter.on('__system:pong', vi.fn())

    adapter.dispose()

    expect(mockRemoveEventListener).toHaveBeenCalled()
    expect(mockClose).toHaveBeenCalledOnce()
  })

  it('send() with system channel sends null payload correctly', () => {
    const adapter = createProjectionAdapter()
    adapter.setGeneration(5)
    adapter.send('__system:pong', null)

    expect(mockPostMessage).toHaveBeenCalledOnce()
    const arg = mockPostMessage.mock.calls[0][0]
    expect(arg.channel).toBe('__system:pong')
    expect(arg.data).toBeNull()
  })

  it('on() — handler ignores malformed messages without channel/sender', () => {
    const adapter = createProjectionAdapter()
    const handler = vi.fn()
    adapter.on('timer:overtime-message', handler)

    const [, listener] = mockAddEventListener.mock.calls[1] as [string, (e: MessageEvent) => void]

    listener({ data: null } as MessageEvent)
    listener({ data: 'not-an-object' } as MessageEvent)
    listener({ data: { channel: 'timer:overtime-message' } } as MessageEvent)
    listener({ data: { sender: 'x' } } as MessageEvent)

    expect(handler).not.toHaveBeenCalled()
  })

  it('send() is a no-op after dispose()', () => {
    const adapter = createProjectionAdapter()
    adapter.setGeneration(5)
    adapter.dispose()
    mockPostMessage.mockClear()

    adapter.send('timer:overtime-message', { message: 'test' })
    expect(mockPostMessage).not.toHaveBeenCalled()
  })

  it('ignores messages from another generation', () => {
    const adapter = createProjectionAdapter()
    adapter.setGeneration(5)
    const handler = vi.fn()
    adapter.on('timer:overtime-message', handler)
    const [, listener] = mockAddEventListener.mock.calls[1] as [
      string,
      (event: MessageEvent) => void
    ]

    listener({
      data: {
        generation: 4,
        channel: 'timer:overtime-message',
        data: { message: 'stale' },
        sender: 'other'
      }
    } as MessageEvent)

    expect(handler).not.toHaveBeenCalled()
  })

  it('constructor registers a messageerror listener', () => {
    createProjectionAdapter()
    expect(mockAddEventListener).toHaveBeenCalledWith('messageerror', expect.any(Function))
  })
})

describe('ElectronProjectionAdapter', () => {
  beforeEach(() => {
    vi.mocked(isElectron).mockReturnValue(true)
    setupWindowApi()
  })

  it('send() delegates to api.send(generation, channel, data) with default main role', () => {
    const adapter = createProjectionAdapter()
    adapter.setGeneration(5)
    const payload = { message: 'hello' }
    adapter.send('timer:overtime-message', payload)

    expect(mockProjectionApi.send).toHaveBeenCalledOnce()
    expect(mockProjectionApi.send).toHaveBeenCalledWith(5, 'timer:overtime-message', payload)
    expect(mockProjectionApi.sendToMain).not.toHaveBeenCalled()
  })

  it('send() delegates to api.sendToMain(generation, channel, data) with projection role', () => {
    const adapter = createProjectionAdapter('projection')
    adapter.setGeneration(5)
    adapter.send('__system:ready', { generation: 5 })

    expect(mockProjectionApi.sendToMain).toHaveBeenCalledOnce()
    expect(mockProjectionApi.sendToMain).toHaveBeenCalledWith(5, '__system:ready', {
      generation: 5
    })
    expect(mockProjectionApi.send).not.toHaveBeenCalled()
  })

  it('on() registers callback via api.onProjectionMessage', () => {
    const adapter = createProjectionAdapter()
    adapter.on('timer:overtime-message', vi.fn())

    expect(mockProjectionApi.onProjectionMessage).toHaveBeenCalledOnce()
  })

  it('on() — handler fires when api.onProjectionMessage is called with matching channel', () => {
    const adapter = createProjectionAdapter()
    adapter.setGeneration(5)
    const handler = vi.fn()
    adapter.on('timer:overtime-message', handler)

    const registeredCallback = mockProjectionApi.onProjectionMessage.mock
      .calls[0][0] as unknown as (generation: number, ch: string, d: unknown) => void
    registeredCallback(5, 'timer:overtime-message', 'payload-data')

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith('payload-data')
  })

  it('on() — handler does NOT fire when api.onProjectionMessage is called with non-matching channel', () => {
    const adapter = createProjectionAdapter()
    adapter.setGeneration(5)
    const handler = vi.fn()
    adapter.on('timer:overtime-message', handler)

    const registeredCallback = mockProjectionApi.onProjectionMessage.mock
      .calls[0][0] as unknown as (generation: number, ch: string, d: unknown) => void
    registeredCallback(5, '__system:ping', null)

    expect(handler).not.toHaveBeenCalled()
  })

  it('on() returns unsubscribe fn that removes only that channel handler', () => {
    const adapter = createProjectionAdapter()
    adapter.setGeneration(5)
    const handler = vi.fn()
    const unsubscribe = adapter.on('timer:overtime-message', handler)

    unsubscribe()

    const registeredCallback = mockProjectionApi.onProjectionMessage.mock
      .calls[0][0] as unknown as (generation: number, ch: string, d: unknown) => void
    registeredCallback(5, 'timer:overtime-message', 'payload-data')

    expect(handler).not.toHaveBeenCalled()
    expect(mockProjectionUnsubscribe).not.toHaveBeenCalled()
  })

  it('on() shares one underlying projection:message listener', () => {
    const adapter = createProjectionAdapter()
    adapter.on('timer:overtime-message', vi.fn())
    adapter.on('__system:pong', vi.fn())

    expect(mockProjectionApi.onProjectionMessage).toHaveBeenCalledOnce()
  })

  it('dispose() calls the shared projection:message unsubscriber', () => {
    const unsub1 = vi.fn()
    mockProjectionApi.onProjectionMessage.mockReturnValueOnce(unsub1)

    const adapter = createProjectionAdapter()
    adapter.on('timer:overtime-message', vi.fn())
    adapter.on('__system:pong', vi.fn())
    adapter.dispose()

    expect(unsub1).toHaveBeenCalledOnce()
  })

  it('filters incoming Electron messages by generation', () => {
    const adapter = createProjectionAdapter()
    adapter.setGeneration(5)
    const handler = vi.fn()
    adapter.on('timer:overtime-message', handler)
    const registeredCallback = mockProjectionApi.onProjectionMessage.mock
      .calls[0][0] as unknown as (generation: number, ch: string, d: unknown) => void

    registeredCallback(4, 'timer:overtime-message', { message: 'stale' })
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('createProjectionAdapter factory', () => {
  it('returns ElectronProjectionAdapter when isElectron() returns true', () => {
    vi.mocked(isElectron).mockReturnValue(true)
    setupWindowApi()

    const adapter = createProjectionAdapter()
    adapter.setGeneration(5)
    const payload = { message: 'data' }
    adapter.send('timer:overtime-message', payload)
    expect(mockProjectionApi.send).toHaveBeenCalledWith(5, 'timer:overtime-message', payload)
    expect(mockPostMessage).not.toHaveBeenCalled()
  })

  it('returns BroadcastChannelAdapter when isElectron() returns false', () => {
    vi.mocked(isElectron).mockReturnValue(false)

    const adapter = createProjectionAdapter()
    adapter.setGeneration(5)
    const payload = { message: 'data' }
    adapter.send('timer:overtime-message', payload)
    expect(mockPostMessage).toHaveBeenCalledOnce()
    expect(mockProjectionApi.send).not.toHaveBeenCalled()
  })
})

it('rejects malformed and wrong-direction camera signaling in browser transport', () => {
  vi.mocked(isElectron).mockReturnValue(false)
  const adapter = createProjectionAdapter('main', 'browser-session')
  adapter.setGeneration(1)
  const receive = vi.fn()
  adapter.on('camera:signal', receive)
  const listener = mockAddEventListener.mock.calls.find(([name]) => name === 'message')![1]
  const send = (data: unknown): void =>
    listener({
      data: {
        generation: 1,
        sessionId: 'browser-session',
        senderRole: 'projection',
        sender: 'other',
        channel: 'camera:signal',
        data
      }
    })
  send({ sessionId: 'camera', kind: 'answer', sdp: 'valid' })
  expect(receive).toHaveBeenCalledOnce()
  send({ sessionId: 'camera', kind: 'offer', sdp: 'wrong direction' })
  send({ sessionId: 'camera', kind: 'answer', sdp: 'x'.repeat(65537) })
  expect(receive).toHaveBeenCalledOnce()
  adapter.dispose()
})

describe('late error browser direction and session binding', () => {
  it('accepts only valid reports from the matching projection session and generation', () => {
    vi.mocked(isElectron).mockReturnValue(false)
    const adapter = createProjectionAdapter('main', 'session-1')
    adapter.setGeneration(5)
    const handler = vi.fn()
    adapter.on('file:playback-error', handler)
    const report = {
      itemId: 'video',
      blobId: 'blob',
      contentRevision: 1,
      errorCode: 3 as const,
      currentTime: 0,
      duration: 0,
      transport: 'pause' as const,
      volume: 1
    }
    const [, listener] = mockAddEventListener.mock.calls[1] as [string, (e: MessageEvent) => void]
    const message = {
      generation: 5,
      sessionId: 'session-1',
      senderRole: 'projection',
      sender: 'projection-window',
      channel: 'file:playback-error',
      data: report
    }
    for (const invalid of [
      { senderRole: 'main' },
      { sessionId: 'other' },
      { generation: 4 },
      { data: { ...report, contentRevision: 0 } }
    ])
      listener({ data: { ...message, ...invalid } } as MessageEvent)
    expect(handler).not.toHaveBeenCalled()
    listener({ data: message } as MessageEvent)
    expect(handler).toHaveBeenCalledWith(report)
    adapter.send('file:playback-error', report)
    expect(mockPostMessage).not.toHaveBeenCalled()
    adapter.dispose()
  })
})

describe('document render reports browser direction and session binding', () => {
  it('accepts only valid reports from the matching projection session and generation', () => {
    vi.mocked(isElectron).mockReturnValue(false)
    const adapter = createProjectionAdapter('main', 'session-1')
    adapter.setGeneration(5)
    const handler = vi.fn()
    adapter.on('file:render-status', handler)
    const report = { itemId: 'pdf', blobId: 'blob', contentRevision: 1, status: 'failed' as const }
    const [, listener] = mockAddEventListener.mock.calls[1] as [string, (e: MessageEvent) => void]
    const message = {
      generation: 5,
      sessionId: 'session-1',
      senderRole: 'projection',
      sender: 'projection-window',
      channel: 'file:render-status',
      data: report
    }
    for (const invalid of [
      { senderRole: 'main' },
      { sessionId: 'other' },
      { generation: 4 },
      { data: { ...report, contentRevision: 0 } }
    ])
      listener({ data: { ...message, ...invalid } } as MessageEvent)
    expect(handler).not.toHaveBeenCalled()
    listener({ data: message } as MessageEvent)
    expect(handler).toHaveBeenCalledWith(report)
    adapter.send('file:render-status', report)
    expect(mockPostMessage).not.toHaveBeenCalled()
    adapter.dispose()
  })
})
