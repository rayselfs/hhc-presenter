import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SHORTCUTS } from '../shortcuts'
import { matchesConfig, type ShortcutConfig } from '@renderer/lib/shortcut-config'

let mockIsMac = false

vi.mock('@renderer/lib/env', () => ({
  isMac: () => mockIsMac
}))

function matches(config: ShortcutConfig, init: KeyboardEventInit): boolean {
  return matchesConfig(new KeyboardEvent('keydown', init), config)
}

describe('presentation shortcuts', () => {
  beforeEach(() => {
    mockIsMac = false
  })

  it.each([
    ['NEW_SLIDE', { code: 'KeyM', ctrlKey: true }],
    ['DUPLICATE', { code: 'KeyD', ctrlKey: true }],
    ['ZOOM_OUT', { code: 'Minus', ctrlKey: true }],
    ['ZOOM_FIT', { code: 'KeyO', ctrlKey: true, altKey: true }],
    ['BOLD', { code: 'KeyB', ctrlKey: true }],
    ['ITALIC', { code: 'KeyI', ctrlKey: true }],
    ['UNDERLINE', { code: 'KeyU', ctrlKey: true }]
  ] as const)('matches Windows/Linux %s', (name, event) => {
    expect(matches(SHORTCUTS.PRESENTATION[name], event)).toBe(true)
    expect(matches(SHORTCUTS.PRESENTATION[name], { ...event, ctrlKey: false, metaKey: true })).toBe(
      false
    )
  })

  it('matches Windows/Linux zoom-in for both plus and equals keyboard events', () => {
    expect(
      matches(SHORTCUTS.PRESENTATION.ZOOM_IN, {
        code: 'Equal',
        key: '+',
        ctrlKey: true,
        shiftKey: true
      })
    ).toBe(true)
    expect(
      matches(SHORTCUTS.PRESENTATION.ZOOM_IN_ALT, {
        code: 'Equal',
        key: '=',
        ctrlKey: true
      })
    ).toBe(true)
  })

  it.each([
    ['NEW_SLIDE', { code: 'KeyN', metaKey: true, shiftKey: true }],
    ['DUPLICATE', { code: 'KeyD', metaKey: true }],
    ['ZOOM_OUT', { code: 'Minus', metaKey: true }],
    ['ZOOM_FIT', { code: 'KeyO', metaKey: true, altKey: true }],
    ['BOLD', { code: 'KeyB', metaKey: true }],
    ['ITALIC', { code: 'KeyI', metaKey: true }],
    ['UNDERLINE', { code: 'KeyU', metaKey: true }]
  ] as const)('matches macOS %s', (name, event) => {
    mockIsMac = true
    expect(matches(SHORTCUTS.PRESENTATION[name], event)).toBe(true)
    expect(matches(SHORTCUTS.PRESENTATION[name], { ...event, ctrlKey: true, metaKey: false })).toBe(
      false
    )
  })

  it('matches macOS zoom-in for both plus and equals keyboard events', () => {
    mockIsMac = true
    expect(
      matches(SHORTCUTS.PRESENTATION.ZOOM_IN, {
        code: 'Equal',
        key: '+',
        metaKey: true,
        shiftKey: true
      })
    ).toBe(true)
    expect(
      matches(SHORTCUTS.PRESENTATION.ZOOM_IN_ALT, {
        code: 'Equal',
        key: '=',
        metaKey: true
      })
    ).toBe(true)
  })
})
