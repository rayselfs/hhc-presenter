import { parseTimerCommand } from '@shared/timer-command'
import { ipcMain } from 'electron'
import { timerService } from '../timerService'
import type { WindowManager } from '../windowManager'
import { isKnownWindow, validateTimerSettings } from './validate'
import type { TimerRuntimeResult } from '@shared/types/timer'

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
    timerService.initializeState(settings)
  })

  ipcMain.handle(
    'timer:runtime-initialize',
    (event, configuration: unknown): TimerRuntimeResult => {
      if (!isKnownWindow(wm, event)) return { status: 'rejected', reason: 'unauthorized-sender' }
      return timerService.initializeRuntime(configuration)
    }
  )

  ipcMain.handle('timer:runtime-command', (event, command: unknown): TimerRuntimeResult => {
    if (!isKnownWindow(wm, event)) return { status: 'rejected', reason: 'unauthorized-sender' }
    return timerService.executeRuntimeCommand(command)
  })
}
