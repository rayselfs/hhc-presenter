import { Avatar } from '@heroui/react/avatar'
import { Button } from '@heroui/react/button'
import { Dropdown } from '@renderer/components/Common/MenuPopover'
import { toast } from '@heroui/react/toast'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  LogIn,
  LogOut,
  Settings,
  RefreshCw,
  Keyboard,
  Power,
  CircleUser,
  Info,
  X,
  House,
  ShieldCheck,
  UserRound
} from 'lucide-react'
import { useConfirm } from '@renderer/contexts/ConfirmDialogContext'
import KeyboardShortcutsDialog from '@renderer/components/Control/UserMenu/KeyboardShortcutsDialog'
import AboutDialog from '@renderer/components/Control/UserMenu/AboutDialog'
import MacUpdateInstallDialog from '@renderer/components/Control/UserMenu/MacUpdateInstallDialog'
import { usePresentationSafeAction } from '@renderer/components/Control/PresentationNavigationGuard'
import { useHhcAuth } from '@renderer/contexts/HhcAuthContext'
import { isElectron, isMac, isWeb } from '@renderer/lib/env'
import { useUpdateStore } from '@renderer/stores/update'
import { selectUpdateStatus, selectAvailableVersion } from '@renderer/stores/selectors/update'
import { canAccessHhcAdmin } from '@renderer/lib/hhc-permissions'

interface UserMenuProps {
  isExpanded: boolean
  onOpenPreferences?: () => void
}

const glassDividerClass = [
  'relative mt-1 pt-1',
  'before:content-[""] before:absolute before:top-0 before:left-0 before:right-0 before:h-px',
  'before:h-[2px]',
  'before:bg-[linear-gradient(90deg,transparent_0%,var(--separator)_20%,var(--separator)_80%,transparent_100%)]'
].join(' ')

export default function UserMenu({
  isExpanded,
  onOpenPreferences
}: UserMenuProps): React.JSX.Element {
  const { i18n, t } = useTranslation()
  const [isShortcutsOpen, setShortcutsOpen] = useState(false)
  const [isAboutOpen, setAboutOpen] = useState(false)
  const confirm = useConfirm()
  const runPresentationSafeAction = usePresentationSafeAction()
  const updateStatus = useUpdateStore(selectUpdateStatus)
  const availableVersion = useUpdateStore(selectAvailableVersion)
  const downloadPercent = useUpdateStore((state) => state.downloadPercent)
  const isMacPlatform = isMac()
  const canUseUpdateAction =
    (isMacPlatform && updateStatus === 'available') ||
    (!isMacPlatform && updateStatus === 'downloaded')
  const { status, session, signInStatus, signIn, cancelSignIn, signOut } = useHhcAuth()
  const accountLabel =
    status === 'authenticated' && session ? session.displayName : t('userMenu.guest')
  const websiteLocale =
    i18n.resolvedLanguage === 'zh-TW'
      ? 'zh-Hant'
      : i18n.resolvedLanguage === 'zh-CN'
        ? 'zh-Hans'
        : 'en'

  const avatarInitials =
    accountLabel
      .split('@')[0]
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '?'

  const handleCloseApp = async (): Promise<void> => {
    const confirmed = await confirm({
      status: 'danger',
      title: t('userMenu.closeAppTitle'),
      description: t('userMenu.closeAppConfirm'),
      confirmLabel: t('common.close'),
      cancelLabel: t('common.cancel')
    })
    if (!confirmed) return
    await runPresentationSafeAction(() => window.close())
  }

  const handleUpdateAction = async (): Promise<void> => {
    if (isMacPlatform && updateStatus === 'available') {
      useUpdateStore.getState().setDownloading()
      await window.api.update.downloadMacInstaller()
      return
    }
    if (isMacPlatform || updateStatus !== 'downloaded') return

    const confirmed = await confirm({
      status: 'info',
      title: t('userMenu.installUpdateTitle'),
      description: t('userMenu.installUpdateConfirm'),
      confirmLabel: t('userMenu.installNow'),
      cancelLabel: t('common.cancel')
    })
    if (confirmed) await window.api.update.installDownloaded()
  }

  const updateLabel = (): string => {
    if (updateStatus === 'idle' || updateStatus === 'checking') return t('userMenu.checking')
    if (updateStatus === 'not-available') return t('userMenu.upToDate')
    if (updateStatus === 'available' || updateStatus === 'downloaded') {
      return t('userMenu.updateAvailable', {
        version: availableVersion
      })
    }
    if (updateStatus === 'downloading') {
      return downloadPercent === null
        ? t('userMenu.downloadingUpdate')
        : t('userMenu.downloadingUpdateProgress', { percent: downloadPercent })
    }
    if (updateStatus === 'verifying') return t('userMenu.verifyingUpdate')
    if (updateStatus === 'installer-opened') return t('userMenu.installerOpened')
    if (updateStatus === 'error') return t('userMenu.updateFailed')
    return t('userMenu.upToDate')
  }

  return (
    <>
      <Dropdown.Root>
        <div className="flex w-full items-center">
          <Button
            variant="ghost"
            aria-label={t('userMenu.accountMenu', { name: accountLabel })}
            className={`flex h-auto min-w-0 items-center justify-start gap-2 rounded-full p-0 text-muted hover:opacity-70 ${isExpanded ? 'flex-1' : 'w-auto'}`}
          >
            <Avatar.Root className="shrink-0">
              {session?.avatarUrl ? (
                <Avatar.Image src={session.avatarUrl} alt={accountLabel} />
              ) : null}
              <Avatar.Fallback>
                {status === 'authenticated' && session ? avatarInitials : <CircleUser />}
              </Avatar.Fallback>
            </Avatar.Root>
            {isExpanded && <span>{accountLabel}</span>}
          </Button>
        </div>
        <Dropdown.Popover>
          <Dropdown.Menu
            onAction={(key) => {
              if (key === 'login') {
                void signIn().catch(() => toast.danger(t('userMenu.signInFailed')))
              }
              if (key === 'cancelLogin') {
                void cancelSignIn().catch(() => toast.danger(t('userMenu.signInFailed')))
              }
              if (key === 'logout') {
                void signOut().catch(() => toast.danger(t('userMenu.signOutFailed')))
              }
              if (key === 'preferences') onOpenPreferences?.()
              if (key === 'closeApp') handleCloseApp()
              if (key === 'keyboardShortcuts') setShortcutsOpen(true)
              if (key === 'about') setAboutOpen(true)
              if (key === 'updateAction' && canUseUpdateAction) {
                void handleUpdateAction().catch((error: unknown) => {
                  useUpdateStore
                    .getState()
                    .setError(error instanceof Error ? error.message : 'Unknown error')
                })
              }
            }}
          >
            {status === 'authenticated' && session ? (
              <>
                <Dropdown.Item key="accountIdentity" id="accountIdentity" isDisabled>
                  <CircleUser className="size-4" />
                  {session.displayName}
                </Dropdown.Item>
                <Dropdown.Item
                  key="logout"
                  id="logout"
                  className="data-[hovered=true]:bg-accent data-[hovered=true]:text-accent-foreground"
                >
                  <LogOut className="size-4" />
                  {t('userMenu.logout')}
                </Dropdown.Item>
              </>
            ) : status === 'anonymous' ? (
              signInStatus === 'pending' ? (
                <>
                  <Dropdown.Item key="signInPending" id="signInPending" isDisabled>
                    <RefreshCw className="size-4 animate-spin" />
                    {t('userMenu.signInPending')}
                  </Dropdown.Item>
                  <Dropdown.Item
                    key="cancelLogin"
                    id="cancelLogin"
                    className="data-[hovered=true]:bg-accent data-[hovered=true]:text-accent-foreground"
                  >
                    <X className="size-4" />
                    {t('userMenu.cancelSignIn')}
                  </Dropdown.Item>
                </>
              ) : (
                <>
                  {signInStatus !== 'idle' && (
                    <Dropdown.Item key="signInFeedback" id="signInFeedback" isDisabled>
                      <Info className="size-4" />
                      {t(
                        signInStatus === 'cancelled'
                          ? 'userMenu.signInCancelled'
                          : 'userMenu.signInExpired'
                      )}
                    </Dropdown.Item>
                  )}
                  <Dropdown.Item
                    key="login"
                    id="login"
                    className="data-[hovered=true]:bg-accent data-[hovered=true]:text-accent-foreground"
                  >
                    <LogIn className="size-4" />
                    {t('userMenu.login')}
                  </Dropdown.Item>
                </>
              )
            ) : (
              <Dropdown.Item key="accountStatus" id="accountStatus" isDisabled>
                <RefreshCw className={`size-4 ${status === 'loading' ? 'animate-spin' : ''}`} />
                {status === 'loading'
                  ? t('userMenu.loadingAccount')
                  : t('userMenu.accountUnavailable')}
              </Dropdown.Item>
            )}
            <Dropdown.Item
              id="preferences"
              className={`data-[hovered=true]:bg-accent data-[hovered=true]:text-accent-foreground ${glassDividerClass}`}
            >
              <Settings className="size-4" />
              {t('userMenu.preferences')}
            </Dropdown.Item>
            <Dropdown.Item
              id="keyboardShortcuts"
              className="data-[hovered=true]:bg-accent data-[hovered=true]:text-accent-foreground"
            >
              <Keyboard className="size-4" />
              {t('userMenu.keyboardShortcuts')}
            </Dropdown.Item>
            {status === 'authenticated' && session && isWeb() ? (
              <>
                <Dropdown.Item
                  id="officialSite"
                  href={`https://www.alive.org.tw/${websiteLocale}`}
                  className={`data-[hovered=true]:bg-accent data-[hovered=true]:text-accent-foreground ${glassDividerClass}`}
                >
                  <House className="size-4" />
                  {t('userMenu.officialSite')}
                </Dropdown.Item>
                {canAccessHhcAdmin(session.permissions) ? (
                  <Dropdown.Item
                    id="adminManagement"
                    href="https://admin.alive.org.tw/"
                    className="data-[hovered=true]:bg-accent data-[hovered=true]:text-accent-foreground"
                  >
                    <ShieldCheck className="size-4" />
                    {t('userMenu.adminManagement')}
                  </Dropdown.Item>
                ) : null}
                <Dropdown.Item
                  id="accountManagement"
                  href="https://account.alive.org.tw/profile"
                  className="data-[hovered=true]:bg-accent data-[hovered=true]:text-accent-foreground"
                >
                  <UserRound className="size-4" />
                  {t('userMenu.accountManagement')}
                </Dropdown.Item>
              </>
            ) : null}
            <Dropdown.Item
              id="about"
              className={`data-[hovered=true]:bg-accent data-[hovered=true]:text-accent-foreground ${glassDividerClass}`}
            >
              <Info className="size-4" />
              {t('about.title')}
            </Dropdown.Item>
            {isElectron() && (
              <Dropdown.Item
                id="updateAction"
                isDisabled={!canUseUpdateAction}
                className="data-[hovered=true]:bg-accent data-[hovered=true]:text-accent-foreground"
              >
                <RefreshCw className="size-4" />
                {updateLabel()}
              </Dropdown.Item>
            )}
            <Dropdown.Item
              id="closeApp"
              className={`text-danger data-[hovered=true]:bg-accent ${glassDividerClass}`}
            >
              <Power className="size-4" />
              {t('userMenu.closeApp')}
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      {isShortcutsOpen && (
        <KeyboardShortcutsDialog isOpen={isShortcutsOpen} onOpenChange={setShortcutsOpen} />
      )}
      {isAboutOpen && <AboutDialog isOpen={isAboutOpen} onOpenChange={setAboutOpen} />}
      {isMacPlatform && updateStatus === 'installer-opened' && (
        <MacUpdateInstallDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) useUpdateStore.getState().reset()
          }}
        />
      )}
    </>
  )
}
