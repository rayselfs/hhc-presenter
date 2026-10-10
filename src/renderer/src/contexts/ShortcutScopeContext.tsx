import { createContext, useContext, useState, useLayoutEffect, useCallback } from 'react'
import type React from 'react'

interface ShortcutScopeContextValue {
  scopeStack: string[]
  pushScope: (name: string) => void
  popScope: (name: string) => void
}

const ShortcutScopeContext = createContext<ShortcutScopeContextValue | null>(null)

export function ShortcutScopeProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [scopeStack, setScopeStack] = useState<string[]>([])

  const pushScope = useCallback((name: string): void => {
    setScopeStack((prev) => [...prev, name])
  }, [])

  const popScope = useCallback((name: string): void => {
    setScopeStack((prev) => {
      const idx = [...prev].lastIndexOf(name)
      return prev.filter((_, i) => i !== idx)
    })
  }, [])

  return (
    <ShortcutScopeContext.Provider value={{ scopeStack, pushScope, popScope }}>
      {children}
    </ShortcutScopeContext.Provider>
  )
}

export function ShortcutScope({
  name,
  children
}: {
  name: string
  children: React.ReactNode
}): React.JSX.Element {
  const ctx = useContext(ShortcutScopeContext)
  if (!ctx) throw new Error('ShortcutScope must be used within a ShortcutScopeProvider')

  const { pushScope, popScope } = ctx

  useLayoutEffect(() => {
    pushScope(name)
    return () => {
      popScope(name)
    }
  }, [name, pushScope, popScope])

  return <>{children}</>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useShortcutScope(): { activeScope: string; isOverlayActive: boolean } {
  const ctx = useContext(ShortcutScopeContext)
  if (!ctx) throw new Error('useShortcutScope must be used within a ShortcutScopeProvider')

  const { scopeStack } = ctx
  return {
    activeScope: scopeStack[scopeStack.length - 1] ?? 'page',
    isOverlayActive: scopeStack.length > 0
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalShortcutScope(): { isOverlayActive: boolean } {
  const ctx = useContext(ShortcutScopeContext)
  if (!ctx) return { isOverlayActive: false }

  return { isOverlayActive: ctx.scopeStack.length > 0 }
}
