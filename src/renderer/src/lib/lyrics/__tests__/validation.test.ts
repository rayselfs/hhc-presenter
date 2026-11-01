import { DEFAULT_LYRICS_STYLE, isLyricsCrop, isLyricsOutput, isLyricsStyle } from '@shared/lyrics'
import { isCameraState } from '@shared/camera'
it('validates subtitle state at the existing camera protocol boundary', () => {
  const lyrics = {
    lines: ['甲', '乙', '丙'],
    style: DEFAULT_LYRICS_STYLE,
    visible: true,
    expiresAt: 123
  }
  const camera = {
    sessionId: 'session',
    transform: { x: 0, y: 0, width: 1920, height: 1080 },
    status: 'live',
    lyrics
  }
  expect(isCameraState(camera)).toBe(true)
  expect(isCameraState({ ...camera, lyrics: { ...lyrics, lines: ['a\nb'] } })).toBe(false)
  expect(isCameraState({ ...camera, lyrics: { ...lyrics, lines: Array(13).fill('a') } })).toBe(
    false
  )
  expect(isLyricsOutput({ ...lyrics, expiresAt: Infinity })).toBe(false)
  expect(isLyricsStyle({ ...DEFAULT_LYRICS_STYLE, fontSize: NaN })).toBe(false)
  expect(isLyricsStyle({ ...DEFAULT_LYRICS_STYLE, font: '<script>' })).toBe(false)
})
it('rejects crops outside the source without trimming them silently', () => {
  expect(isLyricsCrop({ x: 0, y: 0, width: 1, height: 0.8 })).toBe(true)
  expect(isLyricsCrop({ x: 0.5, y: 0, width: 0.6, height: 1 })).toBe(false)
  expect(isLyricsCrop({ x: 0, y: 0, width: 0, height: 1 })).toBe(false)
})
