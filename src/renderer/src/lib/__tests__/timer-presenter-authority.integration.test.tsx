import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TimerService } from '../../../../main/timerService'
import type {
  TimerCommand,
  TimerSettings,
  TimerTickPayload,
  TimerRuntimeCommand,
  TimerRuntimeConfiguration
} from '@shared/types/timer'
import { TimerEngineProvider } from '@renderer/contexts/TimerEngineContext'
import { DEFAULT_SETTINGS, DEFAULT_STATE, useTimerStore } from '@renderer/stores/timer'
import { createLanRemoteSnapshot, executeLanRemoteCommand } from '../lan-remote-command-gateway'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('applies the accepted host frame before LAN acknowledgement and immediate readback', async () => {
  const service = new TimerService()
  let listener: ((payload: TimerTickPayload) => void) | null = null
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (_channel: string, payload: TimerTickPayload) => listener?.(payload)
    }
  }
  service.setWindowManager({
    getMainWindow: () => mainWindow,
    getProjectionWindow: () => null
  })
  vi.stubGlobal('api', {
    timer: {
      timerCommand: async (command: TimerCommand) => service.handleCommand(command),
      runtimeInitialize: async (configuration: TimerRuntimeConfiguration) =>
        service.initializeRuntime(configuration),
      runtimeCommand: async (command: TimerRuntimeCommand) =>
        service.executeRuntimeCommand(command),
      timerGetState: async () => service.getState(),
      timerInitialize: async (settings: TimerSettings) => service.initializeState(settings),
      onTimerTick: (callback: (payload: TimerTickPayload) => void) => {
        listener = callback
        return () => {
          listener = null
        }
      }
    }
  })
  useTimerStore.setState({ ...DEFAULT_SETTINGS, ...DEFAULT_STATE, hostRevision: -1 })
  const mounted = render(
    <TimerEngineProvider>
      <span>Presenter</span>
    </TimerEngineProvider>
  )
  try {
    await act(async () => {
      await expect(
        executeLanRemoteCommand({
          requestId: 'set-duration',
          type: 'timer:command',
          command: { type: 'setDuration', seconds: 75 }
        })
      ).resolves.toEqual({ requestId: 'set-duration', status: 'accepted' })
    })
    expect(service.getState().remainingSeconds).toBe(75)
    expect(useTimerStore.getState().remainingSeconds).toBe(75)
    expect(useTimerStore.getState().totalDuration).toBe(75)
    expect(createLanRemoteSnapshot(false).timer.remainingSeconds).toBe(75)
  } finally {
    mounted.unmount()
    service.dispose()
  }
})
