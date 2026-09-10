import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import '@renderer/i18n'
import i18n from '@renderer/i18n'
import { ConfirmDialogProvider } from '@renderer/contexts/ConfirmDialogContext'
import ConfirmDialog from '../../../Common/ConfirmDialog'
import PreferencesDialog from '../PreferencesDialog'
import { ShortcutScopeProvider } from '@renderer/contexts/ShortcutScopeContext'

const mockListProviderConnectionsByType = vi.hoisted(() => vi.fn(async () => []))
const mockHhcSignOut = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => undefined))
const mockToastDanger = vi.hoisted(() => vi.fn())

vi.mock('@renderer/contexts/HhcAuthContext', () => ({
  useHhcAuth: () => ({ signOut: mockHhcSignOut })
}))

vi.mock('@heroui/react/toast', () => ({
  toast: { danger: mockToastDanger }
}))

vi.mock('@renderer/lib/env', () => ({
  isElectron: vi.fn().mockReturnValue(false),
  isWeb: vi.fn().mockReturnValue(true)
}))

vi.mock('@renderer/lib/speech-key-storage', () => ({
  saveSpeechKey: vi.fn().mockResolvedValue(undefined),
  loadSpeechKey: vi.fn().mockResolvedValue(null),
  deleteSpeechKey: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@renderer/lib/media-storage-accounting', () => ({
  getMediaStorageAccounting: vi.fn().mockResolvedValue({
    usage: {
      electronNativeSourceMedia: 0,
      webIndexedDbSourceBlobs: 0,
      legacyElectronIndexedDbBlobs: 0,
      generatedCoverThumbnails: 0,
      customCoverOverrides: 0,
      pdfPageThumbnails: 0,
      videoPosters: 0,
      presentationDocuments: 0,
      syncCache: 0,
      temporaryAndFailedJobFiles: 0
    },
    total: 0,
    browser: null
  })
}))

vi.mock('@renderer/lib/media-storage-cleanup', () => ({
  clearRegenerableDerivedAssets: vi.fn().mockResolvedValue(undefined),
  clearUnpinnedSyncCache: vi.fn().mockResolvedValue(undefined),
  removeUnusedDerivedAssets: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@renderer/lib/onedrive-connect', () => ({
  loginOneDriveAccount: vi.fn(async () => null)
}))

vi.mock('@renderer/lib/recovery-center', () => ({
  collectRecoveryIssues: vi.fn(async () => []),
  runRecoveryAction: vi.fn(async () => undefined)
}))

vi.mock('@renderer/lib/sync-db', () => ({
  SYNC_ENTRY_CHANGED_EVENT: 'hhc:sync-entry-changed',
  listProviderConnectionsByType: mockListProviderConnectionsByType
}))

vi.mock('@renderer/lib/sync-unlink', () => ({
  unlinkSyncConnectionFromApp: vi.fn(async () => undefined)
}))

vi.mock('@renderer/lib/onedrive-web-credentials', () => ({
  deleteWebOneDriveCredentials: vi.fn(async () => undefined)
}))

vi.mock('@renderer/stores/settings', () => ({
  HHC_PRESENTER_DEFAULT_ONEDRIVE_CLIENT_ID: '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02',
  getEffectiveOneDriveClientId: () => '4f4c2f2c-8f2a-4c4b-9d2e-8c3a7d638c02',
  useSettingsStore: vi.fn((selector) => {
    const store = {
      timezone: 'Asia/Taipei',
      recentPresentationFonts: [],
      rememberPresentationFont: vi.fn(),
      hardwareAcceleration: true,
      reminderMode: 'subtract' as const,
      setReminderMode: vi.fn(),
      speech: {
        activeProvider: 'azure' as const,
        azure: { region: 'eastasia', language: 'zh-TW' as const },
        gcp: { language: 'cmn-Hant-TW' as const },
        whisper: { modelDir: '', installedModel: null }
      },
      setTimezone: vi.fn(),
      setHardwareAcceleration: vi.fn(),
      setSpeech: vi.fn(),
      defaultSyncOfflinePolicy: 'always-offline' as const,
      setDefaultSyncOfflinePolicy: vi.fn(),
      trashRetentionDays: 30,
      setTrashRetentionDays: vi.fn(),
      lanRemote: {
        enabled: false,
        selectedHost: ''
      },
      setLanRemote: vi.fn(),
      resetSettings: vi.fn(),
      resetToDefaults: vi.fn()
    }
    return selector ? selector(store) : store
  }),
  TIMEZONE_OPTIONS: [
    { value: 'Asia/Taipei', labelKey: 'timezones.taipei' },
    { value: 'Europe/London', labelKey: 'timezones.london' }
  ],
  AZURE_REGION_OPTIONS: [
    { value: 'eastasia', label: 'East Asia' },
    { value: 'southeastasia', label: 'Southeast Asia' }
  ]
}))

vi.mock('@renderer/contexts/ThemeContext', () => ({
  useTheme: vi.fn()
}))

function renderDialog(isOpen: boolean, onOpenChange = vi.fn()): ReturnType<typeof render> {
  return render(
    <ShortcutScopeProvider>
      <MemoryRouter>
        <ConfirmDialogProvider>
          <PreferencesDialog isOpen={isOpen} onOpenChange={onOpenChange} />
          <ConfirmDialog />
        </ConfirmDialogProvider>
      </MemoryRouter>
    </ShortcutScopeProvider>
  )
}

describe('PreferencesDialog', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockHhcSignOut.mockResolvedValue(undefined)
    await i18n.changeLanguage('en')

    const { isElectron } = await import('@renderer/lib/env')
    vi.mocked(isElectron).mockReturnValue(false)

    const { useTheme } = await import('@renderer/contexts/ThemeContext')
    vi.mocked(useTheme).mockReturnValue({
      preference: 'light',
      resolved: 'light',
      setPreference: vi.fn()
    })
  })

  it('renders when isOpen is true', () => {
    renderDialog(true)
    expect(screen.getByTestId('category-general')).toBeInTheDocument()
    expect(screen.getByTestId('category-timer')).toBeInTheDocument()
    expect(screen.getByTestId('category-bible')).toBeInTheDocument()
    expect(screen.getByTestId('category-media')).toBeInTheDocument()
    expect(screen.getByTestId('category-storage')).toBeInTheDocument()
  })

  it('does not render content when isOpen is false', () => {
    renderDialog(false)
    expect(screen.queryByTestId('category-general')).not.toBeInTheDocument()
  })

  it('shows general settings by default', () => {
    renderDialog(true)
    expect(screen.getByLabelText('Language')).toBeInTheDocument()
    expect(screen.queryByLabelText('Timezone')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Dark Mode')).toBeInTheDocument()
  })

  it('navigates to timer category and shows Timer settings', async () => {
    const user = userEvent.setup()
    renderDialog(true)

    await user.click(screen.getByTestId('category-timer'))
    expect(screen.getByLabelText('Timezone')).toBeInTheDocument()
    expect(screen.getByLabelText('Time Warning Calculation')).toBeInTheDocument()
    expect(screen.queryByLabelText('Language')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('category-general'))
    expect(screen.getByLabelText('Language')).toBeInTheDocument()
  })

  it('navigates to media category and back', async () => {
    const user = userEvent.setup()
    renderDialog(true)

    await user.click(screen.getByTestId('category-media'))
    expect(screen.getByTestId('category-media')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('Trash Retention Period')).toBeInTheDocument()
    expect(screen.getByTestId('category-media-general')).toBeInTheDocument()
    expect(screen.getByTestId('category-media-oneDrive')).toBeInTheDocument()
    expect(screen.queryByTestId('category-media-video')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Language')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('category-general'))
    expect(screen.getByLabelText('Language')).toBeInTheDocument()
  })

  it('collapses media children when another top-level category is selected', async () => {
    const user = userEvent.setup()
    renderDialog(true)

    await user.click(screen.getByTestId('category-media'))
    expect(screen.getByTestId('category-media-general')).toBeInTheDocument()

    await user.click(screen.getByTestId('category-timer'))
    expect(screen.queryByTestId('category-media-general')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Timezone')).toBeInTheDocument()
  })

  it('navigates between media child sections', async () => {
    const user = userEvent.setup()
    renderDialog(true)

    await user.click(screen.getByTestId('category-media'))
    expect(screen.getByLabelText('Offline Policy')).toBeInTheDocument()
    expect(
      screen.getByText('Applies to HHC LINE, OneDrive, and Shared with me folders.')
    ).toBeInTheDocument()
    await user.click(screen.getByTestId('category-media-oneDrive'))
    expect(screen.getByTestId('category-media')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('category-media-oneDrive')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Connected Account')).toBeInTheDocument()
    expect(screen.queryByLabelText('Custom Azure Client ID')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Offline Policy')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Trash Retention Period')).not.toBeInTheDocument()
  })

  it('opens LAN remote media preferences in Electron', async () => {
    const user = userEvent.setup()
    const { isElectron } = await import('@renderer/lib/env')
    vi.mocked(isElectron).mockReturnValue(true)

    renderDialog(true)

    await user.click(screen.getByTestId('category-media'))
    await user.click(screen.getByTestId('category-media-lanRemote'))

    expect(screen.getByLabelText('Enable LAN remote')).toBeInTheDocument()
    expect(screen.queryByLabelText('Allow trusted devices')).not.toBeInTheDocument()
  })

  it('allows OneDrive login from web and disables the button while login is pending', async () => {
    const user = userEvent.setup()
    const { loginOneDriveAccount } = await import('@renderer/lib/onedrive-connect')
    let resolveLogin: (value: null) => void = () => undefined
    vi.mocked(loginOneDriveAccount).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLogin = resolve
        })
    )
    renderDialog(true)

    await user.click(screen.getByTestId('category-media'))
    await user.click(screen.getByTestId('category-media-oneDrive'))
    const loginButton = screen.getByRole('button', { name: 'Sign in' })
    expect(loginButton).not.toBeDisabled()

    await user.click(loginButton)

    expect(screen.getByRole('button', { name: 'Signing in' })).toBeDisabled()
    resolveLogin(null)
  })

  it('shows Logout for a connected OneDrive account', async () => {
    const user = userEvent.setup()
    mockListProviderConnectionsByType.mockResolvedValueOnce([
      {
        id: 'onedrive:account-1',
        providerType: 'onedrive',
        displayName: 'OneDrive - Alice',
        accountLabel: 'alice@example.com',
        createdAt: 1,
        updatedAt: 1
      }
    ] as never)
    renderDialog(true)

    await user.click(screen.getByTestId('category-media'))
    await user.click(screen.getByTestId('category-media-oneDrive'))

    expect(await screen.findByRole('button', { name: 'Logout' })).toBeInTheDocument()
  })

  it('navigates between storage child sections', async () => {
    const user = userEvent.setup()
    renderDialog(true)

    await user.click(screen.getByTestId('category-storage'))
    expect(screen.getByTestId('category-storage')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('category-storage-usage')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('heading', { name: 'Usage' })).not.toBeInTheDocument()
    expect(screen.getAllByText('Original media files')).toHaveLength(1)

    await user.click(screen.getByTestId('category-storage-cleanup'))
    expect(screen.getByTestId('category-storage')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('category-storage-cleanup')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('heading', { name: 'Cache Cleanup' })).not.toBeInTheDocument()
    expect(screen.getByText('Clear orphan derived assets')).toBeInTheDocument()
    expect(screen.getByText(/covers, PDF previews, and video posters/)).toBeInTheDocument()
  })

  it('navigates to bible category and shows Bible settings', async () => {
    const user = userEvent.setup()
    renderDialog(true)

    await user.click(screen.getByTestId('category-bible'))
    expect(await screen.findByText('Test Connection')).toBeInTheDocument()
    expect(screen.queryByLabelText('Language')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('category-general'))
    expect(screen.getByLabelText('Language')).toBeInTheDocument()
  })

  it('hides unfinished soundboard preferences', () => {
    renderDialog(true)

    expect(screen.queryByTestId('category-soundboard')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/default trigger mode/i)).not.toBeInTheDocument()
  })

  it('opens recovery center preferences page', async () => {
    const user = userEvent.setup()
    renderDialog(true)

    await user.click(screen.getByTestId('category-recovery'))

    expect(await screen.findByText('No current recovery issues')).toBeInTheDocument()
  })

  it('calls i18n.changeLanguage when language option clicked', async () => {
    const user = userEvent.setup()
    const changeLanguageSpy = vi.spyOn(i18n, 'changeLanguage')
    renderDialog(true)

    const zhTWButton = screen.getByText('繁體中文')
    await user.click(zhTWButton)
    expect(changeLanguageSpy).toHaveBeenCalledWith('zh-TW')
  })

  it('calls setTimezone when timezone option clicked', async () => {
    const user = userEvent.setup()
    const { useSettingsStore } = await import('@renderer/stores/settings')
    const setTimezone = vi.fn()
    vi.mocked(useSettingsStore).mockImplementation((selector) => {
      const store = {
        timezone: 'Asia/Taipei',
        recentPresentationFonts: [],
        rememberPresentationFont: vi.fn(),
        hardwareAcceleration: true,
        setTimezone,
        setHardwareAcceleration: vi.fn(),
        resetSettings: vi.fn(),
        resetToDefaults: vi.fn(),
        themePreference: 'system' as const,
        setThemePreference: vi.fn(),
        timerRingColor: '#3b82f6',
        setTimerRingColor: vi.fn(),
        timerRingColorEnabled: false,
        setTimerRingColorEnabled: vi.fn(),
        reminderMode: 'subtract' as const,
        setReminderMode: vi.fn(),
        speech: {
          activeProvider: 'azure' as const,
          azure: { region: 'eastasia', language: 'zh-TW' as const },
          gcp: { language: 'cmn-Hant-TW' as const },
          whisper: { modelDir: '', installedModel: null }
        },
        setSpeech: vi.fn(),
        defaultSyncOfflinePolicy: 'always-offline' as const,
        setDefaultSyncOfflinePolicy: vi.fn(),
        trashRetentionDays: 30,
        setTrashRetentionDays: vi.fn(),
        projectionDisplayId: '',
        setProjectionDisplayId: vi.fn(),
        lanRemote: {
          enabled: false,
          selectedHost: ''
        },
        setLanRemote: vi.fn()
      }
      return selector ? selector(store) : store
    })

    renderDialog(true)

    // Navigate to timer category
    await user.click(screen.getByTestId('category-timer'))

    const londonButton = screen.getByText('London (UTC+0/+1)')
    await user.click(londonButton)
    expect(setTimezone).toHaveBeenCalledWith('Europe/London')
  })

  it('calls setPreference when dark mode switch clicked', async () => {
    const user = userEvent.setup()
    const { useTheme } = await import('@renderer/contexts/ThemeContext')
    const setPreference = vi.fn()
    vi.mocked(useTheme).mockReturnValue({
      preference: 'light',
      resolved: 'light',
      setPreference
    })

    renderDialog(true)

    const darkModeSwitch = screen.getByRole('switch', { name: 'Dark Mode' })
    await user.click(darkModeSwitch)
    expect(setPreference).toHaveBeenCalledWith('dark')
  })

  it('hides hardware acceleration switch on web', () => {
    renderDialog(true)
    expect(screen.queryByLabelText('Hardware Acceleration')).not.toBeInTheDocument()
  })

  it('shows hardware acceleration switch on Electron', async () => {
    const { isElectron } = await import('@renderer/lib/env')
    vi.mocked(isElectron).mockReturnValue(true)

    renderDialog(true)
    expect(screen.getByLabelText('Hardware Acceleration')).toBeInTheDocument()

    vi.mocked(isElectron).mockReturnValue(false)
  })

  it('disables projection display selector when no external display exists', async () => {
    const { isElectron } = await import('@renderer/lib/env')
    vi.mocked(isElectron).mockReturnValue(true)
    Object.defineProperty(window, 'api', {
      value: { projection: { getDisplays: vi.fn().mockResolvedValue([]) } },
      configurable: true
    })

    renderDialog(true)

    expect(await screen.findByText('No external display')).toBeInTheDocument()
    expect(screen.getByLabelText('Projection Window Display')).toHaveAttribute(
      'aria-disabled',
      'true'
    )

    vi.mocked(isElectron).mockReturnValue(false)
  })

  it('calls resetSettings when reset settings confirmed via modal', async () => {
    const user = userEvent.setup()
    const { useSettingsStore } = await import('@renderer/stores/settings')
    const { useTheme } = await import('@renderer/contexts/ThemeContext')

    const resetSettings = vi.fn()
    const resetToDefaults = vi.fn()
    const setPreference = vi.fn()
    const onOpenChange = vi.fn()

    vi.mocked(useSettingsStore).mockImplementation((selector) => {
      const store = {
        timezone: 'Asia/Taipei',
        recentPresentationFonts: [],
        rememberPresentationFont: vi.fn(),
        hardwareAcceleration: true,
        setTimezone: vi.fn(),
        setHardwareAcceleration: vi.fn(),
        resetSettings,
        resetToDefaults,
        themePreference: 'system' as const,
        setThemePreference: vi.fn(),
        timerRingColor: '#3b82f6',
        setTimerRingColor: vi.fn(),
        timerRingColorEnabled: false,
        setTimerRingColorEnabled: vi.fn(),
        reminderMode: 'subtract' as const,
        setReminderMode: vi.fn(),
        speech: {
          activeProvider: 'azure' as const,
          azure: { region: 'eastasia', language: 'zh-TW' as const },
          gcp: { language: 'cmn-Hant-TW' as const },
          whisper: { modelDir: '', installedModel: null }
        },
        setSpeech: vi.fn(),
        defaultSyncOfflinePolicy: 'always-offline' as const,
        setDefaultSyncOfflinePolicy: vi.fn(),
        trashRetentionDays: 30,
        setTrashRetentionDays: vi.fn(),
        projectionDisplayId: '',
        setProjectionDisplayId: vi.fn(),
        lanRemote: {
          enabled: false,
          selectedHost: ''
        },
        setLanRemote: vi.fn()
      }
      return selector ? selector(store) : store
    })
    vi.mocked(useTheme).mockReturnValue({
      preference: 'dark',
      resolved: 'dark',
      setPreference
    })

    renderDialog(true, onOpenChange)

    const resetButton = screen.getAllByText('Reset Settings').at(-1)!
    await user.click(resetButton)

    const allResetButtons = await screen.findAllByText('Reset Settings')
    await user.click(allResetButtons[allResetButtons.length - 1])

    expect(resetSettings).toHaveBeenCalled()
    expect(resetToDefaults).not.toHaveBeenCalled()
  })

  it('calls resetToDefaults when clear all data confirmed via modal', async () => {
    const user = userEvent.setup()
    const { useSettingsStore } = await import('@renderer/stores/settings')

    const resetToDefaults = vi.fn()

    vi.mocked(useSettingsStore).mockImplementation((selector) => {
      const store = {
        timezone: 'Asia/Taipei',
        recentPresentationFonts: [],
        rememberPresentationFont: vi.fn(),
        hardwareAcceleration: true,
        setTimezone: vi.fn(),
        setHardwareAcceleration: vi.fn(),
        resetSettings: vi.fn(),
        resetToDefaults,
        themePreference: 'system' as const,
        setThemePreference: vi.fn(),
        timerRingColor: '#3b82f6',
        setTimerRingColor: vi.fn(),
        timerRingColorEnabled: false,
        setTimerRingColorEnabled: vi.fn(),
        reminderMode: 'subtract' as const,
        setReminderMode: vi.fn(),
        speech: {
          activeProvider: 'azure' as const,
          azure: { region: 'eastasia', language: 'zh-TW' as const },
          gcp: { language: 'cmn-Hant-TW' as const },
          whisper: { modelDir: '', installedModel: null }
        },
        setSpeech: vi.fn(),
        defaultSyncOfflinePolicy: 'always-offline' as const,
        setDefaultSyncOfflinePolicy: vi.fn(),
        trashRetentionDays: 30,
        setTrashRetentionDays: vi.fn(),
        projectionDisplayId: '',
        setProjectionDisplayId: vi.fn(),
        lanRemote: {
          enabled: false,
          selectedHost: ''
        },
        setLanRemote: vi.fn()
      }
      return selector ? selector(store) : store
    })

    let finishSignOut!: () => void
    mockHhcSignOut.mockImplementationOnce(
      () => new Promise<void>((resolve) => void (finishSignOut = resolve))
    )
    renderDialog(true)

    await user.click(screen.getAllByText('Clear All Data').at(-1)!)
    const allClearButtons = await screen.findAllByText('Clear All Data')
    await user.click(allClearButtons[allClearButtons.length - 1])

    expect(mockHhcSignOut).toHaveBeenCalledOnce()
    expect(resetToDefaults).not.toHaveBeenCalled()
    finishSignOut()
    await vi.waitFor(() => expect(resetToDefaults).toHaveBeenCalledOnce())
  })

  it('keeps browser data intact and reports failure when account sign-out fails', async () => {
    const user = userEvent.setup()
    const { useSettingsStore } = await import('@renderer/stores/settings')
    const resetToDefaults = vi.fn()
    vi.mocked(useSettingsStore).mockImplementation((selector) => {
      const store = {
        timezone: 'Asia/Taipei',
        recentPresentationFonts: [],
        rememberPresentationFont: vi.fn(),
        hardwareAcceleration: true,
        setTimezone: vi.fn(),
        setHardwareAcceleration: vi.fn(),
        resetSettings: vi.fn(),
        resetToDefaults,
        themePreference: 'system' as const,
        setThemePreference: vi.fn(),
        timerRingColor: '#3b82f6',
        setTimerRingColor: vi.fn(),
        timerRingColorEnabled: false,
        setTimerRingColorEnabled: vi.fn(),
        reminderMode: 'subtract' as const,
        setReminderMode: vi.fn(),
        speech: {
          activeProvider: 'azure' as const,
          azure: { region: 'eastasia', language: 'zh-TW' as const },
          gcp: { language: 'cmn-Hant-TW' as const },
          whisper: { modelDir: '', installedModel: null }
        },
        setSpeech: vi.fn(),
        defaultSyncOfflinePolicy: 'always-offline' as const,
        setDefaultSyncOfflinePolicy: vi.fn(),
        trashRetentionDays: 30,
        setTrashRetentionDays: vi.fn(),
        projectionDisplayId: '',
        setProjectionDisplayId: vi.fn(),
        lanRemote: { enabled: false, selectedHost: '' },
        setLanRemote: vi.fn()
      }
      return selector ? selector(store) : store
    })
    mockHhcSignOut.mockRejectedValueOnce(new Error('logout failed'))
    renderDialog(true)

    await user.click(screen.getAllByText('Clear All Data').at(-1)!)
    const allClearButtons = await screen.findAllByText('Clear All Data')
    await user.click(allClearButtons[allClearButtons.length - 1])

    await vi.waitFor(() => expect(mockToastDanger).toHaveBeenCalledOnce())
    expect(resetToDefaults).not.toHaveBeenCalled()
  })

  it('disables reset actions while clearing all data', async () => {
    const user = userEvent.setup()
    const { useSettingsStore } = await import('@renderer/stores/settings')

    const resetToDefaults = vi.fn(
      () =>
        new Promise<void>(() => {
          // Keep pending so the clearing state is observable.
        })
    )

    vi.mocked(useSettingsStore).mockImplementation((selector) => {
      const store = {
        timezone: 'Asia/Taipei',
        recentPresentationFonts: [],
        rememberPresentationFont: vi.fn(),
        hardwareAcceleration: true,
        setTimezone: vi.fn(),
        setHardwareAcceleration: vi.fn(),
        resetSettings: vi.fn(),
        resetToDefaults,
        themePreference: 'system' as const,
        setThemePreference: vi.fn(),
        timerRingColor: '#3b82f6',
        setTimerRingColor: vi.fn(),
        timerRingColorEnabled: false,
        setTimerRingColorEnabled: vi.fn(),
        reminderMode: 'subtract' as const,
        setReminderMode: vi.fn(),
        speech: {
          activeProvider: 'azure' as const,
          azure: { region: 'eastasia', language: 'zh-TW' as const },
          gcp: { language: 'cmn-Hant-TW' as const },
          whisper: { modelDir: '', installedModel: null }
        },
        setSpeech: vi.fn(),
        defaultSyncOfflinePolicy: 'always-offline' as const,
        setDefaultSyncOfflinePolicy: vi.fn(),
        trashRetentionDays: 30,
        setTrashRetentionDays: vi.fn(),
        projectionDisplayId: '',
        setProjectionDisplayId: vi.fn(),
        lanRemote: {
          enabled: false,
          selectedHost: ''
        },
        setLanRemote: vi.fn()
      }
      return selector ? selector(store) : store
    })

    const { container } = renderDialog(true)

    await user.click(screen.getAllByText('Clear All Data').at(-1)!)
    const confirmButtons = await screen.findAllByText('Clear All Data')
    await user.click(confirmButtons[confirmButtons.length - 1])

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.getByTestId('select-root')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('category-timer')).toBeDisabled()
    expect(screen.getAllByText('Reset Settings').at(-1)).toBeDisabled()
    expect(screen.getAllByText('Clear All Data').at(-1)).toBeDisabled()
  })

  it('does not reset when cancel clicked in modal', async () => {
    const user = userEvent.setup()
    const { useSettingsStore } = await import('@renderer/stores/settings')
    const resetToDefaults = vi.fn()

    vi.mocked(useSettingsStore).mockImplementation((selector) => {
      const store = {
        timezone: 'Asia/Taipei',
        recentPresentationFonts: [],
        rememberPresentationFont: vi.fn(),
        hardwareAcceleration: true,
        setTimezone: vi.fn(),
        setHardwareAcceleration: vi.fn(),
        resetSettings: vi.fn(),
        resetToDefaults,
        themePreference: 'system' as const,
        setThemePreference: vi.fn(),
        timerRingColor: '#3b82f6',
        setTimerRingColor: vi.fn(),
        timerRingColorEnabled: false,
        setTimerRingColorEnabled: vi.fn(),
        reminderMode: 'subtract' as const,
        setReminderMode: vi.fn(),
        speech: {
          activeProvider: 'azure' as const,
          azure: { region: 'eastasia', language: 'zh-TW' as const },
          gcp: { language: 'cmn-Hant-TW' as const },
          whisper: { modelDir: '', installedModel: null }
        },
        setSpeech: vi.fn(),
        defaultSyncOfflinePolicy: 'always-offline' as const,
        setDefaultSyncOfflinePolicy: vi.fn(),
        trashRetentionDays: 30,
        setTrashRetentionDays: vi.fn(),
        projectionDisplayId: '',
        setProjectionDisplayId: vi.fn(),
        lanRemote: {
          enabled: false,
          selectedHost: ''
        },
        setLanRemote: vi.fn()
      }
      return selector ? selector(store) : store
    })

    renderDialog(true)

    const resetButton = screen.getAllByText('Reset Settings').at(-1)!
    await user.click(resetButton)

    const cancelButton = await screen.findByText('Cancel')
    await user.click(cancelButton)

    expect(resetToDefaults).not.toHaveBeenCalled()
  })
})
