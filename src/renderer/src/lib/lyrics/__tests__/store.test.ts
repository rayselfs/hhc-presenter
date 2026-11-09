import { useCameraLyricsStore } from '@renderer/stores/camera-lyrics'
import { DEFAULT_LYRICS_STYLE } from '@shared/lyrics'
beforeEach(() =>
  useCameraLyricsStore.setState({
    enabled: false,
    lines: [],
    acceptedAt: 0,
    style: { ...DEFAULT_LYRICS_STYLE }
  })
)
it('accepts only automatic rows while enabled and drops late results after disable', () => {
  const state = useCameraLyricsStore.getState()
  state.setEnabled(true)
  state.acceptLines(['第一行', '第二行'])
  expect(useCameraLyricsStore.getState().lines).toEqual(['第一行', '第二行'])
  state.setEnabled(false)
  state.acceptLines(['Late cue'])
  expect(useCameraLyricsStore.getState().lines).toEqual([])
})
it('validates styles and persists only configuration, never captured text or capture permission', () => {
  const store = useCameraLyricsStore.getState()
  store.setStyle({ ...DEFAULT_LYRICS_STYLE, fontSize: 72 })
  store.setStyle({ ...DEFAULT_LYRICS_STYLE, fontSize: NaN })
  expect(useCameraLyricsStore.getState().style.fontSize).toBe(72)
  const partialize = useCameraLyricsStore.persist.getOptions().partialize!
  expect(partialize(useCameraLyricsStore.getState())).toEqual({
    style: useCameraLyricsStore.getState().style,
    crop: useCameraLyricsStore.getState().crop,
    enabled: false
  })
})
it('recovers from a previous overflow on the next cue even without the operator preview mounted', () => {
  const store = useCameraLyricsStore.getState()
  store.setEnabled(true)
  store.acceptLines(['Long cue'])
  useCameraLyricsStore.setState({ error: 'overflow' })
  store.acceptLines(['Long cue'])
  expect(useCameraLyricsStore.getState().error).toBe('overflow')
  store.acceptLines(['Next cue'])
  expect(useCameraLyricsStore.getState()).toMatchObject({
    lines: ['Next cue'],
    error: null,
    status: 'ready'
  })
  const acceptedAt = useCameraLyricsStore.getState().acceptedAt
  store.acceptLines(Array(13).fill('Invalid cue'))
  expect(useCameraLyricsStore.getState()).toMatchObject({
    lines: ['Next cue'],
    acceptedAt,
    error: 'recognize'
  })
})
it('migrates legacy appearance without resetting size, spacing or position', async () => {
  const options = useCameraLyricsStore.persist.getOptions()
  expect(options.version).toBe(3)
  const oldStyle = { font: 'sans-serif', fontSize: 88, lineHeight: 1.5, bottom: 12 }
  const saved = await options.migrate?.({ style: oldStyle }, 0)
  const merged = options.merge?.(saved, useCameraLyricsStore.getState())
  expect(merged?.style).toEqual({ ...oldStyle, bold: true })
  const invalid = await options.migrate?.({ style: { ...oldStyle, fontSize: NaN } }, 0)
  expect(options.merge?.(invalid, useCameraLyricsStore.getState()).style).toEqual(
    DEFAULT_LYRICS_STYLE
  )
})

it('restores a valid saved crop and preserves explicit normal weight from version one', async () => {
  const options = useCameraLyricsStore.persist.getOptions()
  const crop = { x: 0, y: 0, width: 1, height: 0.6 }
  const style = { ...DEFAULT_LYRICS_STYLE, bold: false }
  const saved = await options.migrate?.({ style, crop }, 1)
  const merged = options.merge?.(saved, useCameraLyricsStore.getState())
  expect(merged).toMatchObject({ style, crop })
  expect(
    options.merge?.({ crop: { ...crop, height: 2 } }, useCameraLyricsStore.getState()).crop
  ).toEqual(useCameraLyricsStore.getState().crop)
})

it('restores only a boolean mode preference without rehydrating runtime lyrics', async () => {
  const options = useCameraLyricsStore.persist.getOptions()
  const state = useCameraLyricsStore.getState()
  state.setEnabled(true)
  state.acceptLines(['Private cue'])
  const saved = options.partialize!(useCameraLyricsStore.getState())
  state.setEnabled(false)
  const restored = options.merge!(saved, useCameraLyricsStore.getState())
  expect(restored).toMatchObject({ enabled: true, lines: [], acceptedAt: 0, status: 'idle' })
  expect(options.merge!({ enabled: 'true' }, useCameraLyricsStore.getState()).enabled).toBe(false)
  const migrated = await options.migrate!({ style: DEFAULT_LYRICS_STYLE }, 2)
  expect(options.merge!(migrated, useCameraLyricsStore.getState()).enabled).toBe(false)
})

it('retains the accepted cue while a newly applied crop is being recognized', () => {
  const store = useCameraLyricsStore.getState()
  store.setEnabled(true)
  store.acceptLines(['Current cue'])
  store.setCrop({ x: 0, y: 0, width: 1, height: 0.5 })
  expect(useCameraLyricsStore.getState()).toMatchObject({
    lines: ['Current cue'],
    status: 'recognizing'
  })
})
it('keeps recognizing while hidden and never persists runtime visibility', () => {
  const store = useCameraLyricsStore.getState()
  store.setEnabled(true)
  store.setHidden(true)
  store.acceptLines(['Latest cue'])
  expect(useCameraLyricsStore.getState()).toMatchObject({
    enabled: true,
    hidden: true,
    lines: ['Latest cue']
  })
  expect(
    useCameraLyricsStore.persist.getOptions().partialize!(useCameraLyricsStore.getState())
  ).not.toHaveProperty('hidden')
  store.setEnabled(false)
  expect(useCameraLyricsStore.getState().hidden).toBe(false)
})

it('preserves initialization and source failures when applying a crop so recovery remains available', () => {
  for (const error of ['load', 'source'] as const) {
    useCameraLyricsStore.setState({ error, status: 'error' })
    useCameraLyricsStore.getState().setCrop({ x: 0, y: 0, width: 1, height: 0.6 })
    expect(useCameraLyricsStore.getState()).toMatchObject({ error, status: 'error' })
  }
})
