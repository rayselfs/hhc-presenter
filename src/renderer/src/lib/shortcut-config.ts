import { isMac } from './env'

export interface ShortcutConfig {
  code: string
  shift?: boolean
  ctrl?: boolean
  meta?: boolean
  alt?: boolean
  metaOrCtrl?: boolean
  mac?: Partial<ShortcutConfig>
  windows?: Partial<ShortcutConfig>
}

export function getPlatformShortcut(config: ShortcutConfig): ShortcutConfig {
  const mac = isMac()
  if (mac && config.mac) {
    return { ...config, ...config.mac }
  }
  if (!mac && config.windows) {
    return { ...config, ...config.windows }
  }
  return config
}

export function matchesConfig(event: KeyboardEvent, config: ShortcutConfig): boolean {
  const resolved = getPlatformShortcut(config)

  if (resolved.ctrl !== undefined && event.ctrlKey !== resolved.ctrl) return false
  if (resolved.meta !== undefined && event.metaKey !== resolved.meta) return false
  if (resolved.shift !== undefined && event.shiftKey !== resolved.shift) return false
  if (resolved.alt !== undefined && event.altKey !== resolved.alt) return false

  if (resolved.metaOrCtrl) {
    if (!event.metaKey && !event.ctrlKey) return false
  }

  // Reject modified keypresses when shortcut doesn't expect modifiers
  if (!resolved.metaOrCtrl && resolved.ctrl === undefined && resolved.meta === undefined) {
    if (event.ctrlKey || event.metaKey) return false
  }
  if (resolved.shift === undefined) {
    if (event.shiftKey) return false
  }
  if (resolved.alt === undefined) {
    if (event.altKey) return false
  }

  if (event.code !== resolved.code) return false

  return true
}
