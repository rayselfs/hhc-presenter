import { afterEach, describe, expect, it, vi } from 'vitest'
import { photoLyricsFrame } from '../photo-frame'

class TestFrame {
  data: Uint8ClampedArray

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.data = new Uint8ClampedArray(width * height * 4)
  }
}

function makeImage(pixel: (x: number, y: number) => number[]): ImageData {
  vi.stubGlobal('ImageData', TestFrame)
  const image = new ImageData(160, 96)
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      image.data.set([...pixel(x, y), 255], (y * image.width + x) * 4)
    }
  }
  return image
}

function letters(x: number, y: number): boolean {
  return x >= 16 && x < 144 && x % 16 < 8 && y >= 24 && y < 44
}

describe('photoLyricsFrame', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('isolates a repeated ink color against a smooth gradient while preserving the source', () => {
    const ink = [32, 45, 64]
    const image = makeImage((x, y) => (letters(x, y) ? ink : [90 + x, 140 + y, 180]))
    const masked = photoLyricsFrame(image)
    const offset = (30 * image.width + 32) * 4
    expect(masked?.data.slice(offset, offset + 4)).toEqual(Uint8ClampedArray.of(0, 0, 0, 255))
    expect(masked?.data.slice(0, 4)).toEqual(Uint8ClampedArray.of(255, 255, 255, 255))
    expect([...image.data.slice(offset, offset + 3)]).toEqual(ink)
  })

  it.each([28, 64])('preserves secondary ink on the same or a separate row (y=%i)', (top) => {
    const image = makeImage((x, y) => {
      if (letters(x, y)) return [32, 45, 64]
      if (x >= 148 && x < 156 && y >= top && y < top + 12) return [255, 255, 0]
      return [90 + x, 140 + y, 180]
    })
    expect(photoLyricsFrame(image)).toBeNull()
  })

  it('leaves text on a flat background to the normal detector', () => {
    expect(
      photoLyricsFrame(makeImage((x, y) => (letters(x, y) ? [0, 0, 0] : [255, 255, 255])))
    ).toBeNull()
  })

  it('leaves a frame with unrelated high-contrast edges intact', () => {
    const image = makeImage((x, y) => {
      if (letters(x, y)) return [32, 45, 64]
      return [x % 8 < 4 ? 80 : 230, 140 + y, 80 + x]
    })
    expect(photoLyricsFrame(image)).toBeNull()
  })
})
