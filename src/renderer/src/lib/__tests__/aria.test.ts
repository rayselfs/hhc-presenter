import { describe, it, expect, afterEach } from 'vitest'
import { formatAriaShortcut } from '../aria'
import type { ShortcutConfig } from '@renderer/lib/shortcut-config'

describe('formatAriaShortcut', () => {
  const originalUserAgentData = Object.getOwnPropertyDescriptor(navigator, 'userAgentData')

  afterEach(() => {
    if (originalUserAgentData) {
      Object.defineProperty(navigator, 'userAgentData', originalUserAgentData)
    } else {
      Object.defineProperty(navigator, 'userAgentData', {
        value: undefined,
        configurable: true,
        writable: true
      })
    }
  })

  it('formats simple key code', () => {
    const config: ShortcutConfig = { code: 'Space' }
    expect(formatAriaShortcut(config)).toBe('Space')
  })

  it('formats metaOrCtrl on Mac', () => {
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform: 'macOS' },
      configurable: true,
      writable: true
    })
    const config: ShortcutConfig = { code: 'KeyF', metaOrCtrl: true }
    expect(formatAriaShortcut(config)).toBe('Meta+F')
  })

  it('formats metaOrCtrl on Windows', () => {
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform: 'Windows' },
      configurable: true,
      writable: true
    })
    const config: ShortcutConfig = { code: 'KeyF', metaOrCtrl: true }
    expect(formatAriaShortcut(config)).toBe('Control+F')
  })

  it('formats KeyX codes to letter', () => {
    const config: ShortcutConfig = { code: 'KeyG' }
    expect(formatAriaShortcut(config)).toBe('G')
  })

  it('formats platform override on Mac', () => {
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform: 'macOS' },
      configurable: true,
      writable: true
    })
    const config: ShortcutConfig = {
      code: 'Backspace',
      mac: { code: 'Backspace', meta: true }
    }
    expect(formatAriaShortcut(config)).toBe('Meta+Backspace')
  })

  it('formats multiple modifiers', () => {
    const config: ShortcutConfig = { code: 'KeyA', ctrl: true, shift: true }
    expect(formatAriaShortcut(config)).toBe('Control+Shift+A')
  })

  it('follows WAI-ARIA modifier order', () => {
    const config: ShortcutConfig = {
      code: 'KeyB',
      alt: true,
      shift: true,
      ctrl: true,
      meta: true
    }
    expect(formatAriaShortcut(config)).toBe('Meta+Control+Shift+Alt+B')
  })
})
