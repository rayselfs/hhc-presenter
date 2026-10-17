import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockMainWindow = { id: 1 }
const mockProjectionWindow = { id: 2 }
const mockUnknownWindow = { id: 3 }

const mockWindowManager = {
  getMainWindow: vi.fn(() => mockMainWindow),
  getProjectionWindow: vi.fn(() => mockProjectionWindow)
}

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    BrowserWindow: {
      fromWebContents: vi.fn()
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }),
      _getHandler: (channel: string) => handlers.get(channel),
      _clearHandlers: () => handlers.clear()
    }
  }
})

vi.mock('../../timerService', () => ({
  timerService: {
    setWindowManager: vi.fn(),
    handleCommand: vi.fn(),
    getState: vi.fn(() => ({ status: 'stopped', remainingSeconds: 300 })),
    initializeState: vi.fn(),
    initializeRuntime: vi.fn(() => ({ status: 'rejected', reason: 'invalid-configuration' })),
    executeRuntimeCommand: vi.fn(() => ({ status: 'rejected', reason: 'not-initialized' }))
  }
}))

import { BrowserWindow, ipcMain } from 'electron'
import { timerService } from '../../timerService'
import type { WindowManager } from '../../windowManager'

const wm = mockWindowManager as unknown as WindowManager

function makeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} } as Electron.IpcMainInvokeEvent
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  return (
    ipcMain as unknown as { _getHandler: (c: string) => (...args: unknown[]) => unknown }
  )._getHandler(channel)
}

beforeEach(async () => {
  vi.clearAllMocks()
  ;(ipcMain as unknown as { _clearHandlers: () => void })._clearHandlers()

  const { registerTimerHandlers } = await import('../../ipc/timer')
  registerTimerHandlers(wm)
})

it('registers the managed windows with TimerService', () => {
  expect(timerService.setWindowManager).toHaveBeenCalledWith(wm)
})

describe('timer:command', () => {
  it('valid sender + valid command calls timerService.handleCommand', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    const handler = getHandler('timer:command')
    handler(makeEvent(), { type: 'start' })
    expect(timerService.handleCommand).toHaveBeenCalledWith({ type: 'start' })
  })

  it('passes only parsed command fields to the service', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    getHandler('timer:command')(makeEvent(), { type: 'addTime', seconds: 0.5, extra: 'discard' })
    expect(timerService.handleCommand).toHaveBeenCalledWith({ type: 'addTime', seconds: 0.5 })
  })

  it('unknown sender does NOT call timerService.handleCommand', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockUnknownWindow as never)
    const handler = getHandler('timer:command')
    handler(makeEvent(), { type: 'start' })
    expect(timerService.handleCommand).not.toHaveBeenCalled()
  })

  it('valid sender + invalid command does NOT call timerService.handleCommand', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    const handler = getHandler('timer:command')
    handler(makeEvent(), { type: 'explode' })
    expect(timerService.handleCommand).not.toHaveBeenCalled()
  })
})

describe('timer:get-state', () => {
  it('valid sender returns timerService.getState()', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    const handler = getHandler('timer:get-state')
    const result = handler(makeEvent())
    expect(result).toEqual({ status: 'stopped', remainingSeconds: 300 })
  })

  it('unknown sender returns null', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockUnknownWindow as never)
    const handler = getHandler('timer:get-state')
    const result = handler(makeEvent())
    expect(result).toBeNull()
  })
})

describe('timer:initialize', () => {
  const validSettings = {
    mode: 'timer',
    totalDuration: 600,
    reminderEnabled: true,
    reminderDuration: 60,
    reminderColor: '#ff0000',
    overtimeMessageEnabled: false,
    overtimeMessage: ''
  }

  it('valid sender + valid settings calls timerService.initializeState', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    const handler = getHandler('timer:initialize')
    handler(makeEvent(), validSettings)
    expect(timerService.initializeState).toHaveBeenCalledWith(validSettings)
  })

  it('valid sender + invalid settings does NOT call timerService.initializeState', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    const handler = getHandler('timer:initialize')
    handler(makeEvent(), { mode: 'invalid' })
    expect(timerService.initializeState).not.toHaveBeenCalled()
  })

  it.each(['totalDuration', 'reminderDuration'])(
    'rejects NaN in %s before service initialization',
    (field) => {
      vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
      getHandler('timer:initialize')(makeEvent(), { ...validSettings, [field]: NaN })
      expect(timerService.initializeState).not.toHaveBeenCalled()
    }
  )

  it('unknown sender does NOT call timerService.initializeState', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockUnknownWindow as never)
    const handler = getHandler('timer:initialize')
    handler(makeEvent(), validSettings)
    expect(timerService.initializeState).not.toHaveBeenCalled()
  })
})

describe.each([
  ['timer:runtime-initialize', 'initializeRuntime', { settings: {} }],
  ['timer:runtime-command', 'executeRuntimeCommand', { type: 'start' }]
] as const)('%s', (channel, method, payload) => {
  it.each([mockUnknownWindow, null])(
    'rejects an unmanaged sender without reaching the runtime',
    (sender) => {
      vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(sender as never)
      expect(getHandler(channel)(makeEvent(), payload)).toEqual({
        status: 'rejected',
        reason: 'unauthorized-sender'
      })
      expect(timerService[method]).not.toHaveBeenCalled()
    }
  )
  it.each([mockMainWindow, mockProjectionWindow])(
    'returns the managed host result for a known sender',
    (sender) => {
      vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(sender as never)
      const expected = vi.mocked(timerService[method]).getMockImplementation()?.(payload)
      vi.mocked(timerService[method]).mockClear()
      expect(getHandler(channel)(makeEvent(), payload)).toEqual(expected)
      expect(timerService[method]).toHaveBeenCalledExactlyOnceWith(payload)
    }
  )
})
