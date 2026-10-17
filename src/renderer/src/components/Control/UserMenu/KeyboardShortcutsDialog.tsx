import { useState } from 'react'
import { Modal } from '@heroui/react/modal'
import { useOverlayState } from '@renderer/lib/use-overlay-state'
import { useTranslation } from 'react-i18next'
import { Timer, BookOpen, Film, Monitor, Camera } from 'lucide-react'
import { SHORTCUTS } from '@renderer/config/shortcuts'
import { getMetaKeyLabel } from '@renderer/lib/env'
import { ShortcutConfig, getPlatformShortcut } from '@renderer/lib/shortcut-config'
import { ShortcutScope } from '@renderer/contexts/ShortcutScopeContext'

interface KeyboardShortcutsDialogProps {
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
}

const KEY_DISPLAY_MAP: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
  Escape: 'Esc',
  Backspace: '⌫',
  Delete: 'Del',
  Enter: 'Enter',
  Tab: 'Tab',
  Shift: 'Shift',
  Control: 'Ctrl',
  Alt: 'Alt',
  Meta: '⌘'
}

const getDisplayKey = (code: string): string => {
  if (KEY_DISPLAY_MAP[code]) {
    return KEY_DISPLAY_MAP[code]
  }
  if (code.startsWith('Key')) {
    return code.slice(3).toUpperCase()
  }
  return code
}

type SectionId = 'projection' | 'timer' | 'bible' | 'media' | 'camera'

interface SectionItem {
  id: SectionId
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
  shortcuts: Record<string, ShortcutConfig>
}

const SECTIONS: SectionItem[] = [
  {
    id: 'projection',
    icon: Monitor,
    labelKey: 'shortcuts.sections.projection',
    shortcuts: SHORTCUTS.PROJECTION
  },
  { id: 'timer', icon: Timer, labelKey: 'shortcuts.sections.timer', shortcuts: SHORTCUTS.TIMER },
  { id: 'bible', icon: BookOpen, labelKey: 'shortcuts.sections.bible', shortcuts: SHORTCUTS.BIBLE },
  {
    id: 'camera',
    icon: Camera,
    labelKey: 'shortcuts.sections.camera',
    shortcuts: SHORTCUTS.CAMERA
  },
  { id: 'media', icon: Film, labelKey: 'shortcuts.sections.media', shortcuts: SHORTCUTS.MEDIA }
]

function buildKeysFromConfig(config: ShortcutConfig): string[] {
  const resolved = getPlatformShortcut(config)
  const keyParts: string[] = []
  if (resolved.metaOrCtrl) {
    keyParts.push(getMetaKeyLabel())
  }
  if (resolved.meta && !resolved.metaOrCtrl) {
    keyParts.push('⌘')
  }
  if (resolved.ctrl && !resolved.metaOrCtrl) {
    keyParts.push('Ctrl')
  }
  if (resolved.shift) {
    keyParts.push('Shift')
  }
  if (resolved.alt) {
    keyParts.push('Alt')
  }
  keyParts.push(getDisplayKey(resolved.code))
  return keyParts
}

function ShortcutRow({ label, keys }: { label: string; keys: string[] }): React.JSX.Element {
  return (
    <div className="flex justify-between items-center py-2 px-3 hover:bg-default-100 rounded-lg transition-colors">
      <span className="text-sm">{label}</span>
      <div className="flex gap-1">
        {keys.map((key) => (
          <kbd
            key={key}
            className="px-2 py-1 text-xs font-semibold bg-default-200 border border-default-300 rounded"
          >
            {key}
          </kbd>
        ))}
      </div>
    </div>
  )
}

export default function KeyboardShortcutsDialog({
  isOpen,
  onOpenChange
}: KeyboardShortcutsDialogProps): React.JSX.Element {
  const { t: translate } = useTranslation()
  const t = translate as (key: string) => string
  const [activeSection, setActiveSection] = useState<SectionId>('projection')
  const state = useOverlayState({ isOpen, onOpenChange })

  const current = SECTIONS.find((s) => s.id === activeSection)!
  const entries = Object.entries(current.shortcuts).map(([key, config]) => ({
    label: t(`shortcuts.${current.id}.${key.toLowerCase()}`),
    keys: buildKeysFromConfig(config)
  }))

  return (
    <Modal.Root state={state}>
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog className="overflow-hidden p-0">
            <Modal.Body className="p-0">
              <ShortcutScope name="overlay">
                <div className="flex" style={{ height: '380px' }}>
                  <nav className="flex w-44 shrink-0 flex-col gap-2 rounded-tr-3xl rounded-br-3xl bg-surface-secondary text-foreground py-2 px-2">
                    <ul className="flex flex-col gap-1">
                      {SECTIONS.map((section) => {
                        const active = activeSection === section.id
                        const Icon = section.icon
                        return (
                          <li key={section.id}>
                            <button
                              type="button"
                              aria-pressed={active}
                              className={`flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-colors ${
                                active
                                  ? 'bg-accent text-accent-foreground'
                                  : 'text-muted hover:opacity-70'
                              }`}
                              onClick={() => setActiveSection(section.id)}
                            >
                              <Icon className="size-4" />
                              <span>{t(section.labelKey)}</span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </nav>
                  <div className="flex-1 overflow-y-auto p-5">
                    <h3 className="text-sm font-semibold mb-3">{t(current.labelKey)}</h3>
                    <div className="space-y-1">
                      {entries.map((entry) => (
                        <ShortcutRow key={entry.label} label={entry.label} keys={entry.keys} />
                      ))}
                    </div>
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
