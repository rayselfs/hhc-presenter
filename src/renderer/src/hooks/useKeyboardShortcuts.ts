import { useEffect, useLayoutEffect, useRef } from 'react'
import { matchesConfig, type ShortcutConfig } from '@renderer/lib/shortcut-config'
import {
  registerShortcut,
  unregisterShortcut,
  isPresenterActive
} from '@renderer/lib/shortcut-registry'
import { useOptionalShortcutScope } from '@renderer/contexts/ShortcutScopeContext'

export interface ShortcutHandler {
  config: ShortcutConfig
  handler: (event: KeyboardEvent) => void
  allowInEditable?: boolean
  preventDefault?: boolean
  stopPropagation?: boolean
  id?: string
  description?: string
}

export interface UseKeyboardShortcutsOptions {
  enabled?: boolean
  sectionKey?: string
}

const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false
  if (INPUT_TAGS.has(target.tagName)) return true
  const contentEditable = target.getAttribute('contenteditable')
  if (contentEditable === 'true') return true
  const role = target.getAttribute('role')
  if ((role === 'textbox' || role === 'searchbox') && contentEditable !== 'false') return true
  return target.parentElement ? isEditableTarget(target.parentElement) : false
}

export function useKeyboardShortcuts(
  shortcuts: ShortcutHandler[],
  options: UseKeyboardShortcutsOptions = {}
): void {
  const { enabled = true, sectionKey } = options

  const { isOverlayActive } = useOptionalShortcutScope()

  const shortcutsRef = useRef<ShortcutHandler[]>(shortcuts)
  const enabledRef = useRef<boolean>(enabled)
  const isOverlayActiveRef = useRef<boolean>(false)
  const shortcutIdsRef = useRef<string[]>([])

  const sectionKeyRef = useRef(sectionKey)

  useLayoutEffect(() => {
    shortcutsRef.current = shortcuts
    enabledRef.current = enabled
    isOverlayActiveRef.current = isOverlayActive
    sectionKeyRef.current = sectionKey
  })

  useEffect(() => {
    const currentShortcuts = shortcutsRef.current
    const currentSectionKey = sectionKeyRef.current
    shortcutIdsRef.current = currentShortcuts.map(
      (shortcut, index) => shortcut.id || `shortcut-${index}`
    )

    currentShortcuts.forEach((shortcut, index) => {
      const id = shortcutIdsRef.current[index]
      registerShortcut({
        id,
        config: shortcut.config,
        description: shortcut.description,
        sectionKey: currentSectionKey
      })
    })

    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (event.isComposing || event.keyCode === 229) return
      if (!enabledRef.current) return
      if (isPresenterActive() && sectionKeyRef.current !== 'media') return
      if (
        event.target instanceof Element &&
        event.target.closest('[role="menu"], [role="dialog"], [role="alertdialog"]')
      ) {
        return
      }

      if (event.code === 'Escape' && document.querySelector('[role="menu"]')) {
        return
      }

      for (const {
        config,
        handler,
        allowInEditable = false,
        preventDefault = true,
        stopPropagation = true
      } of shortcutsRef.current) {
        if (isOverlayActiveRef.current) continue
        if (!allowInEditable && isEditableTarget(event.target)) continue
        if (matchesConfig(event, config)) {
          if (preventDefault) event.preventDefault()
          if (stopPropagation) event.stopPropagation()
          handler(event)
          return
        }
      }
    }

    document.addEventListener('keydown', handleKeydown, true)
    return () => {
      document.removeEventListener('keydown', handleKeydown, true)
      shortcutIdsRef.current.forEach((id) => {
        unregisterShortcut(id)
      })
    }
  }, [])
}
