import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

import { useBibleSettingsStore } from '@renderer/stores/bible-settings'

beforeEach(() => {
  useBibleSettingsStore.setState({
    fontSize: 90,
    selectedVersionId: 0,
    speechMaxSessionSec: 0,
    scriptureTemplateId: 'dark-stage'
  })
})

describe('initial state', () => {
  it('starts with default fontSize of 90', () => {
    expect(useBibleSettingsStore.getState().fontSize).toBe(90)
  })

  it('starts with selectedVersionId of 0', () => {
    expect(useBibleSettingsStore.getState().selectedVersionId).toBe(0)
  })

  it('starts without an implicit cloud-cost deadline', () => {
    expect(useBibleSettingsStore.getState().speechMaxSessionSec).toBe(0)
  })

  it('starts with default scripture template', () => {
    expect(useBibleSettingsStore.getState().scriptureTemplateId).toBe('dark-stage')
  })
})

describe('setFontSize()', () => {
  it('updates fontSize', () => {
    useBibleSettingsStore.getState().setFontSize(120)
    expect(useBibleSettingsStore.getState().fontSize).toBe(120)
  })

  it('accepts minimum-range values', () => {
    useBibleSettingsStore.getState().setFontSize(30)
    expect(useBibleSettingsStore.getState().fontSize).toBe(30)
  })

  it('accepts maximum-range values', () => {
    useBibleSettingsStore.getState().setFontSize(150)
    expect(useBibleSettingsStore.getState().fontSize).toBe(150)
  })
})

describe('setSelectedVersionId()', () => {
  it('updates selectedVersionId', () => {
    useBibleSettingsStore.getState().setSelectedVersionId(1)
    expect(useBibleSettingsStore.getState().selectedVersionId).toBe(1)
  })

  it('can update to a different id', () => {
    useBibleSettingsStore.getState().setSelectedVersionId(1)
    useBibleSettingsStore.getState().setSelectedVersionId(2)
    expect(useBibleSettingsStore.getState().selectedVersionId).toBe(2)
  })
})

describe('persistence round-trip', () => {
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
    useBibleSettingsStore.setState({
      fontSize: 90,
      selectedVersionId: 0,
      speechMaxSessionSec: 0,
      scriptureTemplateId: 'dark-stage'
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists fontSize to localStorage with hhc-bible-settings key', () => {
    useBibleSettingsStore.getState().setFontSize(110)
    const raw = localStorage.getItem('hhc-bible-settings')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.version).toBe(5)
    expect(parsed.state.fontSize).toBe(110)
  })

  it('persists selectedVersionId to localStorage', () => {
    useBibleSettingsStore.getState().setSelectedVersionId(3)
    const raw = localStorage.getItem('hhc-bible-settings')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.state.selectedVersionId).toBe(3)
  })

  it('restores fontSize and selectedVersionId on rehydrate', () => {
    localStorageMock['hhc-bible-settings'] = JSON.stringify({
      state: { fontSize: 140, selectedVersionId: 5 },
      version: 0
    })
    useBibleSettingsStore.persist.rehydrate()
    const s = useBibleSettingsStore.getState()
    expect(s.fontSize).toBe(140)
    expect(s.selectedVersionId).toBe(5)
  })

  it('keeps current state when key missing from localStorage', () => {
    delete localStorageMock['hhc-bible-settings']
    useBibleSettingsStore.persist.rehydrate()
    const s = useBibleSettingsStore.getState()
    expect(s.fontSize).toBe(90)
    expect(s.selectedVersionId).toBe(0)
  })
})

describe('setSpeechMaxSessionSec()', () => {
  it('updates speechMaxSessionSec', () => {
    useBibleSettingsStore.getState().setSpeechMaxSessionSec(7200)
    expect(useBibleSettingsStore.getState().speechMaxSessionSec).toBe(7200)
  })
})

describe('scripture projection settings', () => {
  it('updates template id', () => {
    useBibleSettingsStore.getState().setScriptureTemplateId('warm-sermon')
    expect(useBibleSettingsStore.getState().scriptureTemplateId).toBe('warm-sermon')
  })
})

describe('migration', () => {
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
    useBibleSettingsStore.setState({
      fontSize: 90,
      selectedVersionId: 0,
      speechMaxSessionSec: 0,
      scriptureTemplateId: 'dark-stage'
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('migrates speechMaxSessionMin (v1) to speechMaxSessionSec (v2) by multiplying by 60', () => {
    localStorageMock['hhc-bible-settings'] = JSON.stringify({
      state: { fontSize: 100, selectedVersionId: 2, speechMaxSessionMin: 90 },
      version: 1
    })
    useBibleSettingsStore.persist.rehydrate()
    const s = useBibleSettingsStore.getState()
    expect(s.speechMaxSessionSec).toBe(5400) // 90 * 60
    expect(s.fontSize).toBe(100)
  })

  it('migrates from version 0 (no speechMaxSession field) without the retired default one-hour limit', () => {
    localStorageMock['hhc-bible-settings'] = JSON.stringify({
      state: { fontSize: 110, selectedVersionId: 1 },
      version: 0
    })
    useBibleSettingsStore.persist.rehydrate()
    const s = useBibleSettingsStore.getState()
    expect(s.speechMaxSessionSec).toBe(0)
  })
})
it('rejects invalid optional stop durations', () => {
  useBibleSettingsStore.getState().setSpeechMaxSessionSec(NaN)
  expect(useBibleSettingsStore.getState().speechMaxSessionSec).toBe(0)
  useBibleSettingsStore.getState().setSpeechMaxSessionSec(-1)
  expect(useBibleSettingsStore.getState().speechMaxSessionSec).toBe(0)
})
