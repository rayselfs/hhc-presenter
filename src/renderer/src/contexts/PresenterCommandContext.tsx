import { createContext, useContext } from 'react'
import type { FileControlPayload } from '@shared/projection-messages'

interface PresenterCommandContextValue {
  sendCommand: (command: FileControlPayload) => void
  cancelPreparation?: () => void
  thumbnails?: Record<string, string | null>
}

export const PresenterCommandContext = createContext<PresenterCommandContextValue | null>(null)

export function usePresenterCommands(): PresenterCommandContextValue {
  const ctx = useContext(PresenterCommandContext)
  if (!ctx) {
    throw new Error('usePresenterCommands must be used within a PresenterCommandContext.Provider')
  }
  return ctx
}
