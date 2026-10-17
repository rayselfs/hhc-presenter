import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createJSONStorage } from 'zustand/middleware'

const lazyLocalStorage = vi.hoisted(() => ({
  getItem: (name: string) => localStorage.getItem(name),
  setItem: (name: string, value: string) => localStorage.setItem(name, value),
  removeItem: (name: string) => localStorage.removeItem(name)
}))

vi.mock('@renderer/lib/persist-storage', () => ({
  hhcPersistStorage: createJSONStorage(() => lazyLocalStorage),
  createKey: (name: string) => `hhc-${name}`
}))

import {
  useTimerConfigStore,
  DEFAULT_SETTINGS,
  DEFAULT_PRESETS
} from '@renderer/stores/timer-config'
import { useTimerRuntimeStore, DEFAULT_STATE } from '@renderer/stores/timer-runtime'
import { useTimerStore } from '@renderer/stores/timer'
import { installTimerRuntimeHarness } from '@renderer/test/timer-runtime-harness'

const INITIAL_CONFIG = {
  mode: DEFAULT_SETTINGS.mode,
  totalDuration: DEFAULT_SETTINGS.totalDuration,
  reminderEnabled: DEFAULT_SETTINGS.reminderEnabled,
  reminderDuration: DEFAULT_SETTINGS.reminderDuration,
  reminderColor: DEFAULT_SETTINGS.reminderColor,
  overtimeMessageEnabled: DEFAULT_SETTINGS.overtimeMessageEnabled,
  overtimeMessage: DEFAULT_SETTINGS.overtimeMessage,
  presets: DEFAULT_PRESETS
}

const INITIAL_RUNTIME = {
  status: DEFAULT_STATE.status,
  phase: DEFAULT_STATE.phase,
  remainingSeconds: DEFAULT_STATE.remainingSeconds,
  overtimeSeconds: DEFAULT_STATE.overtimeSeconds,
  progress: DEFAULT_STATE.progress,
  formattedTime: DEFAULT_STATE.formattedTime,
  hostRevision: -1
}

let host: ReturnType<typeof installTimerRuntimeHarness>
beforeEach(() => {
  useTimerConfigStore.setState(INITIAL_CONFIG)
  useTimerRuntimeStore.setState(INITIAL_RUNTIME)
  host = installTimerRuntimeHarness()
})
afterEach(() => host.dispose())

describe('timer-config store', () => {
  it('initializes with default settings', () => {
    const s = useTimerConfigStore.getState()
    expect(s.mode).toBe('timer')
    expect(s.totalDuration).toBe(300)
    expect(s.reminderEnabled).toBe(false)
    expect(s.reminderDuration).toBe(60)
    expect(s.reminderColor).toBe('#ef4444')
    expect(s.overtimeMessageEnabled).toBe(false)
    expect(s.overtimeMessage).toBe("Time's Up!")
    expect(Array.isArray(s.presets)).toBe(true)
  })

  it('has persist middleware with correct key', () => {
    expect(useTimerConfigStore.persist).toBeDefined()
    expect(useTimerConfigStore.persist.getOptions().name).toBe('hhc-timer-config')
  })

  it('has persist version 1', () => {
    expect(useTimerConfigStore.persist.getOptions().version).toBe(1)
  })

  it('setOvertimeMessage updates config fields', () => {
    useTimerConfigStore.getState().setOvertimeMessage(true, 'Done!')
    const s = useTimerConfigStore.getState()
    expect(s.overtimeMessageEnabled).toBe(true)
    expect(s.overtimeMessage).toBe('Done!')
  })

  it('addPreset adds a new preset', () => {
    const before = useTimerConfigStore.getState().presets.length
    useTimerConfigStore.getState().addPreset('TestPreset', 120)
    expect(useTimerConfigStore.getState().presets.length).toBe(before + 1)
    const added = useTimerConfigStore.getState().presets.find((p) => p.name === 'TestPreset')
    expect(added).toBeDefined()
    expect(added?.durationSeconds).toBe(120)
  })

  it('removePreset removes a preset by id', () => {
    const preset = useTimerConfigStore.getState().presets[0]
    useTimerConfigStore.getState().removePreset(preset.id)
    const found = useTimerConfigStore.getState().presets.find((p) => p.id === preset.id)
    expect(found).toBeUndefined()
  })
})

describe('timer-runtime store', () => {
  it('initializes with default state', () => {
    const s = useTimerRuntimeStore.getState()
    expect(s.status).toBe('stopped')
    expect(s.phase).toBe('idle')
    expect(s.remainingSeconds).toBe(300)
    expect(s.overtimeSeconds).toBe(0)
    expect(s.progress).toBe(1)
    expect(s.formattedTime).toBe('05:00')
    expect(s).not.toHaveProperty('targetEndTime')
  })

  it('has no persist middleware', () => {
    expect((useTimerRuntimeStore as { persist?: unknown }).persist).toBeUndefined()
  })

  it('isRunning returns false when stopped', () => {
    expect(useTimerRuntimeStore.getState().isRunning()).toBe(false)
  })

  it('isStopped returns true when stopped', () => {
    expect(useTimerRuntimeStore.getState().isStopped()).toBe(true)
  })

  it('start transitions to running', () => {
    useTimerRuntimeStore.getState().start()
    expect(useTimerRuntimeStore.getState().status).toBe('running')
  })

  it('pause transitions from running to paused', () => {
    useTimerRuntimeStore.getState().start()
    useTimerRuntimeStore.getState().pause()
    expect(useTimerRuntimeStore.getState().status).toBe('paused')
  })

  it('reset returns to stopped with totalDuration', () => {
    useTimerRuntimeStore.getState().start()
    useTimerRuntimeStore.getState().reset()
    const s = useTimerRuntimeStore.getState()
    expect(s.status).toBe('stopped')
    expect(s.phase).toBe('idle')
  })
})

describe('timer-config persist/hydrate roundtrip', () => {
  let localStorageMock: Record<string, string> = {}

  beforeEach(() => {
    localStorageMock = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStorageMock[key] ?? null,
      setItem: (key: string, value: string) => {
        localStorageMock[key] = value
      },
      removeItem: (key: string) => {
        delete localStorageMock[key]
      },
      clear: () => {
        localStorageMock = {}
      },
      length: 0,
      key: (index: number) => Object.keys(localStorageMock)[index] ?? null
    })
    useTimerConfigStore.setState(INITIAL_CONFIG)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists to hhc-timer-config key', () => {
    useTimerConfigStore.getState().setOvertimeMessage(true, 'Test')
    expect(localStorageMock['hhc-timer-config']).toBeDefined()
  })

  it('persists config fields with version 1', () => {
    useTimerConfigStore.getState().setOvertimeMessage(true, 'Test')
    const parsed = JSON.parse(localStorageMock['hhc-timer-config'])
    expect(parsed.version).toBe(1)
    expect(parsed.state).toHaveProperty('overtimeMessage', 'Test')
  })

  it('does not persist runtime fields', () => {
    useTimerConfigStore.getState().setOvertimeMessage(true, 'Test')
    const parsed = JSON.parse(localStorageMock['hhc-timer-config'])
    expect(parsed.state).not.toHaveProperty('status')
    expect(parsed.state).not.toHaveProperty('remainingSeconds')
    expect(parsed.state).not.toHaveProperty('targetEndTime')
  })

  it('rehydrates saved totalDuration', () => {
    localStorageMock['hhc-timer-config'] = JSON.stringify({
      state: { totalDuration: 240 },
      version: 1
    })
    useTimerConfigStore.persist.rehydrate()
    expect(useTimerConfigStore.getState().totalDuration).toBe(240)
  })
})

describe('migration from old hhc-timer key', () => {
  let localStorageMock: Record<string, string> = {}

  beforeEach(() => {
    localStorageMock = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStorageMock[key] ?? null,
      setItem: (key: string, value: string) => {
        localStorageMock[key] = value
      },
      removeItem: (key: string) => {
        delete localStorageMock[key]
      },
      clear: () => {
        localStorageMock = {}
      },
      length: 0,
      key: (index: number) => Object.keys(localStorageMock)[index] ?? null
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads config fields from old hhc-timer key when hhc-timer-config does not exist', () => {
    localStorageMock['hhc-timer'] = JSON.stringify({
      state: {
        totalDuration: 600,
        mode: 'timer',
        reminderEnabled: true,
        reminderDuration: 90,
        reminderColor: '#00ff00',
        overtimeMessageEnabled: true,
        overtimeMessage: 'Done!',
        presets: []
      },
      version: 0
    })
    useTimerConfigStore.persist.rehydrate()
    const s = useTimerConfigStore.getState()
    expect(s.totalDuration).toBe(600)
    expect(s.reminderEnabled).toBe(true)
    expect(s.overtimeMessage).toBe('Done!')
  })
})

describe('combined useTimerStore barrel', () => {
  it('getState returns merged config and runtime state', () => {
    const s = useTimerStore.getState()
    expect(s.mode).toBe('timer')
    expect(s.totalDuration).toBe(300)
    expect(s.status).toBe('stopped')
    expect(s.remainingSeconds).toBe(300)
  })

  it('setState routes config fields to config store', () => {
    useTimerStore.setState({ totalDuration: 120 })
    expect(useTimerConfigStore.getState().totalDuration).toBe(120)
  })

  it('setState routes runtime fields to runtime store', () => {
    useTimerStore.setState({ status: 'paused', remainingSeconds: 150 })
    expect(useTimerRuntimeStore.getState().status).toBe('paused')
    expect(useTimerRuntimeStore.getState().remainingSeconds).toBe(150)
  })

  it('persist delegates to config store', () => {
    expect(useTimerStore.persist).toBe(useTimerConfigStore.persist)
  })

  it('supports selector-aware subscriptions', () => {
    const listener = vi.fn()
    const unsubscribe = useTimerStore.subscribe((state) => state.mode, listener)

    useTimerRuntimeStore.setState({ remainingSeconds: 120 })
    expect(listener).not.toHaveBeenCalled()

    useTimerConfigStore.setState({ mode: 'clock' })
    expect(listener).toHaveBeenCalledWith('clock', 'timer')
    unsubscribe()
  })

  it('does not rerender a selector hook for unrelated state changes', () => {
    let renderCount = 0
    const { result } = renderHook(() => {
      renderCount += 1
      return useTimerStore((state) => state.mode)
    })

    act(() => {
      useTimerRuntimeStore.setState({ remainingSeconds: 120 })
    })

    expect(result.current).toBe('timer')
    expect(renderCount).toBe(1)
  })
})
