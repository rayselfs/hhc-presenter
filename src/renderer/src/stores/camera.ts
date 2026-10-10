import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createPersistName, hhcPersistStorage } from '@renderer/lib/persist-storage'
import {
  cameraSourceKind,
  type CameraSource,
  type CameraSourceKind,
  type CameraTransform
} from '@shared/camera'

interface CameraLayout {
  centerX: number
  centerY: number
  zoom: number
  locked?: boolean
}

interface CameraStore {
  sourceKind: CameraSourceKind
  desktopSources: CameraSource[]
  setLocked(locked: boolean): void
  layouts: Record<string, CameraLayout>
  activateSource(deviceId: string, cover: CameraTransform): void
  devices: Array<{ id: string; label: string }>
  lastDeviceId: string
  deviceId: string
  transform: CameraTransform
  cover: CameraTransform
  capturing: boolean
  locked: boolean
  selectorOpen: boolean
  busy: boolean
  error: string | null
  connection: 'idle' | 'connecting' | 'live' | 'unavailable'
  updateTransform(frame: CameraTransform): void
}
const initial = { x: 0, y: 0, width: 1920, height: 1080 }
export const useCameraStore = create<CameraStore>()(
  persist(
    (set, get) => ({
      sourceKind: 'video',
      desktopSources: [],
      setLocked: (locked) =>
        set((state) => ({
          locked,
          layouts: state.deviceId
            ? {
                ...state.layouts,
                [state.deviceId]: {
                  centerX: state.transform.x + state.transform.width / 2,
                  centerY: state.transform.y + state.transform.height / 2,
                  zoom: state.transform.width / state.cover.width,
                  locked
                }
              }
            : state.layouts
        })),
      layouts: {},
      activateSource: (deviceId, cover) =>
        set((state) => {
          const saved = state.layouts?.[deviceId]
          const valid =
            saved &&
            [saved.centerX, saved.centerY, saved.zoom].every(Number.isFinite) &&
            saved.zoom >= 0.05 &&
            saved.zoom <= 8
          const width = cover.width * (valid ? saved.zoom : 1)
          const height = cover.height * (valid ? saved.zoom : 1)
          return {
            deviceId,
            sourceKind: cameraSourceKind(deviceId),
            locked: !!valid && saved.locked === true,
            lastDeviceId: deviceId,
            cover,
            transform: valid
              ? { x: saved.centerX - width / 2, y: saved.centerY - height / 2, width, height }
              : cover
          }
        }),
      devices: [],
      deviceId: '',
      lastDeviceId: '',
      transform: initial,
      cover: initial,
      capturing: false,
      locked: false,
      selectorOpen: false,
      busy: false,
      error: null,
      connection: 'idle',
      updateTransform: (frame) => {
        if (get().locked) return
        if (!Object.values(frame).every(Number.isFinite)) return
        if (frame.width <= 0 || frame.height <= 0) return
        set((state) => {
          const transform = {
            ...frame,
            x: Math.max(-15360, Math.min(15360, frame.x)),
            y: Math.max(-8640, Math.min(8640, frame.y))
          }
          return {
            transform,
            layouts: state.deviceId
              ? {
                  ...state.layouts,
                  [state.deviceId]: {
                    centerX: transform.x + transform.width / 2,
                    centerY: transform.y + transform.height / 2,
                    zoom: transform.width / state.cover.width,
                    locked: state.locked
                  }
                }
              : state.layouts
          }
        })
      }
    }),
    {
      name: createPersistName('camera'),
      storage: hhcPersistStorage,
      version: 2,
      migrate: (value, version) => {
        const old = value as Partial<CameraStore>
        return {
          lastDeviceId: typeof old?.lastDeviceId === 'string' ? old.lastDeviceId : '',
          layouts:
            version >= 1 && old?.layouts && typeof old.layouts === 'object' ? old.layouts : {}
        }
      },
      partialize: (state) => ({ lastDeviceId: state.lastDeviceId, layouts: state.layouts })
    }
  )
)
