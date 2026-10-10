import { useEffect } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { CameraSessionProvider, useCameraSession } from '../CameraSessionContext'
import { useCameraStore } from '@renderer/stores/camera'

const projection = vi.hoisted(() => ({
  activeOwner: 'camera',
  isProjectionOpen: false,
  recovery: { status: 'ready', generation: 0 },
  projectionReadyCount: 0,
  on: vi.fn(),
  send: vi.fn(),
  stopProjection: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../ProjectionContext', () => ({ useProjection: () => projection }))
const peer = vi.hoisted(() => ({
  dispose: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  acceptSignal: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@renderer/lib/camera-peer', () => ({ createCameraPeer: () => peer }))
let navigate: ReturnType<typeof useNavigate>
let camera: ReturnType<typeof useCameraSession>
function Controls(): null {
  const nextNavigate = useNavigate()
  const nextCamera = useCameraSession()
  useEffect(() => {
    navigate = nextNavigate
    camera = nextCamera
  }, [nextNavigate, nextCamera])
  return null
}
beforeEach(() => {
  projection.isProjectionOpen = false
  projection.activeOwner = 'camera'
  projection.on.mockReturnValue(() => undefined)
  peer.dispose.mockClear()
  projection.stopProjection.mockClear()
  useCameraStore.setState({ lastDeviceId: '', deviceId: '', busy: false, layouts: {} })
})
it('accesses devices only on the camera route and stops a late capture after leaving', async () => {
  let resolve!: (stream: MediaStream) => void
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((done) => {
        resolve = done
      })
  )
  const enumerateDevices = vi
    .fn()
    .mockResolvedValue([{ kind: 'videoinput', deviceId: 'cam', label: 'Camera' }])
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  })
  render(
    <MemoryRouter initialEntries={['/files']}>
      <CameraSessionProvider>
        <Controls />
      </CameraSessionProvider>
    </MemoryRouter>
  )
  expect(enumerateDevices).not.toHaveBeenCalled()
  expect(getUserMedia).not.toHaveBeenCalled()
  act(() => navigate('/camera'))
  await waitFor(() => expect(enumerateDevices).toHaveBeenCalled())
  let selecting!: Promise<void>
  act(() => {
    selecting = camera.selectSource('cam')
  })
  await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1))
  act(() => navigate('/bible'))
  const stop = vi.fn()
  await act(async () => {
    resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    await selecting
  })
  expect(stop).toHaveBeenCalledTimes(1)
  expect(useCameraStore.getState().capturing).toBe(false)
  expect(projection.stopProjection).not.toHaveBeenCalled()
})

it('retains camera projection across navigation and releases capture when Timer takes ownership', async () => {
  const stop = vi.fn()
  const track = {
    stop,
    getSettings: () => ({ deviceId: 'cam', width: 1920, height: 1080 }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue(stream),
      enumerateDevices: vi
        .fn()
        .mockResolvedValue([{ kind: 'videoinput', deviceId: 'cam', label: 'Camera' }]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  })
  render(
    <MemoryRouter initialEntries={['/camera']}>
      <CameraSessionProvider>
        <Controls />
      </CameraSessionProvider>
    </MemoryRouter>
  )
  await act(async () => {
    await camera.selectSource('cam')
  })
  expect(useCameraStore.getState().capturing).toBe(true)
  projection.isProjectionOpen = true
  act(() => navigate('/files'))
  expect(stop).not.toHaveBeenCalled()
  expect(projection.stopProjection).not.toHaveBeenCalled()
  expect(useCameraStore.getState().capturing).toBe(true)
  act(() => navigate('/bible'))
  expect(stop).not.toHaveBeenCalled()
  expect(peer.dispose).not.toHaveBeenCalled()
  projection.activeOwner = 'timer'
  act(() => navigate('/'))
  expect(stop).toHaveBeenCalledTimes(1)
  expect(peer.dispose).toHaveBeenCalledTimes(1)
  expect(projection.stopProjection).not.toHaveBeenCalled()
  expect(useCameraStore.getState().capturing).toBe(false)
})

it('uses the actual browser sharing surface for source identity and restores its framing', async () => {
  const track = {
    label: 'Display one',
    stop: vi.fn(),
    getSettings: () => ({ displaySurface: 'monitor', width: 1920, height: 1080 }),
    addEventListener: vi.fn()
  }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getDisplayMedia: vi
        .fn()
        .mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] }),
      getUserMedia: vi.fn(),
      enumerateDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  })
  render(
    <MemoryRouter initialEntries={['/camera']}>
      <CameraSessionProvider>
        <Controls />
      </CameraSessionProvider>
    </MemoryRouter>
  )
  await act(async () => {
    await camera.selectSource('browser:screen')
  })
  act(() => {
    useCameraStore.getState().updateTransform({ x: 10, y: 20, width: 960, height: 540 })
    useCameraStore.getState().setLocked(true)
  })
  await act(async () => {
    await camera.selectSource('browser:window')
  })
  expect(useCameraStore.getState().deviceId).toBe('browser:screen:Display one')
  expect(useCameraStore.getState().sourceKind).toBe('screen')
  expect(useCameraStore.getState().locked).toBe(true)
  expect(useCameraStore.getState().transform).toEqual({ x: 10, y: 20, width: 960, height: 540 })
})

it('does not let a slow desktop restore supersede explicit video selection', async () => {
  let resolve!: (sources: Array<{ id: string; label: string; kind: string }>) => void
  let requests = 0
  const getSources = vi.fn(() =>
    ++requests === 1
      ? new Promise<Array<{ id: string; label: string; kind: string }>>((done) => {
          resolve = done
        })
      : Promise.resolve([])
  )
  const track = {
    stop: vi.fn(),
    getSettings: () => ({ deviceId: 'cam', width: 1920, height: 1080 }),
    addEventListener: vi.fn()
  }
  Object.defineProperty(window, 'api', { configurable: true, value: { capture: { getSources } } })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi
        .fn()
        .mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] }),
      enumerateDevices: vi
        .fn()
        .mockResolvedValue([{ kind: 'videoinput', deviceId: 'cam', label: 'Camera' }]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  })
  useCameraStore.setState({ lastDeviceId: 'screen:1:0' })
  try {
    render(
      <MemoryRouter initialEntries={['/camera']}>
        <CameraSessionProvider>
          <Controls />
        </CameraSessionProvider>
      </MemoryRouter>
    )
    await act(async () => {
      await camera.selectSource('cam')
    })
    await act(async () => {
      resolve([])
    })
    expect(useCameraStore.getState().deviceId).toBe('cam')
    expect(useCameraStore.getState().capturing).toBe(true)
    expect(useCameraStore.getState().error).toBeNull()
  } finally {
    Reflect.deleteProperty(window, 'api')
  }
})

it('stops desktop capture if exclusions cannot be checked after projection changes', async () => {
  const source = { id: 'screen:1:0', label: 'Display', kind: 'screen' }
  const getSources = vi.fn().mockResolvedValue([source])
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { capture: { getSources, selectSource: vi.fn().mockResolvedValue(undefined) } }
  })
  const track = {
    stop: vi.fn(),
    getSettings: () => ({ width: 1920, height: 1080 }),
    addEventListener: vi.fn()
  }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getDisplayMedia: vi
        .fn()
        .mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] }),
      enumerateDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  })
  try {
    render(
      <MemoryRouter initialEntries={['/camera']}>
        <CameraSessionProvider>
          <Controls />
        </CameraSessionProvider>
      </MemoryRouter>
    )
    await act(async () => {
      await camera.selectSource(source.id)
    })
    expect(useCameraStore.getState().capturing).toBe(true)
    getSources.mockRejectedValue(new Error('Enumeration failed'))
    projection.isProjectionOpen = true
    act(() => navigate('/files'))
    await waitFor(() => expect(useCameraStore.getState().capturing).toBe(false))
    expect(track.stop).toHaveBeenCalled()
    expect(camera.stream).toBeNull()
  } finally {
    Reflect.deleteProperty(window, 'api')
  }
})

it('rechecks exclusions when a pending desktop capture completes after projection opens', async () => {
  let resolve!: (stream: MediaStream) => void
  const getDisplayMedia = vi.fn(
    () =>
      new Promise<MediaStream>((done) => {
        resolve = done
      })
  )
  const track = {
    stop: vi.fn(),
    getSettings: () => ({ width: 1920, height: 1080 }),
    addEventListener: vi.fn()
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      capture: {
        getSources: vi.fn().mockResolvedValue([]),
        selectSource: vi.fn().mockResolvedValue(undefined)
      }
    }
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getDisplayMedia,
      enumerateDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  })
  try {
    render(
      <MemoryRouter initialEntries={['/camera']}>
        <CameraSessionProvider>
          <Controls />
        </CameraSessionProvider>
      </MemoryRouter>
    )
    let selecting!: Promise<void>
    act(() => {
      selecting = camera.selectSource('screen:1:0')
    })
    await waitFor(() => expect(getDisplayMedia).toHaveBeenCalled())
    projection.isProjectionOpen = true
    act(() => navigate('/files'))
    await act(async () => {
      resolve({ getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream)
      await selecting
    })
    await waitFor(() => expect(useCameraStore.getState().capturing).toBe(false))
    expect(track.stop).toHaveBeenCalled()
    expect(useCameraStore.getState().error).toBe('sourceExcluded')
  } finally {
    Reflect.deleteProperty(window, 'api')
  }
})

it('discovers camera permission while a desktop source remains live', async () => {
  let permitted = false
  const desktopTrack = {
    label: 'Display',
    stop: vi.fn(),
    getSettings: () => ({ displaySurface: 'monitor', width: 1920, height: 1080 }),
    addEventListener: vi.fn()
  }
  const permissionTrack = { stop: vi.fn() }
  const getUserMedia = vi.fn(async () => {
    permitted = true
    return { getTracks: () => [permissionTrack] }
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getDisplayMedia: vi.fn().mockResolvedValue({
        getTracks: () => [desktopTrack],
        getVideoTracks: () => [desktopTrack]
      }),
      getUserMedia,
      enumerateDevices: vi.fn(async () => [
        { kind: 'videoinput', deviceId: permitted ? 'cam' : '', label: permitted ? 'Camera' : '' }
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  })
  render(
    <MemoryRouter initialEntries={['/camera']}>
      <CameraSessionProvider>
        <Controls />
      </CameraSessionProvider>
    </MemoryRouter>
  )
  await act(async () => {
    await camera.selectSource('browser:screen')
  })
  act(() => useCameraStore.setState({ sourceKind: 'video' }))
  await act(async () => {
    await camera.prepareSources()
  })
  expect(useCameraStore.getState().devices).toEqual([{ id: 'cam', label: 'Camera' }])
  expect(useCameraStore.getState().error).toBeNull()
  expect(permissionTrack.stop).toHaveBeenCalledOnce()
  expect(desktopTrack.stop).not.toHaveBeenCalled()
  expect(useCameraStore.getState().capturing).toBe(true)
})
