import { hasLargeDarkSlideText, recognizeLyricsFrame } from '../frame'

function darkSlide(textHeight: number): ImageData {
  const width = 960
  const height = 128
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 8; y < 8 + textHeight; y++) {
    for (let x = 32; x < 320; x++) {
      const offset = (y * width + x) * 4
      data[offset] = data[offset + 1] = 255
    }
  }
  return { width, height, data, colorSpace: 'srgb' }
}

it('compacts large yellow type on black and preserves resolution for small type', () => {
  expect(hasLargeDarkSlideText(darkSlide(48))).toBe(true)
  expect(hasLargeDarkSlideText(darkSlide(20))).toBe(false)
})

it('checks the detailed frame for ink lost in a solid thumbnail', async () => {
  const source = document.createElement('canvas')
  source.width = 1920
  source.height = 256
  const detailed = darkSlide(24)
  const context = { getImageData: () => detailed } as unknown as CanvasRenderingContext2D
  vi.spyOn(source, 'getContext').mockReturnValue(context)
  const recognize = vi.fn().mockResolvedValue([
    {
      text: 'Small type',
      score: 1,
      poly: [
        [32, 8],
        [320, 8],
        [320, 32],
        [32, 32]
      ]
    }
  ])
  const lines = await recognizeLyricsFrame(
    { recognize, dispose: vi.fn() },
    darkSlide(0),
    source,
    document.createElement('canvas'),
    () => true
  )
  expect(lines).toEqual(['Small type'])
  expect(recognize).toHaveBeenCalledExactlyOnceWith(detailed)
})
