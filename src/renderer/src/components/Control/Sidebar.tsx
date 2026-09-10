import { useState, useEffect } from 'react'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { useTranslation } from 'react-i18next'
import { useLocation, Link, useNavigate } from 'react-router-dom'
import {
  Timer,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Film,
  Star,
  Trash2,
  Files,
  Camera,
  Cloud,
  UsersRound
} from 'lucide-react'
import { Dropdown } from '@renderer/components/Common/MenuPopover'
import UserMenu from '@renderer/components/Control/UserMenu/UserMenu'
import PreferencesDialog from '@renderer/components/Control/UserMenu/PreferencesDialog'
import { usePresentationSafeAction } from '@renderer/components/Control/PresentationNavigationGuard'

interface NavItem {
  to: string
  icon: React.ComponentType<{ className?: string }>
  label: string
}

interface MediaSubItem {
  to: string
  icon: React.ComponentType<{ className?: string; size?: number }>
  labelKey: 'nav.files' | 'nav.favorites' | 'nav.trash' | 'nav.cloudFiles' | 'nav.sharedFiles'
  disabled: boolean
}

const MEDIA_SUB_ITEMS: MediaSubItem[] = [
  { to: '/files', icon: Files, labelKey: 'nav.files', disabled: false },
  { to: '/cloud-files', icon: Cloud, labelKey: 'nav.cloudFiles', disabled: true },
  { to: '/shared-files', icon: UsersRound, labelKey: 'nav.sharedFiles', disabled: true },
  { to: '/favorites', icon: Star, labelKey: 'nav.favorites', disabled: false },
  { to: '/trash', icon: Trash2, labelKey: 'nav.trash', disabled: false }
]

function useIsCollapsed(): boolean {
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 1023px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)')
    const handler = (e: MediaQueryListEvent): void => setCollapsed(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return collapsed
}

export default function Sidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const cloudOwnerId = usePersonalSyncStore((state) => state.activeOwnerId)
  const mediaItems = MEDIA_SUB_ITEMS.map((item) =>
    item.to === '/cloud-files' || item.to === '/shared-files'
      ? { ...item, disabled: !cloudOwnerId }
      : item
  )
  const location = useLocation()
  const navigate = useNavigate()
  const runPresentationSafeAction = usePresentationSafeAction()
  const isCollapsed = useIsCollapsed()
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [initialPreferenceRoute, setInitialPreferenceRoute] = useState<'general' | 'recovery'>(
    'general'
  )
  const [mediaOpen, setMediaOpen] = useState(true)

  useEffect(() => {
    const openRecoveryCenter = (): void => {
      setInitialPreferenceRoute('recovery')
      setPrefsOpen(true)
    }
    window.addEventListener('hhc:open-recovery-center', openRecoveryCenter)
    return () => window.removeEventListener('hhc:open-recovery-center', openRecoveryCenter)
  }, [])

  const topItems: NavItem[] = [
    { to: '/timer', icon: Timer, label: t('nav.timer') },
    { to: '/bible', icon: BookOpen, label: t('nav.bible') },
    { to: '/camera', icon: Camera, label: t('camera.title') }
  ]

  const isActive = (to: string): boolean => location.pathname === to

  const activeSubItem = mediaItems.find((item) => location.pathname === item.to)
  const MediaGroupIcon = activeSubItem ? activeSubItem.icon : Film
  const navigateSafely = (path: string): void => {
    void runPresentationSafeAction(() => navigate(path))
  }
  const handleLinkClick = (event: React.MouseEvent, path: string): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return
    event.preventDefault()
    navigateSafely(path)
  }

  return (
    <nav className="shrink-0 flex flex-col rounded-tr-3xl rounded-br-3xl bg-surface text-foreground py-2 px-2 w-[180px] max-lg:w-[54px]">
      <ul className="flex flex-col gap-1">
        {topItems.map((item) => {
          const active = isActive(item.to)
          const Icon = item.icon
          return (
            <li key={item.to}>
              <Link
                to={item.to}
                draggable={false}
                aria-label={item.label}
                onClick={(event) => handleLinkClick(event, item.to)}
                className={`flex cursor-default items-center gap-3 rounded-full px-3 py-2 max-lg:justify-center max-lg:px-2 ${active ? 'bg-accent text-accent-foreground' : 'text-muted hover:opacity-70'}`}
              >
                <Icon className="size-5 shrink-0" />
                <span className="max-lg:hidden">{item.label}</span>
              </Link>
            </li>
          )
        })}

        <li>
          {isCollapsed ? (
            <Dropdown.Root>
              <Dropdown.Trigger>
                <div
                  className={`flex w-full cursor-default items-center justify-center rounded-full px-2 py-2 ${activeSubItem ? 'bg-accent text-accent-foreground' : 'text-muted hover:opacity-70'}`}
                >
                  <MediaGroupIcon className="size-5 shrink-0" />
                </div>
              </Dropdown.Trigger>
              <Dropdown.Popover>
                <Dropdown.Menu onAction={(key) => navigateSafely(String(key))}>
                  {mediaItems.map(({ to, icon: Icon, labelKey, disabled }) => (
                    <Dropdown.Item
                      key={to}
                      id={to}
                      isDisabled={disabled}
                      className="data-[hovered=true]:bg-accent data-[hovered=true]:text-accent-foreground"
                    >
                      <Icon size={16} />
                      {t(labelKey)}
                    </Dropdown.Item>
                  ))}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.Root>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setMediaOpen((prev) => !prev)}
                className="flex w-full cursor-default items-center gap-3 rounded-full px-3 py-2 text-muted hover:opacity-70"
              >
                <Film className="size-5 shrink-0" />
                <span className="flex-1 text-left">{t('nav.media')}</span>
                <span className="shrink-0">
                  {mediaOpen ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                </span>
              </button>
              {mediaOpen && (
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {mediaItems.map(({ to, icon: Icon, labelKey, disabled }) =>
                    disabled ? (
                      <li key={to}>
                        <button
                          type="button"
                          disabled
                          className="flex w-full cursor-default items-center gap-3 rounded-full py-1.5 pl-7 pr-3 text-sm text-muted opacity-40"
                        >
                          <Icon className="size-4 shrink-0" />
                          <span>{t(labelKey)}</span>
                        </button>
                      </li>
                    ) : (
                      <li key={to}>
                        <Link
                          to={to}
                          draggable={false}
                          onClick={(event) => handleLinkClick(event, to)}
                          className={`flex cursor-default items-center gap-3 rounded-full py-1.5 pl-7 pr-3 text-sm ${isActive(to) ? 'bg-accent text-accent-foreground' : 'text-muted hover:opacity-70'}`}
                        >
                          <Icon className="size-4 shrink-0" />
                          <span>{t(labelKey)}</span>
                        </Link>
                      </li>
                    )
                  )}
                </ul>
              )}
            </>
          )}
        </li>
      </ul>

      <div className="mt-auto">
        <UserMenu
          isExpanded={!isCollapsed}
          onOpenPreferences={() => {
            setInitialPreferenceRoute('general')
            setPrefsOpen(true)
          }}
        />
      </div>
      {prefsOpen && (
        <PreferencesDialog
          isOpen={prefsOpen}
          onOpenChange={setPrefsOpen}
          initialRoute={initialPreferenceRoute}
        />
      )}
    </nav>
  )
}
