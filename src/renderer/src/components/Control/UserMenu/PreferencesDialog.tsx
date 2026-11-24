import { useState } from 'react'
import { Modal } from '@heroui/react/modal'
import { useOverlayState } from '@renderer/lib/use-overlay-state'
import { useTranslation } from 'react-i18next'
import {
  Settings,
  Film,
  BookOpen,
  Timer,
  ChevronRight,
  HardDrive,
  AlertTriangle
} from 'lucide-react'
import GeneralSettings from '@renderer/components/Control/UserMenu/GeneralSettings'
import TimerSettings from '@renderer/components/Control/UserMenu/TimerSettings'
import BibleSettingsPanel from '@renderer/components/Control/UserMenu/BibleSettingsPanel'
import RecoveryCenterSettings from '@renderer/components/Control/UserMenu/RecoveryCenterSettings'
import MediaSettings, {
  type MediaSettingsSection
} from '@renderer/components/Control/UserMenu/MediaSettings'
import StorageSettings, {
  type StorageSettingsSection
} from '@renderer/components/Control/UserMenu/StorageSettings'
import { ShortcutScope } from '@renderer/contexts/ShortcutScopeContext'
import { isElectron } from '@renderer/lib/env'

interface PreferencesDialogProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  initialRoute?: 'general' | 'recovery'
}

type Category = 'general' | 'timer' | 'bible' | 'media' | 'storage' | 'recovery'
type PreferenceRoute =
  | 'general'
  | 'timer'
  | 'bible'
  | 'recovery'
  | `media.${MediaSettingsSection}`
  | `storage.${StorageSettingsSection}`

interface CategoryChildItem {
  id: PreferenceRoute
  labelKey:
    | 'preferences.media.sections.general'
    | 'preferences.media.sections.oneDrive'
    | 'preferences.media.sections.lanRemote'
    | 'preferences.storage.sections.usage'
    | 'preferences.storage.sections.cleanup'
}

interface CategoryItem {
  id: Category
  icon: React.ComponentType<{ className?: string }>
  labelKey:
    | 'preferences.categories.general'
    | 'preferences.categories.timer'
    | 'preferences.categories.media'
    | 'preferences.categories.bible'
    | 'preferences.categories.storage'
    | 'preferences.categories.recovery'
  route: PreferenceRoute
  children?: CategoryChildItem[]
}

export default function PreferencesDialog({
  isOpen,
  onOpenChange,
  initialRoute = 'general'
}: PreferencesDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [activeRoute, setActiveRoute] = useState<PreferenceRoute>(initialRoute)
  const [expandedCategory, setExpandedCategory] = useState<Category | null>(null)
  const [isClearingAllData, setIsClearingAllData] = useState(false)
  const mediaChildren: CategoryChildItem[] = [
    { id: 'media.general', labelKey: 'preferences.media.sections.general' },
    { id: 'media.oneDrive', labelKey: 'preferences.media.sections.oneDrive' },
    ...(isElectron()
      ? ([
          { id: 'media.lanRemote', labelKey: 'preferences.media.sections.lanRemote' }
        ] satisfies CategoryChildItem[])
      : [])
  ]
  const categories: CategoryItem[] = [
    { id: 'general', icon: Settings, labelKey: 'preferences.categories.general', route: 'general' },
    { id: 'timer', icon: Timer, labelKey: 'preferences.categories.timer', route: 'timer' },
    { id: 'bible', icon: BookOpen, labelKey: 'preferences.categories.bible', route: 'bible' },
    {
      id: 'media',
      icon: Film,
      labelKey: 'preferences.categories.media',
      route: 'media.general',
      children: mediaChildren
    },
    {
      id: 'storage',
      icon: HardDrive,
      labelKey: 'preferences.categories.storage',
      route: 'storage.usage',
      children: [
        { id: 'storage.usage', labelKey: 'preferences.storage.sections.usage' },
        { id: 'storage.cleanup', labelKey: 'preferences.storage.sections.cleanup' }
      ]
    },
    {
      id: 'recovery',
      icon: AlertTriangle,
      labelKey: 'preferences.categories.recovery',
      route: 'recovery'
    }
  ]

  const state = useOverlayState({ isOpen, onOpenChange })

  return (
    <Modal.Root state={state}>
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog className="overflow-hidden p-0">
            <Modal.Body className="p-0">
              <ShortcutScope name="overlay">
                <div className="flex" style={{ height: '480px' }}>
                  <nav className="flex w-44 shrink-0 flex-col gap-2 rounded-tr-3xl rounded-br-3xl bg-surface-secondary text-foreground py-2 px-2">
                    <ul className="flex flex-col gap-1">
                      {categories.map((cat) => {
                        const expanded = cat.children ? expandedCategory === cat.id : false
                        const active = !cat.children && activeRoute === cat.route
                        const Icon = cat.icon
                        return (
                          <li key={cat.id}>
                            <button
                              type="button"
                              aria-pressed={active}
                              disabled={isClearingAllData}
                              className={`flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-colors ${
                                active
                                  ? 'bg-accent text-accent-foreground'
                                  : 'text-muted hover:opacity-70'
                              }`}
                              onClick={() => {
                                if (cat.children) {
                                  setExpandedCategory(expanded ? null : cat.id)
                                  if (!expanded && !activeRoute.startsWith(`${cat.id}.`)) {
                                    setActiveRoute(cat.route)
                                  }
                                  return
                                }
                                setExpandedCategory(null)
                                setActiveRoute(cat.route)
                              }}
                              data-testid={`category-${cat.id}`}
                            >
                              <Icon className="size-4" />
                              <span>{t(cat.labelKey)}</span>
                              {cat.children && (
                                <ChevronRight
                                  className={`ml-auto size-4 transition-transform ${
                                    expanded ? 'rotate-90' : ''
                                  }`}
                                />
                              )}
                            </button>
                            {cat.children && expanded && (
                              <ul className="mt-1 flex flex-col gap-1 pl-7">
                                {cat.children.map((child) => {
                                  const childActive = activeRoute === child.id
                                  return (
                                    <li key={child.id}>
                                      <button
                                        type="button"
                                        aria-pressed={childActive}
                                        disabled={isClearingAllData}
                                        className={`w-full rounded-full px-3 py-2 text-left text-sm font-medium transition-colors ${
                                          childActive
                                            ? 'bg-accent text-accent-foreground'
                                            : 'text-muted hover:opacity-70'
                                        }`}
                                        onClick={() => {
                                          setExpandedCategory(cat.id)
                                          setActiveRoute(child.id)
                                        }}
                                        data-testid={`category-${child.id.replace('.', '-')}`}
                                      >
                                        {t(child.labelKey)}
                                      </button>
                                    </li>
                                  )
                                })}
                              </ul>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </nav>
                  <div className="flex-1 overflow-y-auto p-0">
                    {activeRoute === 'general' && (
                      <GeneralSettings
                        isClearingAllData={isClearingAllData}
                        onClearingAllDataChange={setIsClearingAllData}
                      />
                    )}
                    {activeRoute === 'timer' && <TimerSettings />}
                    {activeRoute === 'bible' && <BibleSettingsPanel onOpenBible={state.close} />}
                    {activeRoute === 'media.general' && <MediaSettings section="general" />}
                    {activeRoute === 'media.oneDrive' && <MediaSettings section="oneDrive" />}
                    {activeRoute === 'media.lanRemote' && <MediaSettings section="lanRemote" />}
                    {activeRoute === 'storage.usage' && <StorageSettings section="usage" />}
                    {activeRoute === 'storage.cleanup' && <StorageSettings section="cleanup" />}
                    {activeRoute === 'recovery' && <RecoveryCenterSettings />}
                  </div>
                </div>
              </ShortcutScope>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  )
}
