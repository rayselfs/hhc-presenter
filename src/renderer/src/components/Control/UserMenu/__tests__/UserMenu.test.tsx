import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import i18n from '@renderer/i18n'
import { ConfirmDialogProvider } from '@renderer/contexts/ConfirmDialogContext'
import { PresentationCloseDecisionProvider } from '@renderer/contexts/PresentationCloseDecisionContext'
import { PresentationSessionRegistryProvider } from '@renderer/contexts/PresentationSessionRegistryContext'
import ConfirmDialog from '../../../Common/ConfirmDialog'
import UserMenu from '../UserMenu'
import { ShortcutScopeProvider } from '@renderer/contexts/ShortcutScopeContext'
import { isElectron, isMac, isWeb } from '@renderer/lib/env'
import { useUpdateStore } from '@renderer/stores/update'

const auth = vi.hoisted(() => ({
  value: {
    status: 'anonymous' as 'loading' | 'anonymous' | 'authenticated' | 'unavailable',
    session: null as {
      userId: string
      displayName: string
      roles: string[]
      permissions?: string[]
      avatarUrl?: string
    } | null,
    signInStatus: 'idle' as 'idle' | 'pending' | 'cancelled' | 'expired',
    pendingSignInExpiresAt: null as number | null,
    signIn: vi.fn(async () => undefined),
    cancelSignIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    getAccessToken: vi.fn(async () => null)
  }
}))
const toastDanger = vi.hoisted(() => vi.fn())
const updateApi = vi.hoisted(() => ({
  installDownloaded: vi.fn(async () => undefined),
  downloadMacInstaller: vi.fn(async () => undefined)
}))

vi.mock('@renderer/contexts/HhcAuthContext', () => ({
  useHhcAuth: () => auth.value
}))

vi.mock('@heroui/react/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@heroui/react/toast')>()
  return { ...actual, toast: { ...actual.toast, danger: toastDanger } }
})

vi.mock('@renderer/lib/env', () => ({
  isElectron: vi.fn(() => false),
  isMac: vi.fn(() => false),
  isWeb: vi.fn(() => true)
}))

function renderUserMenu(
  props: { isExpanded?: boolean; onOpenPreferences?: () => void } = {}
): ReturnType<typeof render> {
  const { isExpanded = true, ...userMenuProps } = props
  return render(
    <ShortcutScopeProvider>
      <I18nextProvider i18n={i18n}>
        <ConfirmDialogProvider>
          <PresentationSessionRegistryProvider>
            <PresentationCloseDecisionProvider>
              <UserMenu isExpanded={isExpanded} {...userMenuProps} />
              <ConfirmDialog />
            </PresentationCloseDecisionProvider>
          </PresentationSessionRegistryProvider>
        </ConfirmDialogProvider>
      </I18nextProvider>
    </ShortcutScopeProvider>
  )
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  auth.value.status = 'anonymous'
  auth.value.session = null
  auth.value.signInStatus = 'idle'
  auth.value.pendingSignInExpiresAt = null
  auth.value.signIn = vi.fn(async () => undefined)
  auth.value.cancelSignIn = vi.fn(async () => undefined)
  auth.value.signOut = vi.fn(async () => undefined)
  auth.value.getAccessToken = vi.fn(async () => null)
  toastDanger.mockClear()
  vi.mocked(isElectron).mockReturnValue(false)
  vi.mocked(isMac).mockReturnValue(false)
  vi.mocked(isWeb).mockReturnValue(true)
  useUpdateStore.getState().reset()
  updateApi.installDownloaded.mockClear()
  updateApi.downloadMacInstaller.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { update: updateApi }
  })
})

describe('UserMenu', () => {
  it('renders avatar with guest name', () => {
    const { container } = renderUserMenu()
    expect(screen.getByText('Guest')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="avatar"]')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="avatar-fallback"]')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Account menu for Guest' })).toHaveLength(1)
    expect(container.querySelector('button button')).not.toBeInTheDocument()
  })

  it.each([
    ['Alice Chen', 'AC'],
    ['王小明', '王'],
    ['  小明   王  ', '小王'],
    ['alice@example.org', 'A'],
    ['   ', '?']
  ])('uses website initials for %s without a profile image', (displayName, initials) => {
    auth.value.status = 'authenticated'
    auth.value.session = { userId: 'user', displayName, roles: [] }
    const { container } = renderUserMenu()
    expect(container.querySelector('[data-slot="avatar-fallback"]')).toHaveTextContent(initials)
  })

  it('renders all menu items', () => {
    renderUserMenu()
    expect(screen.getByText('Login')).toBeInTheDocument()
    expect(screen.getByText('Preferences')).toBeInTheDocument()
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument()
    expect(screen.getByText('About')).toBeInTheDocument()
    expect(screen.getByText('Close App')).toBeInTheDocument()
  })

  it('hides update item in web mode', () => {
    renderUserMenu()
    expect(screen.queryByText('Up to Date')).not.toBeInTheDocument()
  })

  it.each([
    [null, 'Downloading...'],
    [42, 'Downloading 42%']
  ])('shows updater download progress %s in Electron mode', (downloadPercent, label) => {
    vi.mocked(isElectron).mockReturnValue(true)
    useUpdateStore.setState({ status: 'downloading', downloadPercent })

    renderUserMenu()

    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('shows background checking as a disabled status', () => {
    vi.mocked(isElectron).mockReturnValue(true)
    renderUserMenu()

    const item = screen.getByText('Checking...').closest('[role="menuitem"]')
    expect(item).toHaveAttribute('aria-disabled', 'true')
  })

  it('shows the latest version as a disabled status', () => {
    vi.mocked(isElectron).mockReturnValue(true)
    useUpdateStore.setState({ status: 'not-available' })
    renderUserMenu()

    const item = screen.getByText('Up to Date').closest('[role="menuitem"]')
    expect(item).toHaveAttribute('aria-disabled', 'true')
  })

  it('asks before installing a downloaded Windows update', async () => {
    vi.mocked(isElectron).mockReturnValue(true)
    useUpdateStore.setState({ status: 'downloaded', availableVersion: '2.4.1' })
    renderUserMenu()

    fireEvent.click(screen.getByText('Update v2.4.1').closest('[role="menuitem"]')!)
    expect(await screen.findByText('Install update now?')).toBeInTheDocument()
    expect(updateApi.installDownloaded).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Install now' }))
    await waitFor(() => expect(updateApi.installDownloaded).toHaveBeenCalledOnce())
  })

  it('starts the dedicated macOS download from an available update', () => {
    vi.mocked(isElectron).mockReturnValue(true)
    vi.mocked(isMac).mockReturnValue(true)
    useUpdateStore.setState({ status: 'available', availableVersion: '2.4.1' })
    renderUserMenu()

    fireEvent.click(screen.getByText('Update v2.4.1').closest('[role="menuitem"]')!)

    expect(updateApi.downloadMacInstaller).toHaveBeenCalledOnce()
    expect(updateApi.installDownloaded).not.toHaveBeenCalled()
  })

  it('shows macOS verification as a disabled status', () => {
    vi.mocked(isElectron).mockReturnValue(true)
    vi.mocked(isMac).mockReturnValue(true)
    useUpdateStore.setState({ status: 'verifying' })
    renderUserMenu()

    const item = screen.getByText('Verifying download...').closest('[role="menuitem"]')
    expect(item).toHaveAttribute('aria-disabled', 'true')
  })

  it('opens macOS installation guidance after the verified DMG opens', () => {
    vi.mocked(isElectron).mockReturnValue(true)
    vi.mocked(isMac).mockReturnValue(true)
    useUpdateStore.setState({ status: 'installer-opened', availableVersion: '2.4.1' })
    renderUserMenu()

    expect(screen.getByText('Install HHC Presenter')).toBeInTheDocument()
  })

  it('enables Login for an anonymous session', () => {
    renderUserMenu()
    const login = screen.getByText('Login').closest('[role="menuitem"]')
    expect(login).not.toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(login!)
    expect(auth.value.signIn).toHaveBeenCalledOnce()
  })

  it('shows Login when not logged in', () => {
    renderUserMenu()
    expect(screen.getByText('Login')).toBeInTheDocument()
    expect(screen.queryByText('Logout')).not.toBeInTheDocument()
  })

  it('shows pending feedback and lets the user cancel sign-in', () => {
    auth.value.signInStatus = 'pending'
    auth.value.pendingSignInExpiresAt = Date.now() + 300_000
    renderUserMenu()

    expect(screen.getByText('Waiting for sign-in...')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Cancel sign-in').closest('[role="menuitem"]')!)
    expect(auth.value.cancelSignIn).toHaveBeenCalledOnce()
    expect(screen.queryByText('Login')).not.toBeInTheDocument()
  })

  it.each([
    ['cancelled', 'Sign-in cancelled'],
    ['expired', 'Sign-in expired. Try again.']
  ] as const)('shows %s feedback with an immediate retry', (signInStatus, message) => {
    auth.value.signInStatus = signInStatus
    renderUserMenu()

    expect(screen.getByText(message)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Login').closest('[role="menuitem"]')!)
    expect(auth.value.signIn).toHaveBeenCalledOnce()
  })

  it.each([
    ['loading', 'Loading account...'],
    ['unavailable', 'Account unavailable']
  ] as const)('shows a disabled %s account state', (status, label) => {
    auth.value.status = status
    renderUserMenu()
    const item = screen.getByText(label).closest('[role="menuitem"]')
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByText('Login')).not.toBeInTheDocument()
  })

  it('shows the authenticated display name and logs out', () => {
    auth.value.status = 'authenticated'
    auth.value.session = { userId: 'user-1', displayName: 'Ada Lovelace', roles: [] }
    renderUserMenu()

    expect(screen.getAllByText('Ada Lovelace')).toHaveLength(2)
    expect(
      screen.getByRole('button', { name: 'Account menu for Ada Lovelace' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText('Logout').closest('[role="menuitem"]')!)
    expect(auth.value.signOut).toHaveBeenCalledOnce()
  })

  it('shows website and account links after Presenter tools in authenticated web mode', () => {
    auth.value.status = 'authenticated'
    auth.value.session = {
      userId: 'user-1',
      displayName: 'Ada Lovelace',
      roles: [],
      permissions: []
    }

    renderUserMenu()

    const items = screen.getAllByRole('menuitem')
    const labels = items.map((item) => item.textContent)
    expect(labels.indexOf('Keyboard Shortcuts')).toBeLessThan(labels.indexOf('Official site'))
    expect(labels.indexOf('Account management')).toBeLessThan(labels.indexOf('About'))
    expect(screen.getByRole('menuitem', { name: 'Official site' })).toHaveAttribute(
      'href',
      'https://www.alive.org.tw/en'
    )
    expect(screen.getByRole('menuitem', { name: 'Account management' })).toHaveAttribute(
      'href',
      'https://account.alive.org.tw/profile'
    )
    expect(screen.queryByRole('menuitem', { name: 'Admin' })).not.toBeInTheDocument()
  })

  it('shows admin management only with an admin capability in web mode', () => {
    auth.value.status = 'authenticated'
    auth.value.session = {
      userId: 'user-1',
      displayName: 'Ada Lovelace',
      roles: [],
      permissions: ['cms:pages:read']
    }

    renderUserMenu()

    expect(screen.getByRole('menuitem', { name: 'Admin' })).toHaveAttribute(
      'href',
      'https://admin.alive.org.tw/'
    )
  })

  it.each([
    ['zh-TW', 'zh-Hant'],
    ['zh-CN', 'zh-Hans'],
    ['en', 'en']
  ])('links %s to the matching website locale', async (language, websiteLocale) => {
    await i18n.changeLanguage(language)
    auth.value.status = 'authenticated'
    auth.value.session = {
      userId: 'user-1',
      displayName: 'Ada Lovelace',
      roles: [],
      permissions: []
    }

    renderUserMenu()

    expect(screen.getByRole('menuitem', { name: i18n.t('userMenu.officialSite') })).toHaveAttribute(
      'href',
      `https://www.alive.org.tw/${websiteLocale}`
    )
  })

  it('keeps product links out of the Electron menu', () => {
    vi.mocked(isElectron).mockReturnValue(true)
    vi.mocked(isWeb).mockReturnValue(false)
    auth.value.status = 'authenticated'
    auth.value.session = {
      userId: 'user-1',
      displayName: 'Ada Lovelace',
      roles: [],
      permissions: ['cms:pages:read']
    }

    renderUserMenu()

    expect(screen.queryByRole('menuitem', { name: 'Official site' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Admin' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Account management' })).not.toBeInTheDocument()
  })

  it('renders the authenticated account avatar', () => {
    auth.value.status = 'authenticated'
    auth.value.session = {
      userId: 'user-1',
      displayName: 'Ada Lovelace',
      roles: [],
      avatarUrl: 'https://account.example/avatar.png'
    }

    renderUserMenu()

    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toHaveAttribute(
      'src',
      'https://account.example/avatar.png'
    )
  })

  it.each([
    ['signIn', 'Login', 'Unable to sign in'],
    ['signOut', 'Logout', 'Unable to sign out']
  ] as const)('shows a toast when %s fails', async (method, action, message) => {
    if (method === 'signOut') {
      auth.value.status = 'authenticated'
      auth.value.session = { userId: 'user-1', displayName: 'Ada Lovelace', roles: [] }
    }
    auth.value[method] = vi.fn(async () => {
      throw new Error('failed')
    })
    renderUserMenu()

    fireEvent.click(screen.getByText(action).closest('[role="menuitem"]')!)
    await waitFor(() => expect(toastDanger).toHaveBeenCalledWith(message))
  })

  it('close app shows confirm dialog before calling window.close', async () => {
    const closeSpy = vi.fn()
    vi.stubGlobal('close', closeSpy)
    renderUserMenu()
    const closeApp = screen.getByText('Close App').closest('[role="menuitem"]')!
    fireEvent.click(closeApp)
    expect(await screen.findByText('Close Application')).toBeInTheDocument()
    expect(closeSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('preferences calls onOpenPreferences', () => {
    const onOpenPreferences = vi.fn()
    renderUserMenu({ onOpenPreferences })
    const preferences = screen.getByText('Preferences').closest('[role="menuitem"]')!
    fireEvent.click(preferences)
    expect(onOpenPreferences).toHaveBeenCalledOnce()
  })
})
