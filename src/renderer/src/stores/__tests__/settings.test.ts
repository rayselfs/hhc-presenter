import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

const mockToast = vi.hoisted(() => ({ warning: vi.fn(), danger: vi.fn(), success: vi.fn() }))
vi.mock('@heroui/react', async () => {
  const actual = await vi.importActual('@heroui/react')
  return { ...actual, toast: mockToast }
})
vi.mock('@heroui/react/toast', () => ({ toast: mockToast }))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

vi.mock('@renderer/lib/site-data', () => ({
  clearAllSiteData: vi.fn()
}))

vi.mock('@renderer/lib/env', () => ({
  isElectron: vi.fn(() => false)
}))

import {
  useSettingsStore,
  TIMEZONE_OPTIONS,
  DEFAULT_SPEECH,
  DEFAULT_LAN_REMOTE,
  getEffectiveOneDriveClientId,
  getDefaultSpeechSettings,
  HHC_PRESENTER_DEFAULT_ONEDRIVE_CLIENT_ID,
  normalizeSettingsState
} from '@renderer/stores/settings'
import { clearAllSiteData } from '@renderer/lib/site-data'
import { isElectron } from '@renderer/lib/env'

const mockReload = vi.fn()

beforeEach(() => {
  useSettingsStore.setState({
    timezone: 'Asia/Taipei',
    hardwareAcceleration: true,
    themePreference: 'system',
    timerRingColor: '#3b82f6',
    speech: DEFAULT_SPEECH,
    projectionDisplayId: '',
    lanRemote: DEFAULT_LAN_REMOTE
  })
  mockToast.warning.mockClear()
  mockToast.success.mockClear()
  vi.mocked(clearAllSiteData).mockClear()
  mockReload.mockClear()
  Object.defineProperty(window, 'location', {
    value: { reload: mockReload },
    writable: true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('initial state', () => {
  it('starts with correct default values', () => {
    const s = useSettingsStore.getState()
    expect(s.timezone).toBe('Asia/Taipei')
    expect(s.hardwareAcceleration).toBe(true)
    expect(s.themePreference).toBe('system')
  })
})

describe('setTimezone', () => {
  it('updates store state', () => {
    useSettingsStore.getState().setTimezone('UTC')
    expect(useSettingsStore.getState().timezone).toBe('UTC')
  })

  it('persists to localStorage with persist middleware format', () => {
    let localStorageMock: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStorageMock[key] || null,
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
      key: (index: number) => {
        const keys = Object.keys(localStorageMock)
        return keys[index] || null
      }
    })

    useSettingsStore.getState().setTimezone('America/New_York')
    const persisted = localStorage.getItem('hhc-settings')
    expect(persisted).toBeTruthy()
    const parsed = JSON.parse(persisted!)
    expect(parsed.state.timezone).toBe('America/New_York')
    expect(parsed.version).toBe(14)

    vi.unstubAllGlobals()
  })
})

describe('setHardwareAcceleration', () => {
  it('updates store state', () => {
    useSettingsStore.getState().setHardwareAcceleration(false)
    expect(useSettingsStore.getState().hardwareAcceleration).toBe(false)
  })

  it('persists to localStorage with persist middleware format', () => {
    let localStorageMock: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStorageMock[key] || null,
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
      key: (index: number) => {
        const keys = Object.keys(localStorageMock)
        return keys[index] || null
      }
    })

    useSettingsStore.getState().setHardwareAcceleration(false)
    const persisted = localStorage.getItem('hhc-settings')
    expect(persisted).toBeTruthy()
    const parsed = JSON.parse(persisted!)
    expect(parsed.state.hardwareAcceleration).toBe(false)
    expect(parsed.version).toBe(14)

    vi.unstubAllGlobals()
  })
})

describe('resetSettings', () => {
  it('restores settings without clearing user data', () => {
    useSettingsStore.getState().setHardwareAcceleration(false)
    useSettingsStore.getState().resetSettings()
    expect(useSettingsStore.getState().hardwareAcceleration).toBe(true)
    expect(clearAllSiteData).not.toHaveBeenCalled()
  })

  it('shows success toast', () => {
    useSettingsStore.getState().resetSettings()
    expect(mockToast.success).toHaveBeenCalledWith('toast.settingsReset')
  })
})

describe('resetToDefaults', () => {
  it('calls clearAllSiteData', async () => {
    await useSettingsStore.getState().resetToDefaults()
    expect(clearAllSiteData).toHaveBeenCalledOnce()
  })

  it('shows success toast', async () => {
    await useSettingsStore.getState().resetToDefaults()
    expect(mockToast.success).toHaveBeenCalledWith('toast.settingsReset')
  })

  it('reloads page after delay (web mode)', async () => {
    vi.useFakeTimers()
    vi.mocked(isElectron).mockReturnValue(false)
    await useSettingsStore.getState().resetToDefaults()
    expect(mockReload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(mockReload).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('calls app.relaunch after delay (electron mode)', async () => {
    vi.useFakeTimers()
    vi.mocked(isElectron).mockReturnValue(true)
    const mockRelaunch = vi.fn()
    Object.defineProperty(window, 'api', {
      value: { app: { relaunch: mockRelaunch } },
      writable: true
    })
    await useSettingsStore.getState().resetToDefaults()
    expect(mockRelaunch).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(mockRelaunch).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('waits for site data cleanup before scheduling reload', async () => {
    vi.useFakeTimers()
    vi.mocked(isElectron).mockReturnValue(false)
    let resolveCleanup!: () => void
    vi.mocked(clearAllSiteData).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCleanup = resolve
      })
    )

    const reset = useSettingsStore.getState().resetToDefaults()
    await vi.advanceTimersByTimeAsync(500)
    expect(mockReload).not.toHaveBeenCalled()

    resolveCleanup()
    await reset
    await vi.advanceTimersByTimeAsync(500)
    expect(mockReload).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})

describe('persistence round-trip', () => {
  it('stores and retrieves state in persist middleware format', () => {
    let localStorageMock: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStorageMock[key] || null,
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
      key: (index: number) => {
        const keys = Object.keys(localStorageMock)
        return keys[index] || null
      }
    })

    useSettingsStore.getState().setTimezone('Europe/London')
    useSettingsStore.getState().setHardwareAcceleration(false)

    const persisted = localStorage.getItem('hhc-settings')
    expect(persisted).toBeTruthy()
    const parsed = JSON.parse(persisted!)
    expect(parsed.state.timezone).toBe('Europe/London')
    expect(parsed.state.hardwareAcceleration).toBe(false)
    expect(parsed.version).toBe(14)

    vi.unstubAllGlobals()
  })
})

describe('TIMEZONE_OPTIONS', () => {
  it('exports array with 8 timezone entries', () => {
    expect(TIMEZONE_OPTIONS).toHaveLength(8)
  })

  it('each entry has value and labelKey properties', () => {
    TIMEZONE_OPTIONS.forEach((option) => {
      expect(option).toHaveProperty('value')
      expect(option).toHaveProperty('labelKey')
      expect(typeof option.value).toBe('string')
      expect(typeof option.labelKey).toBe('string')
    })
  })

  it('includes expected timezone values', () => {
    const values = TIMEZONE_OPTIONS.map((opt) => opt.value)
    expect(values).toContain('Asia/Taipei')
    expect(values).toContain('Asia/Tokyo')
    expect(values).toContain('America/New_York')
    expect(values).toContain('America/Los_Angeles')
    expect(values).toContain('Asia/Kuala_Lumpur')
    expect(values).toContain('Europe/Athens')
    expect(values).toContain('Australia/Melbourne')
    expect(values).toContain('Europe/London')
  })
})

describe('resetToDefaults toast', () => {
  it('shows toast.success on settings reset', async () => {
    await useSettingsStore.getState().resetToDefaults()
    expect(mockToast.success).toHaveBeenCalledWith('toast.settingsReset')
  })
})

describe('storage toast notifications', () => {
  it('shows toast.warning when setTimezone storage fails', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded')
    })
    useSettingsStore.getState().setTimezone('UTC')
    expect(mockToast.warning).toHaveBeenCalledWith('toast.storageSaveFailed')
    spy.mockRestore()
  })

  it('shows toast.warning when setHardwareAcceleration storage fails', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded')
    })
    useSettingsStore.getState().setHardwareAcceleration(false)
    expect(mockToast.warning).toHaveBeenCalledWith('toast.storageSaveFailed')
    spy.mockRestore()
  })
})

describe('themePreference', () => {
  it('defaults to system', () => {
    expect(useSettingsStore.getState().themePreference).toBe('system')
  })

  it('setThemePreference updates state', () => {
    useSettingsStore.getState().setThemePreference('dark')
    expect(useSettingsStore.getState().themePreference).toBe('dark')

    useSettingsStore.getState().setThemePreference('light')
    expect(useSettingsStore.getState().themePreference).toBe('light')
  })

  it('resetToDefaults calls clearAllSiteData and reloads', async () => {
    vi.useFakeTimers()
    vi.mocked(isElectron).mockReturnValue(false)
    useSettingsStore.getState().setThemePreference('dark')
    await useSettingsStore.getState().resetToDefaults()
    expect(clearAllSiteData).toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(mockReload).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('themePreference is included in persisted state', () => {
    let localStorageMock: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStorageMock[key] || null,
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
      key: (index: number) => {
        const keys = Object.keys(localStorageMock)
        return keys[index] || null
      }
    })

    useSettingsStore.getState().setThemePreference('dark')
    const persisted = localStorage.getItem('hhc-settings')
    expect(persisted).toBeTruthy()
    const parsed = JSON.parse(persisted!)
    expect(parsed.state.themePreference).toBe('dark')
    expect(parsed.version).toBe(14)

    vi.unstubAllGlobals()
  })
})

describe('speech settings', () => {
  it('defaults to Chinese locally without provider credentials or model paths', () => {
    expect(getDefaultSpeechSettings()).toEqual({ recognitionLanguage: 'zh', microphoneId: '' })
  })
  it('preserves the old English choice while removing provider secrets and paths', () => {
    expect(
      normalizeSettingsState({
        speech: {
          azure: { language: 'en-US', region: 'old' },
          whisper: { modelDir: '/user/models' }
        }
      }).speech
    ).toEqual({ recognitionLanguage: 'en', microphoneId: '' })
  })
  it('rejects unsupported languages and retains a chosen microphone', () => {
    expect(
      normalizeSettingsState({ speech: { recognitionLanguage: 'fr', microphoneId: 'mic' } }).speech
    ).toEqual({ recognitionLanguage: 'zh', microphoneId: 'mic' })
  })
})

describe('OneDrive settings', () => {
  it('uses the configured HHC Presenter Client ID', () => {
    expect(getEffectiveOneDriveClientId()).toBe(HHC_PRESENTER_DEFAULT_ONEDRIVE_CLIENT_ID)
  })

  it('normalizes shared sync offline policy', () => {
    const normalized = normalizeSettingsState({
      defaultSyncOfflinePolicy: 'online-only'
    })

    expect(normalized.defaultSyncOfflinePolicy).toBe('online-only')
  })
})

describe('LAN remote settings', () => {
  it('normalizes LAN remote settings', () => {
    const normalized = normalizeSettingsState({
      lanRemote: { enabled: true, selectedHost: '192.168.1.10' }
    })

    expect(normalized.lanRemote).toEqual({
      ...DEFAULT_LAN_REMOTE,
      enabled: true,
      selectedHost: '192.168.1.10'
    })
  })

  it('never persists the runtime enabled flag', () => {
    let localStorageMock: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStorageMock[key] || null,
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
      key: (index: number) => Object.keys(localStorageMock)[index] || null
    })

    useSettingsStore.getState().setLanRemote({
      ...DEFAULT_LAN_REMOTE,
      enabled: true,
      selectedHost: '192.168.1.10'
    })

    const persisted = JSON.parse(localStorage.getItem('hhc-settings')!)
    expect(persisted.state.lanRemote).toEqual({
      ...DEFAULT_LAN_REMOTE,
      enabled: false,
      selectedHost: '192.168.1.10'
    })

    vi.unstubAllGlobals()
  })

  it('rehydrates legacy enabled state as disabled', async () => {
    localStorage.setItem(
      'hhc-settings',
      JSON.stringify({
        version: 12,
        state: {
          lanRemote: {
            ...DEFAULT_LAN_REMOTE,
            enabled: true,
            selectedHost: '192.168.1.10'
          }
        }
      })
    )

    await useSettingsStore.persist.rehydrate()

    expect(useSettingsStore.getState().lanRemote).toEqual({
      ...DEFAULT_LAN_REMOTE,
      enabled: false,
      selectedHost: '192.168.1.10'
    })
  })
})

describe('settings normalization', () => {
  it('restores documented defaults for invalid persisted values', () => {
    const normalized = normalizeSettingsState({
      timezone: 'Mars/Base',
      hardwareAcceleration: 'yes',
      themePreference: 'sepia',
      timerRingColor: 'var(--accent)',
      timerRingColorEnabled: 'true',
      trashRetentionDays: -10,
      reminderMode: 'multiply',
      projectionDisplayId: '../bad'
    })

    expect(normalized).toMatchObject({
      timezone: 'Asia/Taipei',
      hardwareAcceleration: true,
      themePreference: 'system',
      timerRingColor: '#3b82f6',
      timerRingColorEnabled: false,
      trashRetentionDays: 0,
      reminderMode: 'subtract',
      projectionDisplayId: ''
    })
  })

  it('normalizes valid projection display ids', () => {
    expect(normalizeSettingsState({ projectionDisplayId: '2' }).projectionDisplayId).toBe('2')
    expect(normalizeSettingsState({ projectionDisplayId: '' }).projectionDisplayId).toBe('')
  })
})

describe('recent presentation fonts', () => {
  it('normalizes and bounds the persisted recent font list', () => {
    expect(
      normalizeSettingsState({ recentPresentationFonts: ['Arial', null, ' Arial ', ''] })
        .recentPresentationFonts
    ).toEqual(['Arial'])
    useSettingsStore.setState({ recentPresentationFonts: [] })
    for (let i = 0; i < 10; i++) useSettingsStore.getState().rememberPresentationFont(`Font ${i}`)
    useSettingsStore.getState().rememberPresentationFont('Font 5')
    expect(useSettingsStore.getState().recentPresentationFonts).toHaveLength(8)
    expect(useSettingsStore.getState().recentPresentationFonts[0]).toBe('Font 5')
    expect(normalizeSettingsState({}).recentPresentationFonts).toEqual([])
  })
})
it('preserves legacy English choices while removing provider credentials and directories', () => {
  for (const speech of [
    { language: 'en-US', key: 'retired' },
    { provider: 'gcp', gcp: { language: 'en-GB', key: 'retired' }, whisper: { modelDir: '/old' } }
  ]) {
    expect(normalizeSettingsState({ speech }).speech).toEqual({
      recognitionLanguage: 'en',
      microphoneId: ''
    })
  }
})
