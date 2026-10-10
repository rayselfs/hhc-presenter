import { useCameraStore } from '../camera'
import { createCameraCover } from '@renderer/lib/camera-transform'

afterEach(() => useCameraStore.setState({ locked: false }))

it('blocks framing updates while locked and resumes after unlocking', () => {
  const cover = createCameraCover(1920, 1080)
  useCameraStore.setState({ layouts: {}, locked: false })
  useCameraStore.getState().activateSource('locked-camera', cover)
  const frame = { x: 100, y: 200, width: 960, height: 540 }
  useCameraStore.getState().updateTransform(frame)
  const layouts = useCameraStore.getState().layouts

  useCameraStore.setState({ locked: true })
  useCameraStore.getState().updateTransform(cover)
  expect(useCameraStore.getState().transform).toEqual(frame)
  expect(useCameraStore.getState().layouts).toBe(layouts)
  expect(
    useCameraStore.persist.getOptions().partialize!(useCameraStore.getState())
  ).not.toHaveProperty('locked')

  useCameraStore.setState({ locked: false })
  useCameraStore.getState().updateTransform(cover)
  expect(useCameraStore.getState().transform).toEqual(cover)
})

it('restores layout by device and keeps center and zoom across aspect changes', () => {
  const store = useCameraStore
  store.setState({ layouts: {}, deviceId: '', capturing: false })
  const cover = createCameraCover(1920, 1080)
  store.getState().activateSource('one', cover)
  store.getState().updateTransform({ x: 100, y: 200, width: 960, height: 540 })
  store.getState().activateSource('two', cover)
  expect(store.getState().transform).toEqual(cover)
  store.getState().activateSource('one', cover)
  expect(store.getState().transform).toEqual({ x: 100, y: 200, width: 960, height: 540 })
  store.getState().activateSource('one', createCameraCover(640, 480))
  expect(store.getState().transform).toEqual({ x: 100, y: 110, width: 960, height: 720 })
  const persisted = store.persist.getOptions().partialize!(store.getState())
  expect(persisted).toHaveProperty('layouts.one')
  expect(persisted).not.toHaveProperty('capturing')
  store.getState().updateTransform(store.getState().cover)
  store.getState().activateSource('two', cover)
  store.getState().activateSource('one', cover)
  expect(store.getState().transform).toEqual(cover)
})

it('restores each source lock independently, including a source never resized', () => {
  const store = useCameraStore
  const cover = createCameraCover(1920, 1080)
  store.setState({ layouts: {}, locked: false })
  store.getState().activateSource('screen:1:0', cover)
  store.getState().setLocked(true)
  store.getState().activateSource('window:2:0', cover)
  expect(store.getState().locked).toBe(false)
  store.getState().updateTransform({ x: 30, y: 40, width: 960, height: 540 })
  store.getState().activateSource('screen:1:0', cover)
  expect(store.getState().locked).toBe(true)
  expect(store.getState().transform).toEqual(cover)
  const saved = store.persist.getOptions().partialize!(store.getState())
  expect(saved).toHaveProperty('layouts.screen:1:0.locked', true)
  store.getState().activateSource('window:2:0', cover)
  expect(store.getState().locked).toBe(false)
  expect(store.getState().transform).toEqual({ x: 30, y: 40, width: 960, height: 540 })
})

it('preserves version-one layouts during migration and defaults their lock to false', async () => {
  const migrate = useCameraStore.persist.getOptions().migrate!
  expect(
    await migrate(
      { lastDeviceId: 'cam', layouts: { cam: { centerX: 10, centerY: 20, zoom: 0.5 } } },
      1
    )
  ).toMatchObject({
    lastDeviceId: 'cam',
    layouts: { cam: { centerX: 10, centerY: 20, zoom: 0.5 } }
  })
})
