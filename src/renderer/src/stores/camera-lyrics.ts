import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  DEFAULT_LYRICS_STYLE,
  isLyricsCrop,
  isLyricsLines,
  isLyricsStyle,
  type LyricsCrop,
  type LyricsStyle
} from '@shared/lyrics'
import { createPersistName, hhcPersistStorage } from '@renderer/lib/persist-storage'
interface LyricsStore {
  enabled: boolean
  visible: boolean
  manual: boolean
  status: 'idle' | 'loading' | 'recognizing' | 'ready' | 'empty' | 'error'
  error: 'load' | 'recognize' | 'overflow' | 'source' | null
  lines: string[]
  acceptedAt: number
  crop: LyricsCrop
  style: LyricsStyle
  setEnabled(value: boolean): void
  setStyle(value: LyricsStyle): void
  setCrop(value: LyricsCrop): void
  acceptLines(lines: string[]): void
  setManual(text: string): boolean
  resume(): void
}
export const useCameraLyricsStore = create<LyricsStore>()(
  persist(
    (set, get) => ({
      enabled: false,
      visible: true,
      manual: false,
      status: 'idle',
      error: null,
      lines: [],
      acceptedAt: 0,
      crop: { x: 0, y: 0, width: 1, height: 0.6 },
      style: { ...DEFAULT_LYRICS_STYLE },
      setEnabled: (enabled) =>
        set({ enabled, lines: [], acceptedAt: 0, manual: false, error: null, status: 'idle' }),
      setStyle: (style) => {
        if (isLyricsStyle(style)) set({ style })
      },
      setCrop: (crop) => {
        if (isLyricsCrop(crop)) set({ crop, lines: [], acceptedAt: 0, manual: false, error: null })
      },
      acceptLines: (lines) => {
        const previous = get()
        if (!previous.enabled || previous.manual) return
        if (!isLyricsLines(lines)) {
          set({ error: 'recognize', status: 'error' })
          return
        }
        const unchanged =
          previous.lines.length === lines.length &&
          previous.lines.every((line, index) => line === lines[index])
        set({
          lines,
          acceptedAt: Date.now(),
          status: lines.length ? 'ready' : 'empty',
          error: unchanged && previous.error === 'overflow' ? 'overflow' : null
        })
      },
      setManual: (text) => {
        const lines = text.replace(/\r\n?/g, '\n').split('\n')
        if (!isLyricsLines(lines)) return false
        set({ lines, acceptedAt: Date.now(), manual: true, status: 'ready', error: null })
        return true
      },
      resume: () => set({ manual: false, lines: [], acceptedAt: 0, error: null })
    }),
    {
      name: createPersistName('camera-lyrics'),
      storage: hhcPersistStorage,
      version: 0,
      partialize: (state) => ({ style: state.style }),
      merge: (saved, current) => {
        const value = saved && typeof saved === 'object' && 'style' in saved ? saved.style : null
        return { ...current, style: isLyricsStyle(value) ? value : current.style }
      }
    }
  )
)
