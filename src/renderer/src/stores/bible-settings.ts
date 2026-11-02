import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { hhcPersistStorage, createKey } from '@renderer/lib/persist-storage'

export interface BibleSettingsStore {
  fontSize: number
  selectedVersionId: number
  speechMaxSessionSec: number
  speechEnabled: boolean
  scriptureTemplateId: string
  setFontSize: (size: number) => void
  setSelectedVersionId: (id: number) => void
  setSpeechMaxSessionSec: (sec: number) => void
  setSpeechEnabled: (enabled: boolean) => void
  setScriptureTemplateId: (templateId: string) => void
}

export const useBibleSettingsStore = create<BibleSettingsStore>()(
  persist(
    (set) => ({
      fontSize: 90,
      selectedVersionId: 0,
      speechMaxSessionSec: 0,
      speechEnabled: false,
      scriptureTemplateId: 'dark-stage',

      setFontSize: (size: number) => {
        set({ fontSize: size })
      },

      setSelectedVersionId: (id: number) => {
        set({ selectedVersionId: id })
      },

      setSpeechMaxSessionSec: (sec: number) => {
        set({
          speechMaxSessionSec: Number.isFinite(sec)
            ? Math.max(0, Math.min(86400, Math.floor(sec)))
            : 0
        })
      },

      setSpeechEnabled: (enabled: boolean) => {
        set({ speechEnabled: enabled })
      },

      setScriptureTemplateId: (templateId: string) => {
        set({ scriptureTemplateId: templateId })
      }
    }),
    {
      name: createKey('bible-settings'),
      storage: hhcPersistStorage,
      version: 5,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>
        if (version < 1) {
          state.speechMaxSessionSec = 3600
        }
        if (version < 2) {
          const oldMin = (state.speechMaxSessionMin as number) ?? 60
          state.speechMaxSessionSec = oldMin * 60
          delete state.speechMaxSessionMin
        }
        if (version < 3) {
          state.speechEnabled = false
        }
        if (version < 4) {
          state.scriptureTemplateId = 'dark-stage'
        }
        if (
          version < 5 &&
          (state.speechMaxSessionSec === 3600 || typeof state.speechMaxSessionSec !== 'number')
        )
          state.speechMaxSessionSec = 0
        return state as unknown as BibleSettingsStore
      },
      partialize: (state) => ({
        fontSize: state.fontSize,
        selectedVersionId: state.selectedVersionId,
        speechMaxSessionSec: state.speechMaxSessionSec,
        speechEnabled: state.speechEnabled,
        scriptureTemplateId: state.scriptureTemplateId
      })
    }
  )
)
