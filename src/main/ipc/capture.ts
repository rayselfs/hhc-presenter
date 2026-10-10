import { desktopCapturer, ipcMain, screen } from 'electron'
import { cameraSourceKind, type CameraSource } from '@shared/camera'
import type { WindowManager } from '../windowManager'

export function registerCaptureHandlers(wm: WindowManager, session: Electron.Session): void {
  let selection: { id: string; expires: number; frame: Electron.WebFrameMain } | null = null
  const trusted = (event: Electron.IpcMainInvokeEvent): boolean => {
    const main = wm.getMainWindow()?.webContents
    return !!main && event.sender === main && event.senderFrame === main.mainFrame
  }
  const sources = async (): Promise<Electron.DesktopCapturerSource[]> => {
    const available = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 0, height: 0 }
    })
    const projection = wm.getProjectionWindow()
    if (!projection) return available
    const displayId = wm.isProjectionOpen()
      ? String(screen.getDisplayMatching(projection.getBounds()).id)
      : null
    const windowId = projection.getMediaSourceId()
    return available.filter((source) =>
      source.id.startsWith('screen:')
        ? !displayId || (!!source.display_id && source.display_id !== displayId)
        : source.id !== windowId
    )
  }
  ipcMain.handle('capture:get-sources', async (event): Promise<CameraSource[]> => {
    if (!trusted(event)) throw new Error('Capture access denied')
    return (await sources()).map((source) => ({
      id: source.id,
      label: source.name,
      kind: cameraSourceKind(source.id)
    }))
  })
  ipcMain.handle('capture:select-source', async (event, id: unknown) => {
    if (!trusted(event)) throw new Error('Capture access denied')
    selection = null
    if (typeof id !== 'string' || id.length > 256 || !(await sources()).some((s) => s.id === id))
      throw new Error('Capture source unavailable')
    selection = { id, expires: Date.now() + 10000, frame: event.senderFrame! }
  })
  session.setDisplayMediaRequestHandler(async (request, callback) => {
    const chosen = selection
    if (request.frame !== wm.getMainWindow()?.webContents.mainFrame) return callback({})
    selection = null
    if (!chosen || chosen.frame !== request.frame || chosen.expires < Date.now())
      return callback({})
    try {
      const source = (await sources()).find((s) => s.id === chosen.id)
      callback(source ? { video: source } : {})
    } catch {
      callback({})
    }
  })
}
