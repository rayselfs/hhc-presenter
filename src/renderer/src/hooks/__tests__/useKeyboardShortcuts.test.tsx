import { renderHook, act, fireEvent, screen } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'
import React, { useState } from 'react'
import {
  matchesConfig,
  useKeyboardShortcuts,
  type ShortcutHandler,
  type ShortcutConfig
} from '../useKeyboardShortcuts'
import { ShortcutScopeProvider, ShortcutScope } from '@renderer/contexts/ShortcutScopeContext'
import { SHORTCUTS } from '@renderer/config/shortcuts'

let mockIsMac = false

vi.mock('@renderer/lib/env', () => ({
  isMac: () => mockIsMac
}))

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    mockIsMac = false
  })

  it('ignores shortcuts inside confirmation dialogs', () => {
    const handler = vi.fn()
    renderHook(() => useKeyboardShortcuts([{ config: { code: 'Space' }, handler }]))
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'alertdialog')
    const button = document.createElement('button')
    dialog.append(button)
    document.body.append(dialog)
    try {
      fireEvent.keyDown(button, { code: 'Space' })
      expect(handler).not.toHaveBeenCalled()
    } finally {
      dialog.remove()
    }
  })

  it('matches platform projection shortcuts', () => {
    expect(
      matchesConfig(new KeyboardEvent('keydown', { code: 'F5' }), SHORTCUTS.PROJECTION.START)
    ).toBe(true)
    expect(
      matchesConfig(
        new KeyboardEvent('keydown', { code: 'Enter', metaKey: true, shiftKey: true }),
        SHORTCUTS.PROJECTION.START
      )
    ).toBe(false)

    mockIsMac = true

    expect(
      matchesConfig(
        new KeyboardEvent('keydown', { code: 'Enter', metaKey: true, shiftKey: true }),
        SHORTCUTS.PROJECTION.START
      )
    ).toBe(true)
    expect(
      matchesConfig(new KeyboardEvent('keydown', { code: 'F5' }), SHORTCUTS.PROJECTION.START)
    ).toBe(false)
  })

  it('ignores keydown when event.isComposing is true', () => {
    const handler = vi.fn()
    const config: ShortcutConfig = { code: 'Space' }
    const shortcuts: ShortcutHandler[] = [{ config, handler }]

    renderHook(() => useKeyboardShortcuts(shortcuts))

    act(() => {
      fireEvent.keyDown(document, { code: 'Space', isComposing: true })
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('ignores keydown when event.keyCode is 229', () => {
    const handler = vi.fn()
    const config: ShortcutConfig = { code: 'Space' }
    const shortcuts: ShortcutHandler[] = [{ config, handler }]

    renderHook(() => useKeyboardShortcuts(shortcuts))

    act(() => {
      fireEvent.keyDown(document, { code: 'Space', keyCode: 229 })
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('fires handler for normal keydown events', () => {
    const handler = vi.fn()
    const config: ShortcutConfig = { code: 'Space' }
    const shortcuts: ShortcutHandler[] = [{ config, handler }]

    renderHook(() => useKeyboardShortcuts(shortcuts))

    act(() => {
      fireEvent.keyDown(document, { code: 'Space' })
    })

    expect(handler).toHaveBeenCalledOnce()
  })

  it('fires handler when isComposing is false', () => {
    const handler = vi.fn()
    const config: ShortcutConfig = { code: 'Space' }
    const shortcuts: ShortcutHandler[] = [{ config, handler }]

    renderHook(() => useKeyboardShortcuts(shortcuts))

    act(() => {
      fireEvent.keyDown(document, { code: 'Space', isComposing: false })
    })

    expect(handler).toHaveBeenCalledOnce()
  })

  it('allows explicitly opted-in shortcuts from nested editable content', () => {
    const handler = vi.fn()
    renderHook(() =>
      useKeyboardShortcuts([{ config: { code: 'F5' }, handler, allowInEditable: true }])
    )
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    const span = document.createElement('span')
    editor.append(span)
    document.body.append(editor)
    fireEvent.keyDown(editor, { code: 'F5' })
    expect(handler).toHaveBeenCalledOnce()
    fireEvent.keyDown(span, { code: 'F5', isComposing: true })
    expect(handler).toHaveBeenCalledOnce()
    editor.remove()
  })

  it('does not run ordinary shortcuts in nested editable content', () => {
    const handler = vi.fn()
    renderHook(() => useKeyboardShortcuts([{ config: { code: 'Space' }, handler }]))
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    const span = document.createElement('span')
    editor.append(span)
    document.body.append(editor)
    fireEvent.keyDown(span, { code: 'Space' })
    expect(handler).not.toHaveBeenCalled()
    editor.remove()
  })

  it('skips editable targets', () => {
    const handler = vi.fn()
    const config: ShortcutConfig = { code: 'Space' }
    const shortcuts: ShortcutHandler[] = [{ config, handler }]

    renderHook(() => useKeyboardShortcuts(shortcuts))

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    act(() => {
      fireEvent.keyDown(input, { code: 'Space' })
    })

    expect(handler).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  it('respects enabled option', () => {
    const handler = vi.fn()
    const config: ShortcutConfig = { code: 'Space' }
    const shortcuts: ShortcutHandler[] = [{ config, handler }]

    renderHook(() => useKeyboardShortcuts(shortcuts, { enabled: false }))

    act(() => {
      fireEvent.keyDown(document, { code: 'Space' })
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('suppresses shortcuts when overlay scope is active', () => {
    const handler = vi.fn()
    const config: ShortcutConfig = { code: 'Space' }
    const shortcuts: ShortcutHandler[] = [{ config, handler }]

    const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
      <ShortcutScopeProvider>
        <ShortcutScope name="overlay">{children}</ShortcutScope>
      </ShortcutScopeProvider>
    )

    renderHook(() => useKeyboardShortcuts(shortcuts), { wrapper })

    act(() => {
      fireEvent.keyDown(document, { code: 'Space' })
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('fires shortcuts when no overlay scope is active', () => {
    const handler = vi.fn()
    const config: ShortcutConfig = { code: 'Space' }
    const shortcuts: ShortcutHandler[] = [{ config, handler }]

    const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
      <ShortcutScopeProvider>{children}</ShortcutScopeProvider>
    )

    renderHook(() => useKeyboardShortcuts(shortcuts), { wrapper })

    act(() => {
      fireEvent.keyDown(document, { code: 'Space' })
    })

    expect(handler).toHaveBeenCalledOnce()
  })

  it('does not fire Escape shortcuts when overlay scope is active', () => {
    const handler = vi.fn()
    const config: ShortcutConfig = { code: 'Escape' }
    const shortcuts: ShortcutHandler[] = [{ config, handler }]

    const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
      <ShortcutScopeProvider>
        <ShortcutScope name="overlay">{children}</ShortcutScope>
      </ShortcutScopeProvider>
    )

    renderHook(() => useKeyboardShortcuts(shortcuts), { wrapper })

    act(() => {
      fireEvent.keyDown(document, { code: 'Escape' })
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('backward compatible — works without ShortcutScopeProvider', () => {
    const handler = vi.fn()
    const config: ShortcutConfig = { code: 'Space' }
    const shortcuts: ShortcutHandler[] = [{ config, handler }]

    renderHook(() => useKeyboardShortcuts(shortcuts))

    act(() => {
      fireEvent.keyDown(document, { code: 'Space' })
    })

    expect(handler).toHaveBeenCalledOnce()
  })

  it('resumes shortcuts after overlay scope unmounts', () => {
    const handler = vi.fn()
    const config: ShortcutConfig = { code: 'Space' }
    const shortcuts: ShortcutHandler[] = [{ config, handler }]

    const ToggleWrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => {
      const [overlayActive, setOverlayActive] = useState(true)
      return (
        <ShortcutScopeProvider>
          {overlayActive ? (
            <ShortcutScope name="overlay">
              <button
                type="button"
                onClick={() => setOverlayActive(false)}
                data-testid="close-overlay"
              />
              {children}
            </ShortcutScope>
          ) : (
            <>{children}</>
          )}
        </ShortcutScopeProvider>
      )
    }

    renderHook(() => useKeyboardShortcuts(shortcuts), {
      wrapper: ToggleWrapper
    })

    act(() => {
      fireEvent.keyDown(document, { code: 'Space' })
    })
    expect(handler).not.toHaveBeenCalled()

    act(() => {
      fireEvent.click(screen.getByTestId('close-overlay'))
    })

    act(() => {
      fireEvent.keyDown(document, { code: 'Space' })
    })
    expect(handler).toHaveBeenCalledOnce()
  })
})
