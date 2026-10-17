import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, DEFAULT_STATE, useTimerStore } from '@renderer/stores/timer'
import { useStopwatchStore } from '@renderer/stores/stopwatch'
import { useSettingsStore } from '@renderer/stores/settings'
import type { FileItemRecord } from '@shared/types/folder'
import { useCameraStore } from '@renderer/stores/camera'
import {
  getProjectionHeaderState,
  startProjectionForRoute,
  startMediaProjection,
  startTimerProjection
} from '../projection-actions'

describe('projection actions', () => {
  beforeEach(() => {
    useTimerStore.setState({
      ...DEFAULT_SETTINGS,
      ...DEFAULT_STATE,
      mode: 'timer',
      presets: []
    })
    useStopwatchStore.setState({
      status: 'stopped',
      elapsedMs: 0,

      showOnProjection: false
    })
    useSettingsStore.setState({
      timezone: 'Asia/Taipei',
      timerRingColor: '#22c55e',
      timerRingColorEnabled: true
    })
  })

  it('starts timer projection with an immediate timer snapshot', async () => {
    const startProjection = vi.fn(() => Promise.resolve())

    await startTimerProjection({ startProjection })

    expect(startProjection).toHaveBeenCalledWith(
      'timer',
      expect.arrayContaining([
        [
          'timer:tick',
          expect.objectContaining({
            mode: 'timer',
            phase: 'idle',
            reminderColor: null
          })
        ],
        ['settings:timezone', { timezone: 'Asia/Taipei' }],
        ['settings:timer-ring-color', { color: '#22c55e' }]
      ])
    )
  })

  it('includes stopwatch payload when stopwatch is projected', async () => {
    const startProjection = vi.fn(() => Promise.resolve())
    useTimerStore.setState({ mode: 'stopwatch' })
    useStopwatchStore.setState({
      status: 'running',
      elapsedMs: 1234,
      showOnProjection: true
    })

    await startTimerProjection({ startProjection })

    expect(startProjection).toHaveBeenCalledWith(
      'timer',
      expect.arrayContaining([
        [
          'timer:tick',
          expect.objectContaining({
            mode: 'stopwatch'
          })
        ],
        [
          'timer:stopwatch',
          expect.objectContaining({
            elapsedMs: 1234,
            formattedTime: '00:01',
            status: 'running'
          })
        ]
      ])
    )
  })

  it('reserves the browser projection window before media readiness settles', async () => {
    const item: FileItemRecord = {
      id: 'video-1',
      name: 'Welcome.mp4',
      mimeType: 'video/mp4',
      type: 'file',
      sortIndex: 0,
      parentId: 'root',
      size: 1,
      url: 'blob:video-1',
      createdAt: 1,
      expiresAt: null
    }
    let resolveReadiness!: (value: {
      summary: {
        ready: number
        preparing: number
        unsupported: number
        missing: number
        failed: number
      }
      items: []
    }) => void
    const readiness = new Promise<Parameters<typeof resolveReadiness>[0]>((resolve) => {
      resolveReadiness = resolve
    })
    const ensureProjectionOpen = vi.fn(() => Promise.resolve())

    const result = startMediaProjection([item], 0, {
      ensureProjectionOpen,
      startMediaPresentation: () => readiness
    })

    expect(ensureProjectionOpen).toHaveBeenCalledOnce()
    resolveReadiness({
      summary: { ready: 1, preparing: 0, unsupported: 0, missing: 0, failed: 0 },
      items: []
    })
    await result
  })
})

it('starts the camera through shared route actions only when capture is ready', async () => {
  const startProjection = vi.fn(async () => undefined)
  const deps = {
    pathname: '/camera',
    startProjection,
    biblePayloads: null,
    presentableItems: [],
    onNoProjectableFiles: vi.fn(),
    startMediaPresentation: vi.fn()
  }
  useCameraStore.setState({ capturing: false })
  expect(
    getProjectionHeaderState({ ...deps, isProjectionOpen: false, cameraReady: false }).disabled
  ).toBe(true)
  expect(await startProjectionForRoute(deps)).toBe(false)
  expect(startProjection).not.toHaveBeenCalled()
  useCameraStore.setState({ capturing: true })
  expect(
    getProjectionHeaderState({ ...deps, isProjectionOpen: false, cameraReady: true }).disabled
  ).toBe(false)
  expect(await startProjectionForRoute(deps)).toBe(true)
  expect(startProjection).toHaveBeenCalledWith('camera', [
    [
      'camera:state',
      expect.objectContaining({
        status: 'connecting',
        transform: useCameraStore.getState().transform
      })
    ]
  ])
  useCameraStore.setState({ capturing: false })
})
