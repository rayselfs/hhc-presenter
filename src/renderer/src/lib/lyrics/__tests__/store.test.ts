import { useCameraLyricsStore } from '@renderer/stores/camera-lyrics'
import { DEFAULT_LYRICS_STYLE } from '@shared/lyrics'
beforeEach(() =>
  useCameraLyricsStore.setState({
    enabled: false,
    manual: false,
    lines: [],
    acceptedAt: 0,
    style: { ...DEFAULT_LYRICS_STYLE }
  })
)
it('keeps manual rows intact and clears them on resume or disable', () => {
  const state = useCameraLyricsStore.getState()
  state.setEnabled(true)
  state.setManual('第一行\n第二行\n第三行')
  expect(useCameraLyricsStore.getState()).toMatchObject({
    manual: true,
    lines: ['第一行', '第二行', '第三行']
  })
  state.resume()
  expect(useCameraLyricsStore.getState()).toMatchObject({ manual: false, lines: [] })
  state.setManual('手動')
  state.setEnabled(false)
  expect(useCameraLyricsStore.getState()).toMatchObject({
    enabled: false,
    manual: false,
    lines: []
  })
})
it('validates styles and persists only appearance, never captured text or permission', () => {
  const store = useCameraLyricsStore.getState()
  store.setStyle({ ...DEFAULT_LYRICS_STYLE, fontSize: 72 })
  store.setStyle({ ...DEFAULT_LYRICS_STYLE, fontSize: NaN })
  expect(useCameraLyricsStore.getState().style.fontSize).toBe(72)
  const partialize = useCameraLyricsStore.persist.getOptions().partialize!
  expect(partialize(useCameraLyricsStore.getState())).toEqual({
    style: useCameraLyricsStore.getState().style
  })
})
it('rejects invalid manual corrections without replacing accepted rows', () => {
  const store = useCameraLyricsStore.getState()
  expect(store.setManual('First\r\nSecond\rThird')).toBe(true)
  expect(store.setManual('x'.repeat(257))).toBe(false)
  expect(store.setManual(Array(13).fill('row').join('\n'))).toBe(false)
  expect(useCameraLyricsStore.getState().lines).toEqual(['First', 'Second', 'Third'])
})
