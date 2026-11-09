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
}
export const useCameraLyricsStore = create<LyricsStore>()(
  persist(
    (set, get) => ({
      enabled: false,
      status: 'idle',
      error: null,
      lines: [],
      acceptedAt: 0,
      crop: { x: 0, y: 0, width: 1, height: 0.4 },
      style: { ...DEFAULT_LYRICS_STYLE },
      setEnabled: (enabled) =>
        set({ enabled, lines: [], acceptedAt: 0, error: null, status: 'idle' }),
      setStyle: (style) => {
        if (isLyricsStyle(style)) set({ style })
      },
      setCrop: (crop) => {
        if (isLyricsCrop(crop)) set({ crop, lines: [], acceptedAt: 0, error: null })
      },
      acceptLines: (lines) => {
        const previous = get()
        if (!previous.enabled) return
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
      }
    }),
    {
      name: createPersistName('camera-lyrics'),
      storage: hhcPersistStorage,
      version: 3,
      migrate: (saved, version) => {
        if (!saved || typeof saved !== 'object' || !('style' in saved)) return {}
        const style = saved.style
        if (!style || typeof style !== 'object') return {}
        const migrated = version === 0 ? { ...style, bold: true } : style
        return { ...saved, style: isLyricsStyle(migrated) ? migrated : undefined }
      },
      partialize: (state) => ({ style: state.style, crop: state.crop, enabled: state.enabled }),
      merge: (saved, current) => {
        const value = saved && typeof saved === 'object' && 'style' in saved ? saved.style : null
        const crop = saved && typeof saved === 'object' && 'crop' in saved ? saved.crop : null
        const enabled =
          saved && typeof saved === 'object' && 'enabled' in saved ? saved.enabled : null
        return {
          ...current,
          enabled: typeof enabled === 'boolean' ? enabled : current.enabled,
          style: isLyricsStyle(value) ? value : current.style,
          crop: isLyricsCrop(crop) ? crop : current.crop
        }
      }
    }
  )
)
