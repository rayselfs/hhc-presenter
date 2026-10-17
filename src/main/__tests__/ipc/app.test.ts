import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'

const {
  ipcHandlers,
  protocolHandlers,
  mockReadFileSync,
  mockRmSync,
  mockClearData,
  mockClearHhcLocalData,
  mockClearOneDriveCredentials,
  mockRelaunch,
  mockExit
} = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  protocolHandlers: new Map<string, (request: Request) => Response>(),
  mockReadFileSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockClearData: vi.fn(),
  mockClearHhcLocalData: vi.fn(),
  mockClearOneDriveCredentials: vi.fn(),
  mockRelaunch: vi.fn(),
  mockExit: vi.fn()
}))

const mockMainWindow = { id: 1 }
const mockProjectionWindow = { id: 2 }
const mockWindowManager = {
  getMainWindow: vi.fn(() => mockMainWindow),
  getProjectionWindow: vi.fn(() => mockProjectionWindow),
  confirmMainWindowClose: vi.fn(() => true)
}

vi.mock('electron', () => ({
  app: { relaunch: mockRelaunch, exit: mockExit, getPath: vi.fn(() => '/tmp/hhc-user-data') },
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    })
  },
  session: { defaultSession: { clearData: mockClearData } },
  protocol: {
    handle: vi.fn((scheme: string, handler: (request: Request) => Response) => {
      protocolHandlers.set(scheme, handler)
    })
  }
}))

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    readFileSync: mockReadFileSync,
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(),
    statSync: vi.fn(),
    renameSync: vi.fn(),
    rmSync: mockRmSync
  }
}))

vi.mock('https', () => ({
  default: {
    request: vi.fn(),
    get: vi.fn()
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false }
}))

import { BrowserWindow } from 'electron'
import type { WindowManager } from '../../windowManager'
import type { HhcAuthService } from '../../ipc/hhc-auth'
import { registerAppIpc, registerLocalModelProtocol } from '../../ipc/app'

const wm = mockWindowManager as unknown as WindowManager
const hhcAuthService = { clearLocalData: mockClearHhcLocalData } as unknown as HhcAuthService

function makeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} } as Electron.IpcMainInvokeEvent
}

beforeEach(() => {
  vi.clearAllMocks()
  mockClearData.mockResolvedValue(undefined)
  mockClearHhcLocalData.mockResolvedValue(undefined)
  mockClearOneDriveCredentials.mockResolvedValue(undefined)
  ipcHandlers.clear()
  protocolHandlers.clear()
  registerAppIpc(wm, hhcAuthService, { clearCredentials: mockClearOneDriveCredentials })
  registerLocalModelProtocol()
})

describe('model IPC security', () => {
  it('waits for HHC credential deletion before clearing app user data', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    let finishHhcClear!: () => void
    mockClearHhcLocalData.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishHhcClear = resolve
      })
    )

    const clearing = ipcHandlers.get('app:clear-user-data')!(makeEvent()) as Promise<void>
    await Promise.resolve()
    expect(mockRmSync).not.toHaveBeenCalled()
    expect(mockClearData).not.toHaveBeenCalled()

    finishHhcClear()
    await clearing

    expect(mockRmSync).toHaveBeenCalledWith(path.join('/tmp/hhc-user-data', 'native-files'), {
      force: true,
      recursive: true
    })
    expect(mockClearData).toHaveBeenCalledWith()
  })

  it('awaits OneDrive revocation before clearing session data or relaunching', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    let finish!: () => void
    mockClearOneDriveCredentials.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const clearing = ipcHandlers.get('app:clear-user-data')!(makeEvent()) as Promise<void>
    await Promise.resolve()
    expect(mockClearOneDriveCredentials).toHaveBeenCalledOnce()
    expect(mockClearData).not.toHaveBeenCalled()
    expect(mockRelaunch).not.toHaveBeenCalled()
    finish()
    await clearing
    expect(mockClearData).toHaveBeenCalledOnce()
  })

  it('propagates OneDrive deletion failures without relaunching', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    mockClearOneDriveCredentials.mockRejectedValueOnce(new Error('OneDrive delete failed'))
    await expect(ipcHandlers.get('app:clear-user-data')!(makeEvent())).rejects.toThrow(
      'OneDrive delete failed'
    )
    expect(mockClearData).not.toHaveBeenCalled()
    expect(mockRelaunch).not.toHaveBeenCalled()
  })

  it('rejects local credential deletion failure before session clearing or relaunch', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    mockClearHhcLocalData.mockRejectedValueOnce(new Error('local delete failed'))

    await expect(ipcHandlers.get('app:clear-user-data')!(makeEvent())).rejects.toThrow(
      'local delete failed'
    )
    expect(mockRmSync).not.toHaveBeenCalled()
    expect(mockClearData).not.toHaveBeenCalled()
    expect(mockRelaunch).not.toHaveBeenCalled()
    expect(mockExit).not.toHaveBeenCalled()
  })

  it('ignores clear-data requests outside the main window', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)

    await expect(ipcHandlers.get('app:clear-user-data')!(makeEvent())).resolves.toBeUndefined()
    expect(mockClearHhcLocalData).not.toHaveBeenCalled()
    expect(mockRmSync).not.toHaveBeenCalled()
    expect(mockClearData).not.toHaveBeenCalled()
  })

  it('rejects relative model directories', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)

    expect(() => ipcHandlers.get('app:set-model-dir')!(makeEvent(), '../models')).toThrow(
      'Invalid model directory'
    )
  })

  it('rejects model directory updates from non-main windows', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)

    expect(ipcHandlers.get('app:set-model-dir')!(makeEvent(), '/models')).toBeUndefined()
  })

  it('serves only files contained by the authorized model directory', async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)
    await ipcHandlers.get('app:set-model-dir')!(makeEvent(), '/models')
    mockReadFileSync.mockReturnValue(Buffer.from('model'))
    const handler = protocolHandlers.get('local-model')!

    const valid = handler(new Request('local-model://model/whisper/config.json'))
    expect(valid.status).toBe(200)
    expect(mockReadFileSync).toHaveBeenCalledWith(path.resolve('/models/whisper/config.json'))

    mockReadFileSync.mockClear()
    const traversal = handler(new Request('local-model://model/..%2Fsecret.txt'))
    expect(traversal.status).toBe(400)
    expect(mockReadFileSync).not.toHaveBeenCalled()
  })
})

describe('main window close IPC', () => {
  it('confirms a pending close request from the main window', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockMainWindow as never)

    expect(ipcHandlers.get('app:confirm-close')!(makeEvent())).toEqual({ closing: true })
    expect(mockWindowManager.confirmMainWindowClose).toHaveBeenCalledOnce()
  })

  it('rejects close confirmation from the projection window', () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(mockProjectionWindow as never)

    expect(ipcHandlers.get('app:confirm-close')!(makeEvent())).toEqual({ closing: false })
    expect(mockWindowManager.confirmMainWindowClose).not.toHaveBeenCalled()
  })
})
