vi.mock('../../lib/native-storage', () => ({ getNativeFilePath: mockGetNativeFilePath }))
import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleHandlers,
  mockFromWebContents,
  mockResolveFfmpegPosterRuntime,
  mockGetNativeFilePath,
  mockSpawn,
  mockReadFile,
  mockRm
} = vi.hoisted(() => ({
  handleHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  mockFromWebContents: vi.fn(),
  mockResolveFfmpegPosterRuntime: vi.fn(),
  mockGetNativeFilePath: vi.fn(),
  mockSpawn: vi.fn(),
  mockReadFile: vi.fn(),
  mockRm: vi.fn()
}))

const mockMainWindow = { id: 1 }
const mockProjectionWindow = { id: 2 }
const mockWindowManager = {
  getMainWindow: vi.fn(() => mockMainWindow)
}

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: mockFromWebContents
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleHandlers.set(channel, handler)
    })
  }
}))

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  default: {
    spawn: mockSpawn
  }
}))

vi.mock('fs', () => ({
  promises: {
    readFile: mockReadFile,
    rm: mockRm
  },
  default: {
    promises: {
      readFile: mockReadFile,
      rm: mockRm
    }
  }
}))

vi.mock('../../video-engine-runtime', () => ({
  resolveFfmpegRuntime: mockResolveFfmpegPosterRuntime
}))

vi.mock('../../ipc/native-fs', () => ({}))

import type { WindowManager } from '../../windowManager'
import { registerVideoPosterHandlers } from '../../ipc/video-poster'

const validId = '123e4567-e89b-12d3-a456-426614174000'
const wm = mockWindowManager as unknown as WindowManager

function makeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} } as Electron.IpcMainInvokeEvent
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = handleHandlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return handler
}

function mockFfmpegProcess(
  options: { code?: number; stdout?: string; stderr?: string } = {}
): void {
  mockSpawn.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    queueMicrotask(() => {
      if (options.stdout) child.stdout.emit('data', Buffer.from(options.stdout))
      if (options.stderr) child.stderr.emit('data', Buffer.from(options.stderr))
      child.emit('close', options.code ?? 0)
    })
    return child
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  handleHandlers.clear()
  mockFromWebContents.mockReturnValue(mockMainWindow)
  mockResolveFfmpegPosterRuntime.mockReturnValue({
    status: 'ready',
    path: '/runtime/ffmpeg',
    source: 'bundled'
  })
  mockGetNativeFilePath.mockReturnValue(`/native-files/${validId}`)
  mockReadFile.mockResolvedValue(Buffer.from('jpeg'))
  mockRm.mockResolvedValue(undefined)
  registerVideoPosterHandlers(wm)
})

describe('video poster IPC', () => {
  it('returns FFmpeg poster runtime info', async () => {
    mockFfmpegProcess({ stdout: 'ffmpeg version 8.1.2 Copyright' })

    await expect(getHandler('video-poster:get-info')(makeEvent())).resolves.toEqual({
      status: 'ready',
      source: 'bundled',
      executableName: process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
      version: '8.1.2'
    })
  })

  it('rejects generate calls from non-main windows', async () => {
    mockFromWebContents.mockReturnValue(mockProjectionWindow)

    await expect(
      getHandler('video-poster:generate')(makeEvent(), { sourceFileId: validId })
    ).rejects.toThrow('Unauthorized poster access')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('rejects invalid native file ids', async () => {
    await expect(
      getHandler('video-poster:generate')(makeEvent(), { sourceFileId: '../escape' })
    ).rejects.toThrow('Invalid poster source id')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('generates a poster data URL with FFmpeg', async () => {
    mockFfmpegProcess({ stdout: 'ffmpeg version 8.1.2' })
    mockFfmpegProcess()

    await expect(
      getHandler('video-poster:generate')(makeEvent(), { sourceFileId: validId })
    ).resolves.toEqual({ dataUrl: 'data:image/jpeg;base64,anBlZw==' })

    expect(mockSpawn).toHaveBeenLastCalledWith(
      '/runtime/ffmpeg',
      [
        '-hide_banner',
        '-y',
        '-ss',
        '00:00:01',
        '-i',
        `/native-files/${validId}`,
        '-frames:v',
        '1',
        '-vf',
        'scale=640:-2',
        '-pix_fmt',
        'yuvj420p',
        expect.stringContaining('.poster.jpg')
      ],
      expect.objectContaining({ shell: false })
    )
    expect(mockRm).toHaveBeenCalledWith(expect.stringContaining('.poster.jpg'), { force: true })
  })

  it('returns a controlled error when FFmpeg poster generation fails', async () => {
    mockFfmpegProcess({ stdout: 'ffmpeg version 8.1.2' })
    mockFfmpegProcess({ code: 1, stderr: 'decode failed' })

    await expect(
      getHandler('video-poster:generate')(makeEvent(), { sourceFileId: validId })
    ).rejects.toThrow('decode failed')
    expect(mockRm).toHaveBeenCalledWith(expect.stringContaining('.poster.jpg'), { force: true })
  })
})
