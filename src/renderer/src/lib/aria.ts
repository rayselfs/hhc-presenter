import { isMac } from './env'
import { getPlatformShortcut } from '@renderer/lib/shortcut-config'
import type { ShortcutConfig } from '@renderer/lib/shortcut-config'

export function formatAriaShortcut(config: ShortcutConfig): string {
  const resolved = getPlatformShortcut(config)

  const modifiers: string[] = []

  // WAI-ARIA modifier order: Meta, Control, Shift, Alt
  if (resolved.meta) {
    modifiers.push('Meta')
  }

  if (resolved.metaOrCtrl) {
    modifiers.push(isMac() ? 'Meta' : 'Control')
  } else if (resolved.ctrl) {
    modifiers.push('Control')
  }

  if (resolved.shift) {
    modifiers.push('Shift')
  }

  if (resolved.alt) {
    modifiers.push('Alt')
  }

  // Convert KeyX to just X, leave others as-is
  let keyName = resolved.code
  if (keyName.startsWith('Key') && keyName.length === 4) {
    keyName = keyName[3]
  }

  if (modifiers.length === 0) {
    return keyName
  }

  return modifiers.join('+') + '+' + keyName
}
