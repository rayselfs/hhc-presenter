import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockMainWindow = { id: 1 }
const mockProjectionWindow = { id: 2 }
const mockUnknownWindow = { id: 3 }

const mockWindowManager = {
  getMainWindow: vi.fn(() => mockMainWindow),
  getProjectionWindow: vi.fn(() => mockProjectionWindow),
  getProjectionState: vi.fn(() => ({
    exists: false,
    lifecycle: { generation: 0, status: 'closed', reason: 'user-close' }
  })),
  createProjectionWindow: vi.fn(() => 4),
  moveProjectionWindow: vi.fn(() => ({ moved: true, generation: 5 })),
  retryProjectionWindow: vi.fn(() => ({ retried: true, generation: 5 })),
  markProjectionReady: vi.fn(() => true),
  isCurrentProjectionSender: vi.fn(() => true),
  closeProjection: vi.fn(),
  sendToProjection: vi.fn(),
  sendToMain: vi.fn(),
  getPrimaryDisplayId: vi.fn(() => 1),
  getDisplays: vi.fn(() => [
    {
      id: 1,
      label: 'Built-in',
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      scaleFactor: 1
    }
  ])
}

vi.mock('electron', () => {
  const handleHandlers = new Map<string, (...args: unknown[]) => unknown>()
  const onHandlers = new Map<string, (...args: unknown[]) => void>()
  return {
    BrowserWindow: {
      fromWebContents: vi.fn()
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handleHandlers.set(channel, handler)
      }),
      on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
        onHandlers.set(channel, handler)
      }),
      _getHandler: (channel: string) => handleHandlers.get(channel),
      _getOnHandler: (channel: string) => onHandlers.get(channel),
      _clearHandlers: () => {
        handleHandlers.clear()
        onHandlers.clear()
      }
    }
  }
})

import { BrowserWindow, ipcMain } from 'electron'
import type { WindowManager } from '../../windowManager'

const wm = mockWindowManager as unknown as WindowManager

function makeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} } as Electron.IpcMainInvokeEvent
}

type ExtendedIpcMain = typeof ipcMain & {
  _getHandler: (c: string) => (...args: unknown[]) => unknown
  _getOnHandler: (c: string) => (...args: unknown[]) => void
  _clearHandlers: () => void
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  return (ipcMain as ExtendedIpcMain)._getHandler(channel)
}

function getOnHandler(channel: string): (...args: unknown[]) => void {
  return (ipcMain as ExtendedIpcMain)._getOnHandler(channel)
}

beforeEach(async () => {
  vi.clearAllMocks()
  ;(ipcMain as ExtendedIpcMain)._clearHandlers()
  mockWindowManager.getProjectionState.mockReturnValue({
    exists: false,
    lifecycle: { generation: 0, status: 'closed', reason: 'user-close' }
  })
  mockWindowManager.createProjectionWindow.mockReturnValue(4)
  mockWindowManager.moveProjectionWindow.mockReturnValue({ moved: true, generation: 5 })
  mockWindowManager.retryProjectionWindow.mockReturnValue({ retried: true, generation: 5 })
  mockWindowManager.markProjectionReady.mockReturnValue(true)
  mockWindowManager.isCurrentProjectionSender.mockReturnValue(true)

  const { registerProjectionHandlers } = await import('../../ipc/projection')
  registerProjectionHandlers(wm)
})

describe('projection:check', () => {
  it('known window returns current projection lifecycle state', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    mockWindowManager.getProjectionState.mockReturnValue({
      exists: true,
      lifecycle: { generation: 4, status: 'ready', reason: 'created' }
    })
    const result = getHandler('projection:check')(makeEvent())
    expect(result).toEqual({
      exists: true,
      lifecycle: { generation: 4, status: 'ready', reason: 'created' }
    })
  })

  it('unknown window returns a closed zero-generation state', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockUnknownWindow as never)
    const result = getHandler('projection:check')(makeEvent())
    expect(result).toEqual({
      exists: false,
      lifecycle: { generation: 0, status: 'closed', reason: 'user-close' }
    })
  })
})

describe('projection:ensure', () => {
  it('main window creates projection and returns its generation', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    const result = getHandler('projection:ensure')(makeEvent())
    expect(result).toEqual({ created: true, generation: 4 })
    expect(mockWindowManager.createProjectionWindow).toHaveBeenCalledOnce()
  })

  it('passes selected display id when creating projection', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    const result = getHandler('projection:ensure')(makeEvent(), '2')
    expect(result).toEqual({ created: true, generation: 4 })
    expect(mockWindowManager.createProjectionWindow).toHaveBeenCalledWith('2')
  })

  it('main window returns the existing generation if already open', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    mockWindowManager.getProjectionState.mockReturnValue({
      exists: true,
      lifecycle: { generation: 3, status: 'opening', reason: 'reload' }
    })
    const result = getHandler('projection:ensure')(makeEvent())
    expect(result).toEqual({ created: false, generation: 3 })
    expect(mockWindowManager.createProjectionWindow).not.toHaveBeenCalled()
  })

  it('non-main window returns a zero generation', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)
    const result = getHandler('projection:ensure')(makeEvent())
    expect(result).toEqual({ created: false, generation: 0 })
  })
})

describe('projection:move-to-display', () => {
  it('main window moves an open projection to the selected display', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    const result = getHandler('projection:move-to-display')(makeEvent(), '2')
    expect(result).toEqual({ moved: true, generation: 5 })
    expect(mockWindowManager.moveProjectionWindow).toHaveBeenCalledWith('2')
  })

  it('non-main window returns { moved: false }', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)
    const result = getHandler('projection:move-to-display')(makeEvent(), '2')
    expect(result).toEqual({ moved: false, generation: 0 })
    expect(mockWindowManager.moveProjectionWindow).not.toHaveBeenCalled()
  })
})

describe('projection:bring-to-front', () => {
  it('does not register a projection foreground handler', () => {
    expect((ipcMain as ExtendedIpcMain)._getHandler('projection:bring-to-front')).toBeUndefined()
  })
})

describe('projection:close', () => {
  it('main window closes projection and returns { closed: true }', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    const result = getHandler('projection:close')(makeEvent())
    expect(result).toEqual({ closed: true })
    expect(mockWindowManager.closeProjection).toHaveBeenCalledOnce()
  })

  it('non-main window returns { closed: false }', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)
    const result = getHandler('projection:close')(makeEvent())
    expect(result).toEqual({ closed: false })
    expect(mockWindowManager.closeProjection).not.toHaveBeenCalled()
  })
})

describe('projection:send', () => {
  it('forwards a matching-generation control message', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    mockWindowManager.getProjectionState.mockReturnValue({
      exists: true,
      lifecycle: { generation: 4, status: 'ready', reason: 'created' }
    })
    const handler = getOnHandler('projection:send')
    const payload = { message: 'safe' }
    handler(makeEvent(), 4, 'timer:overtime-message', payload)
    expect(mockWindowManager.sendToProjection).toHaveBeenCalledWith(
      'projection:message',
      4,
      'timer:overtime-message',
      payload
    )
  })

  it('rejects a stale generation', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    mockWindowManager.getProjectionState.mockReturnValue({
      exists: true,
      lifecycle: { generation: 4, status: 'ready', reason: 'created' }
    })
    getOnHandler('projection:send')(makeEvent(), 3, 'timer:overtime-message', { message: 'stale' })
    expect(mockWindowManager.sendToProjection).not.toHaveBeenCalled()
  })

  it('non-main window does NOT forward', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)
    const handler = getOnHandler('projection:send')
    handler(makeEvent(), 4, 'timer:overtime-message', { message: 'test' })
    expect(mockWindowManager.sendToProjection).not.toHaveBeenCalled()
  })

  it('malformed payload does NOT forward', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    const handler = getOnHandler('projection:send')
    handler(makeEvent(), 4, 'file:control', { action: 'seek', value: 'invalid' })
    expect(mockWindowManager.sendToProjection).not.toHaveBeenCalled()
  })
})

describe('projection:send-to-main', () => {
  it('marks ready and forwards it from the current projection sender', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)
    const handler = getOnHandler('projection:send-to-main')
    handler(makeEvent(), 4, '__system:ready', { generation: 4 })
    expect(mockWindowManager.markProjectionReady).toHaveBeenCalledWith(4)
    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith(
      'projection:message',
      4,
      '__system:ready',
      { generation: 4 }
    )
  })

  it('rejects ready from a stale or non-projection sender', () => {
    mockWindowManager.isCurrentProjectionSender.mockReturnValue(false)
    getOnHandler('projection:send-to-main')(makeEvent(), 3, '__system:ready', { generation: 3 })
    expect(mockWindowManager.markProjectionReady).not.toHaveBeenCalled()
    expect(mockWindowManager.sendToMain).not.toHaveBeenCalled()
  })

  it('forwards projection playback state to main window', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)
    const handler = getOnHandler('projection:send-to-main')
    const payload = {
      itemId: 'video-id',
      phase: 'playing',
      currentTime: 12,
      duration: 100,
      isPlaying: true,
      isEnded: false
    }

    handler(makeEvent(), 4, 'file:playback-state', payload)

    expect(mockWindowManager.sendToMain).toHaveBeenCalledWith(
      'projection:message',
      4,
      'file:playback-state',
      payload
    )
  })

  it('unknown window does NOT forward', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockUnknownWindow as never)
    const handler = getOnHandler('projection:send-to-main')
    mockWindowManager.isCurrentProjectionSender.mockReturnValue(false)
    handler(makeEvent(), 4, '__system:ready', { generation: 4 })
    expect(mockWindowManager.sendToMain).not.toHaveBeenCalled()
  })
})

describe('projection recovery lifecycle invokes', () => {
  it('allows main window to retry and returns the replacement generation', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    expect(getHandler('projection:retry')(makeEvent())).toEqual({
      retried: true,
      generation: 5
    })
  })

  it('returns generation only to the current projection window', () => {
    mockWindowManager.getProjectionState.mockReturnValue({
      exists: true,
      lifecycle: { generation: 4, status: 'ready', reason: 'created' }
    })
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)
    expect(getHandler('projection:get-generation')(makeEvent())).toEqual({ generation: 4 })

    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockUnknownWindow as never)
    expect(getHandler('projection:get-generation')(makeEvent())).toEqual({ generation: 0 })
  })
})

describe('projection:get-displays', () => {
  it('main window returns display metadata', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    const result = getHandler('projection:get-displays')(makeEvent())
    expect(result).toEqual([
      {
        id: 1,
        label: 'Built-in',
        isPrimary: true,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        scaleFactor: 1
      }
    ])
  })

  it('non-main window returns empty array', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)
    const result = getHandler('projection:get-displays')(makeEvent())
    expect(result).toEqual([])
  })
})

it('relays camera offers only from main and answers only from current projection', () => {
  mockWindowManager.getProjectionState.mockReturnValue({
    exists: true,
    lifecycle: { generation: 4, status: 'ready', reason: 'created' }
  })
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
  const offer = { sessionId: 'camera-1', kind: 'offer', sdp: 'offer' }
  const answer = { sessionId: 'camera-1', kind: 'answer', sdp: 'answer' }
  getOnHandler('projection:send')(makeEvent(), 4, 'camera:signal', offer)
  expect(mockWindowManager.sendToProjection).toHaveBeenCalledOnce()
  getOnHandler('projection:send')(makeEvent(), 4, 'camera:signal', answer)
  expect(mockWindowManager.sendToProjection).toHaveBeenCalledOnce()
  getOnHandler('projection:send-to-main')(makeEvent(), 4, 'camera:signal', answer)
  expect(mockWindowManager.sendToMain).toHaveBeenCalledOnce()
  getOnHandler('projection:send-to-main')(makeEvent(), 4, 'camera:signal', offer)
  expect(mockWindowManager.sendToMain).toHaveBeenCalledOnce()
})

it('rejects playback errors sent by the operator window', () => {
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
  mockWindowManager.getProjectionState.mockReturnValue({
    exists: true,
    lifecycle: { generation: 4, status: 'ready', reason: 'created' }
  } as never)
  getOnHandler('projection:send')(makeEvent(), 4, 'file:playback-error', {
    itemId: 'video',
    blobId: 'blob',
    contentRevision: 1,
    errorCode: 3,
    currentTime: 0,
    duration: 0,
    transport: 'pause',
    volume: 1
  })
  expect(mockWindowManager.sendToProjection).not.toHaveBeenCalled()
})

it('relays playback errors only from the current projection sender', () => {
  const report = {
    itemId: 'video',
    blobId: 'blob',
    contentRevision: 1,
    errorCode: 3,
    currentTime: 0,
    duration: 0,
    transport: 'pause',
    volume: 1
  }
  mockWindowManager.isCurrentProjectionSender.mockReturnValueOnce(false)
  getOnHandler('projection:send-to-main')(makeEvent(), 4, 'file:playback-error', report)
  expect(mockWindowManager.sendToMain).not.toHaveBeenCalled()
  getOnHandler('projection:send-to-main')(makeEvent(), 4, 'file:playback-error', report)
  expect(mockWindowManager.sendToMain).toHaveBeenCalledWith(
    'projection:message',
    4,
    'file:playback-error',
    report
  )
})
