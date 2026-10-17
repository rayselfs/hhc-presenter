import { parseTimerCommand } from '@shared/timer-command'
import { ipcMain } from 'electron'
import { timerService } from '../timerService'
import type { WindowManager } from '../windowManager'
import { isKnownWindow, validateTimerSettings } from './validate'

export function registerTimerHandlers(wm: WindowManager): void {
  timerService.setWindowManager(wm)

  ipcMain.handle('timer:command', (event, cmd: unknown) => {
    if (!isKnownWindow(wm, event)) return
    const command = parseTimerCommand(cmd)
    if (!command) return
    timerService.handleCommand(command)
  })

  ipcMain.handle('timer:get-state', (event) => {
    if (!isKnownWindow(wm, event)) return null
    return timerService.getState()
  })

  ipcMain.handle('timer:initialize', (event, settings: unknown) => {
    if (!isKnownWindow(wm, event)) return
    if (!validateTimerSettings(settings)) return
    timerService.initializeState(settings as Parameters<typeof timerService.initializeState>[0])
  })
}
