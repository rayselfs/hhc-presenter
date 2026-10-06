import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockMainWindow = { id: 1 }
const mockProjectionWindow = { id: 2 }
const mockUnknownWindow = { id: 3 }

const mockWindowManager = {
  getMainWindow: vi.fn(() => mockMainWindow),
  getProjectionWindow: vi.fn(() => mockProjectionWindow)
}

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn()
  }
}))

import { BrowserWindow } from 'electron'
import {
  isKnownWindow,
  isMainWindow,
  validateTheme,
  validateTimerCommand,
  validateTimerSettings,
  validateProjectionMessageTuple,
  validateProjectionTransportTuple
} from '../../ipc/validate'
import type { WindowManager } from '../../windowManager'

const wm = mockWindowManager as unknown as WindowManager

function makeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} } as Electron.IpcMainInvokeEvent
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('isKnownWindow', () => {
  it('returns true for main window', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    expect(isKnownWindow(wm, makeEvent())).toBe(true)
  })

  it('returns true for projection window', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)
    expect(isKnownWindow(wm, makeEvent())).toBe(true)
  })

  it('returns false for unknown window', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockUnknownWindow as never)
    expect(isKnownWindow(wm, makeEvent())).toBe(false)
  })

  it('returns false when sender has no window', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null as never)
    expect(isKnownWindow(wm, makeEvent())).toBe(false)
  })
})

describe('isMainWindow', () => {
  it('returns true for main window', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    expect(isMainWindow(wm, makeEvent())).toBe(true)
  })

  it('returns false for projection window', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)
    expect(isMainWindow(wm, makeEvent())).toBe(false)
  })

  it('returns false for unknown window', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockUnknownWindow as never)
    expect(isMainWindow(wm, makeEvent())).toBe(false)
  })

  it('returns false when neither the sender nor main window exists', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null as never)
    mockWindowManager.getMainWindow.mockReturnValueOnce(null as never)

    expect(isMainWindow(wm, makeEvent())).toBe(false)
  })
})

describe('validateTheme', () => {
  it.each(['light', 'dark', 'system'])('returns true for "%s"', (theme) => {
    expect(validateTheme(theme)).toBe(true)
  })

  it('returns false for invalid string', () => {
    expect(validateTheme('invalid')).toBe(false)
  })

  it('returns false for non-string', () => {
    expect(validateTheme(42)).toBe(false)
  })

  it('returns false for null', () => {
    expect(validateTheme(null)).toBe(false)
  })
})

describe('validateTimerCommand', () => {
  it.each([
    { type: 'start' },
    { type: 'pause' },
    { type: 'resume' },
    { type: 'reset' },
    { type: 'setDuration', seconds: 300 },
    { type: 'addTime', seconds: 30 },
    { type: 'removeTime', seconds: 30 },
    { type: 'setMode', mode: 'timer' },
    { type: 'setReminder', enabled: true, durationSeconds: 60 },
    { type: 'setOvertimeMessage', enabled: true, message: 'Overtime' },
    { type: 'startStopwatch' },
    { type: 'pauseStopwatch' },
    { type: 'resetStopwatch' }
  ])('returns true for valid command $type', (command) => {
    expect(validateTimerCommand(command)).toBe(true)
  })

  it.each([
    { type: 'setDuration' },
    { type: 'addTime', seconds: -1 },
    { type: 'removeTime', seconds: Number.NaN },
    { type: 'setMode', mode: 'invalid' },
    { type: 'setReminder', enabled: true },
    { type: 'setOvertimeMessage', enabled: true, message: 42 }
  ])('returns false for malformed command $type', (command) => {
    expect(validateTimerCommand(command)).toBe(false)
  })

  it('returns false for unknown type', () => {
    expect(validateTimerCommand({ type: 'explode' })).toBe(false)
  })

  it('returns false for non-object', () => {
    expect(validateTimerCommand('start')).toBe(false)
  })

  it('returns false for null', () => {
    expect(validateTimerCommand(null)).toBe(false)
  })

  it('returns false for missing type', () => {
    expect(validateTimerCommand({ foo: 'bar' })).toBe(false)
  })

  it('returns false for non-string type', () => {
    expect(validateTimerCommand({ type: 42 })).toBe(false)
  })
})

describe('validateTimerSettings', () => {
  const valid = {
    mode: 'timer',
    totalDuration: 300,
    reminderEnabled: false,
    reminderDuration: 60,
    reminderColor: '#ff0000',
    overtimeMessageEnabled: false,
    overtimeMessage: ''
  }

  it('returns true for valid settings', () => {
    expect(validateTimerSettings(valid)).toBe(true)
  })

  it('returns false for null', () => {
    expect(validateTimerSettings(null)).toBe(false)
  })

  it('returns false for non-object', () => {
    expect(validateTimerSettings('invalid')).toBe(false)
  })

  it('returns false for invalid mode', () => {
    expect(validateTimerSettings({ ...valid, mode: 'invalid' })).toBe(false)
  })

  it('returns false for non-string mode', () => {
    expect(validateTimerSettings({ ...valid, mode: 42 })).toBe(false)
  })

  it('returns false for negative totalDuration', () => {
    expect(validateTimerSettings({ ...valid, totalDuration: -1 })).toBe(false)
  })

  it('returns false for non-number totalDuration', () => {
    expect(validateTimerSettings({ ...valid, totalDuration: '300' })).toBe(false)
  })

  it('returns false for non-boolean reminderEnabled', () => {
    expect(validateTimerSettings({ ...valid, reminderEnabled: 'yes' })).toBe(false)
  })

  it('returns false for negative reminderDuration', () => {
    expect(validateTimerSettings({ ...valid, reminderDuration: -1 })).toBe(false)
  })

  it('returns false for non-string reminderColor', () => {
    expect(validateTimerSettings({ ...valid, reminderColor: 42 })).toBe(false)
  })

  it('returns false for non-boolean overtimeMessageEnabled', () => {
    expect(validateTimerSettings({ ...valid, overtimeMessageEnabled: 1 })).toBe(false)
  })

  it('returns false for non-string overtimeMessage', () => {
    expect(validateTimerSettings({ ...valid, overtimeMessage: null })).toBe(false)
  })
})

describe('validateProjectionTransportTuple', () => {
  it('accepts a positive generation with matching ready payload', () => {
    expect(validateProjectionTransportTuple([4, '__system:ready', { generation: 4 }])).toBe(true)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid generation %s',
    (generation) => {
      expect(
        validateProjectionTransportTuple([
          generation,
          'timer:overtime-message',
          { message: 'test' }
        ])
      ).toBe(false)
    }
  )

  it('rejects a ready payload for another generation', () => {
    expect(validateProjectionTransportTuple([4, '__system:ready', { generation: 3 }])).toBe(false)
  })

  it('accepts optional VLC playback capability and volume state', () => {
    expect(
      validateProjectionMessageTuple([
        'file:playback-state',
        {
          itemId: 'video-1',
          phase: 'ready',
          currentTime: 12,
          duration: 100,
          isPlaying: false,
          isEnded: false,
          seekable: true,
          volume: 0.35
        }
      ])
    ).toBe(true)
  })

  it('requires a known file playback phase', () => {
    expect(
      validateProjectionMessageTuple([
        'file:playback-state',
        {
          itemId: 'video-1',
          phase: 'buffering',
          currentTime: 0,
          duration: 0,
          isPlaying: false,
          isEnded: false
        }
      ])
    ).toBe(false)
    expect(
      validateProjectionMessageTuple([
        'file:playback-state',
        {
          itemId: 'video-1',
          currentTime: 0,
          duration: 0,
          isPlaying: false,
          isEnded: false
        }
      ])
    ).toBe(false)
  })

  it('accepts known playback variants and rejects unknown file projection variants', () => {
    const show = {
      itemId: 'video-1',
      blobId: 'blob-1',
      fileName: 'video.mkv',
      mimeType: 'video/x-matroska',
      playlist: [],
      currentIndex: 0
    }
    expect(
      validateProjectionMessageTuple(['file:show', { ...show, playbackVariant: 'matroska-remux' }])
    ).toBe(true)
    expect(
      validateProjectionMessageTuple(['file:show', { ...show, playbackVariant: 'transcode' }])
    ).toBe(false)
  })

  it.each([
    ['non-boolean seekability', { seekable: 'yes' }],
    ['negative volume', { volume: -0.01 }],
    ['volume above one', { volume: 1.01 }],
    ['non-finite volume', { volume: Number.NaN }]
  ])('rejects invalid VLC playback capability state: %s', (_label, invalid) => {
    expect(
      validateProjectionMessageTuple([
        'file:playback-state',
        {
          itemId: 'video-1',
          currentTime: 12,
          duration: 100,
          isPlaying: false,
          isEnded: false,
          ...invalid
        }
      ])
    ).toBe(false)
  })

  it('accepts a minimally valid replay snapshot', () => {
    expect(
      validateProjectionTransportTuple([
        4,
        '__system:replay',
        {
          generation: 4,
          snapshot: {
            owner: 'timer',
            showDefault: false,
            isBlackout: false,
            timer: {
              tick: null,
              stopwatch: null,
              overtimeMessage: null,
              timezone: null,
              ringColor: null
            },
            bible: { chapter: null, settings: null },
            media: { show: null, state: null }
          }
        }
      ])
    ).toBe(true)
  })

  it('rejects replay snapshots without an intentional-blackout state', () => {
    expect(
      validateProjectionTransportTuple([
        4,
        '__system:replay',
        {
          generation: 4,
          snapshot: {
            owner: 'timer',
            showDefault: false,
            timer: {
              tick: null,
              stopwatch: null,
              overtimeMessage: null,
              timezone: null,
              ringColor: null
            },
            bible: { chapter: null, settings: null },
            media: { show: null, state: null }
          }
        }
      ])
    ).toBe(false)
  })
})

describe('validateProjectionMessageTuple', () => {
  it('rejects the removed null ready payload', () => {
    expect(validateProjectionMessageTuple(['__system:ready', null])).toBe(false)
  })
})

describe('late playback error validation', () => {
  const report = {
    itemId: 'video-1',
    blobId: 'blob-1',
    contentRevision: 1,
    errorCode: 3,
    currentTime: 24,
    duration: 120,
    transport: 'pause',
    volume: 0.6
  }
  it('accepts a current decode report', () => {
    expect(validateProjectionTransportTuple([1, 'file:playback-error', report])).toBe(true)
  })
  it.each([
    { itemId: '' },
    { blobId: ' ' },
    { contentRevision: 0 },
    { contentRevision: 1.5 },
    { errorCode: 5 },
    { currentTime: -1 },
    { currentTime: Infinity },
    { duration: NaN },
    { volume: 2 },
    { transport: 'stop' }
  ])('rejects invalid fields %j', (invalid) => {
    expect(
      validateProjectionTransportTuple([1, 'file:playback-error', { ...report, ...invalid }])
    ).toBe(false)
  })
})

it('validates bounded document render reports and PDF initial state', () => {
  const report = { itemId: 'pdf', blobId: 'blob', contentRevision: 1, status: 'failed' }
  expect(validateProjectionMessageTuple(['file:render-status', report])).toBe(true)
  for (const data of [
    { ...report, contentRevision: 0 },
    { ...report, status: 'unknown' },
    { ...report, reason: 'unbounded-server-message' },
    { ...report, itemId: '' }
  ]) {
    expect(validateProjectionMessageTuple(['file:render-status', data])).toBe(false)
  }
  const show = {
    itemId: 'pdf',
    blobId: 'blob',
    fileName: 'test.pdf',
    mimeType: 'application/pdf',
    playlist: [],
    currentIndex: 0
  }
  expect(
    validateProjectionMessageTuple([
      'file:show',
      { ...show, pdf: { page: 3, scroll: 2.5, viewMode: 'continuous' } }
    ])
  ).toBe(true)
  expect(
    validateProjectionMessageTuple([
      'file:show',
      { ...show, pdf: { page: 0, scroll: Infinity, viewMode: 'continuous' } }
    ])
  ).toBe(false)
})
