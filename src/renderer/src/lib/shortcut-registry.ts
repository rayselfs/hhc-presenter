import { ShortcutConfig, getPlatformShortcut } from '@renderer/lib/shortcut-config'

export interface RegistryEntry {
  id: string
  config: ShortcutConfig
  description?: string
  sectionKey?: string
}

const registry = new Map<string, RegistryEntry[]>()

function serializeConfig(config: ShortcutConfig): string {
  const resolved = getPlatformShortcut(config)

  const parts: string[] = []

  if (resolved.code) parts.push(`code:${resolved.code}`)
  if (resolved.ctrl !== undefined) parts.push(`ctrl:${resolved.ctrl}`)
  if (resolved.meta !== undefined) parts.push(`meta:${resolved.meta}`)
  if (resolved.shift !== undefined) parts.push(`shift:${resolved.shift}`)
  if (resolved.alt !== undefined) parts.push(`alt:${resolved.alt}`)
  if (resolved.metaOrCtrl !== undefined) parts.push(`metaOrCtrl:${resolved.metaOrCtrl}`)

  parts.sort()
  return parts.join('|')
}

export function registerShortcut(entry: RegistryEntry): void {
  const key = serializeConfig(entry.config)

  if (!registry.has(key)) {
    registry.set(key, [])
  }

  const entries = registry.get(key)!

  // Idempotent: skip if same ID already registered (handles React StrictMode double-mount)
  if (entries.some((e) => e.id === entry.id)) return

  entries.push(entry)

  if (import.meta.env.DEV && entries.length > 1) {
    const sameSectionEntries = entries.filter((e) => e.sectionKey === entry.sectionKey)
    if (sameSectionEntries.length > 1) {
      const ids = sameSectionEntries.map((e) => e.id).join(', ')
      console.warn(
        `Shortcut conflict detected for key "${key}": ${ids}. Multiple shortcuts are bound to the same key combination.`
      )
    }
  }
}

export function unregisterShortcut(id: string): void {
  for (const entries of registry.values()) {
    const index = entries.findIndex((e) => e.id === id)
    if (index !== -1) {
      entries.splice(index, 1)
      break
    }
  }
}

export function getRegistered(): RegistryEntry[] {
  const result: RegistryEntry[] = []
  for (const entries of registry.values()) {
    result.push(...entries)
  }
  return result
}

export function clearRegistry(): void {
  registry.clear()
}

let presenterActive = false

export function setPresenterActive(active: boolean): void {
  presenterActive = active
}

export function isPresenterActive(): boolean {
  return presenterActive
}
