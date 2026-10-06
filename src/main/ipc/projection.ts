import { isCameraMessageFrom } from '@shared/camera'
import { BrowserWindow, ipcMain } from 'electron'
import { WindowManager } from '../windowManager'
import { isKnownWindow, isMainWindow, validateProjectionTransportTuple } from './validate'

const CLOSED_PROJECTION_STATE = {
  exists: false,
  lifecycle: {
    generation: 0,
    status: 'closed' as const,
    reason: 'user-close' as const
  }
}

export function registerProjectionHandlers(windowManager: WindowManager): void {
  ipcMain.handle('projection:check', (event) => {
    if (!isKnownWindow(windowManager, event)) return CLOSED_PROJECTION_STATE
    return windowManager.getProjectionState()
  })

  ipcMain.handle('projection:ensure', (event, displayId?: string) => {
    if (!isMainWindow(windowManager, event)) return { created: false, generation: 0 }
    const state = windowManager.getProjectionState()
    if (state.exists) {
      return { created: false, generation: state.lifecycle.generation }
    }
    const generation = windowManager.createProjectionWindow(displayId)
    return { created: true, generation }
  })

  ipcMain.handle('projection:move-to-display', (event, displayId: string) => {
    if (!isMainWindow(windowManager, event)) return { moved: false, generation: 0 }
    return windowManager.moveProjectionWindow(displayId)
  })

  ipcMain.handle('projection:retry', (event) => {
    if (!isMainWindow(windowManager, event)) return { retried: false, generation: 0 }
    return windowManager.retryProjectionWindow()
  })

  ipcMain.handle('projection:get-generation', (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    if (senderWindow !== windowManager.getProjectionWindow()) return { generation: 0 }
    return { generation: windowManager.getProjectionState().lifecycle.generation }
  })

  ipcMain.handle('projection:close', (event) => {
    if (!isMainWindow(windowManager, event)) return { closed: false }
    windowManager.closeProjection()
    return { closed: true }
  })

  ipcMain.on('projection:send', (event, ...args: unknown[]) => {
    if (!isMainWindow(windowManager, event)) return
    if (!validateProjectionTransportTuple(args)) return
    const [generation, channel, data] = args
    if (channel === 'file:playback-error' || channel === 'file:render-status') return
    if (!isCameraMessageFrom(channel, data, 'main')) return
    if (windowManager.getProjectionState().lifecycle.generation !== generation) return
    windowManager.sendToProjection('projection:message', ...args)
  })

  ipcMain.on('projection:send-to-main', (event, ...args: unknown[]) => {
    if (!validateProjectionTransportTuple(args)) return
    const [generation, channel, data] = args
    if (!isCameraMessageFrom(channel, data, 'projection')) return
    if (!windowManager.isCurrentProjectionSender(event.sender, generation)) return
    if (channel === '__system:ready' && !windowManager.markProjectionReady(generation)) return
    windowManager.sendToMain('projection:message', ...args)
  })

  ipcMain.handle('projection:get-displays', (event) => {
    if (!isMainWindow(windowManager, event)) return []
    const displays = windowManager.getDisplays()
    const primaryId = windowManager.getPrimaryDisplayId()
    return displays.map((display) => ({
      id: display.id,
      label: display.label,
      isPrimary: display.id === primaryId,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor
    }))
  })
}
