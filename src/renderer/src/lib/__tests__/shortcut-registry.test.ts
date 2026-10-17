import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  registerShortcut,
  unregisterShortcut,
  getRegistered,
  clearRegistry,
  RegistryEntry
} from '../shortcut-registry'
import { ShortcutConfig } from '@renderer/lib/shortcut-config'

describe('shortcut-registry', () => {
  beforeEach(() => {
    clearRegistry()
  })

  afterEach(() => {
    clearRegistry()
    vi.unstubAllEnvs()
  })

  it('registers a shortcut and returns it from getRegistered()', () => {
    const entry: RegistryEntry = {
      id: 'timer-toggle',
      config: { code: 'Space' },
      description: 'Toggle timer'
    }

    registerShortcut(entry)

    const registered = getRegistered()
    expect(registered).toHaveLength(1)
    expect(registered[0]).toEqual(entry)
  })

  it('unregisters a shortcut', () => {
    const entry: RegistryEntry = {
      id: 'timer-toggle',
      config: { code: 'Space' },
      description: 'Toggle timer'
    }

    registerShortcut(entry)
    expect(getRegistered()).toHaveLength(1)

    unregisterShortcut('timer-toggle')
    expect(getRegistered()).toHaveLength(0)
  })

  it('warns on duplicate key combo in dev mode', () => {
    vi.stubEnv('DEV', true)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const entry1: RegistryEntry = {
      id: 'shortcut-1',
      config: { code: 'Space' },
      description: 'First'
    }

    const entry2: RegistryEntry = {
      id: 'shortcut-2',
      config: { code: 'Space' },
      description: 'Second'
    }

    registerShortcut(entry1)
    registerShortcut(entry2)

    expect(warnSpy).toHaveBeenCalled()
    const calls = warnSpy.mock.calls
    const warnCall = calls.find((call) => call[0]?.includes?.('Shortcut conflict'))
    expect(warnCall).toBeDefined()
    expect(warnCall?.[0]).toContain('shortcut-1')
    expect(warnCall?.[0]).toContain('shortcut-2')

    warnSpy.mockRestore()
  })

  it('does not warn in production mode', () => {
    vi.stubEnv('DEV', false)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const entry1: RegistryEntry = {
      id: 'shortcut-1',
      config: { code: 'Space' }
    }

    const entry2: RegistryEntry = {
      id: 'shortcut-2',
      config: { code: 'Space' }
    }

    registerShortcut(entry1)
    registerShortcut(entry2)

    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('does not warn after conflict source unregisters', () => {
    vi.stubEnv('DEV', true)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const entryA: RegistryEntry = {
      id: 'shortcut-a',
      config: { code: 'Space' }
    }

    const entryB: RegistryEntry = {
      id: 'shortcut-b',
      config: { code: 'Space' }
    }

    const entryC: RegistryEntry = {
      id: 'shortcut-c',
      config: { code: 'Space' }
    }

    const entryD: RegistryEntry = {
      id: 'shortcut-d',
      config: { code: 'Space' }
    }

    registerShortcut(entryA)
    registerShortcut(entryB)
    warnSpy.mockClear()

    unregisterShortcut('shortcut-b')
    registerShortcut(entryC)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockClear()

    unregisterShortcut('shortcut-a')
    unregisterShortcut('shortcut-c')
    registerShortcut(entryD)
    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('generates a consistent serializable key from ShortcutConfig', () => {
    vi.stubEnv('DEV', true)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const config1: ShortcutConfig = { code: 'KeyF', metaOrCtrl: true }
    const config2: ShortcutConfig = { metaOrCtrl: true, code: 'KeyF' }

    const entry1: RegistryEntry = {
      id: 'shortcut-1',
      config: config1
    }

    const entry2: RegistryEntry = {
      id: 'shortcut-2',
      config: config2
    }

    registerShortcut(entry1)
    warnSpy.mockClear()
    registerShortcut(entry2)

    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('clears all registrations', () => {
    const entry1: RegistryEntry = {
      id: 'shortcut-1',
      config: { code: 'Space' }
    }

    const entry2: RegistryEntry = {
      id: 'shortcut-2',
      config: { code: 'KeyF' }
    }

    registerShortcut(entry1)
    registerShortcut(entry2)
    expect(getRegistered()).toHaveLength(2)

    clearRegistry()

    expect(getRegistered()).toHaveLength(0)
  })
})
