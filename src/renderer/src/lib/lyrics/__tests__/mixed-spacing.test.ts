import { describe, expect, it } from 'vitest'
import { measureLyricsRow, readMixedRowSpacing } from '../mixed-spacing'

function read(text: string, widths: number[], gaps: number[], raisedQuote = -1): string {
  const width = widths.reduce((n, w) => n + w, 8) + gaps.reduce((n, gap) => n + gap, 0)
  const height = 36
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  let left = 4
  widths.forEach((w, i) => {
    for (let y = 3; y < 33; y++) {
      for (let x = left; x < left + w; x++) {
        if (i === raisedQuote && (y > 12 || (y < 8 && x > left + 1))) continue
        const offset = (y * width + x) * 4
        data.fill(0, offset, offset + 3)
      }
    }
    left += w + (gaps[i] || 0)
  })
  return readMixedRowSpacing(text, [{ left: 0, right: width, top: 0, bottom: height }], {
    data,
    width,
    height,
    colorSpace: 'srgb'
  })
}

describe('readMixedRowSpacing', () => {
  it('requires optical separation before inserting a space at a script change', () => {
    expect(read('Hi您好', [22, 6, 26, 27], [3, 15, 3])).toBe('Hi 您好')
    expect(read('Hi您好', [22, 6, 26, 27], [3, 4, 3])).toBe('Hi您好')
  })

  it('measures the gap after a full-width wave dash', () => {
    expect(read('他～來', [27, 26, 27], [4, 13])).toBe('他～ 來')
    expect(read('他～來', [27, 26, 27], [4, 4])).toBe('他～來')
  })

  it('restores a curly quote only when there is a raised asymmetric stroke inside the word', () => {
    expect(read('say Ive', [17, 16, 19, 10, 5, 18, 16], [3, 3, 14, 3, 3, 3], 4)).toBe('say I‘ve')
    expect(read('say Ive', [17, 16, 19, 10, 5, 18, 16], [3, 3, 14, 3, 3, 3])).toBe('say Ive')
  })

  it('preserves typographic bearings around unspaced punctuation', () => {
    expect(read('來！來', [27, 5, 27], [13, 13])).toBe('來！來')
    expect(read('Hi(你)', [19, 6, 7, 27, 7], [3, 2, 12, 12])).toBe('Hi(你)')
  })

  it('checks neighboring Han centres before removing a comma bearing', () => {
    const widths = [27, 27, 27, 27, 4, 27, 27]
    expect(read('天下平安， 喜樂', widths, [4, 4, 4, 7, 24, 4])).toBe('天下平安，喜樂')
    expect(read('天下平安， 喜樂', widths, [4, 4, 4, 7, 33, 4])).toBe('天下平安， 喜樂')
  })

  it('requires a distinct gap between repeated Latin sequences', () => {
    expect(read('ABCABC', Array(6).fill(19), [3, 3, 8, 3, 3])).toBe('ABC ABC')
    expect(read('ABCABC', Array(6).fill(19), Array(5).fill(3))).toBe('ABCABC')
  })
})

describe('measureLyricsRow', () => {
  it('uses a padded perimeter when the detector ends inside the text', () => {
    const width = 80,
      height = 48,
      data = new Uint8ClampedArray(width * height * 4).fill(255)
    for (let y = 8; y < 40; y++) {
      for (let x = 8; x < 70; x++) {
        if (x % 20 > 15) continue
        const i = (y * width + x) * 4
        data.fill(0, i, i + 3)
      }
    }
    const row = measureLyricsRow([{ left: 1, right: 79, top: 9, bottom: 39 }], {
      width,
      height,
      data,
      colorSpace: 'srgb'
    })
    expect(row?.height).toBe(32)
  })

  it('excludes the cropped edge of the neighboring row and retains detached punctuation', () => {
    const width = 80,
      height = 52
    const data = new Uint8ClampedArray(width * height * 4).fill(255)
    for (let y = 0; y < height; y++) {
      for (let x = 1; x < width - 1; x++) {
        const neighbor = y < 3 && x % 12 < 6
        const word = y >= 12 && y < 46 && x >= 14 && x < 57
        const quote = y >= 8 && y < 11 && x >= 61 && x < 64
        if (neighbor || word || quote) {
          const i = (y * width + x) * 4
          data.fill(0, i, i + 3)
        }
      }
    }
    const row = measureLyricsRow([{ left: 0, right: width, top: 0, bottom: height }], {
      width,
      height,
      data,
      colorSpace: 'srgb'
    })
    expect(row?.inkTop).toBe(8)
    expect(row?.runs).toEqual([
      { left: 14, right: 57 },
      { left: 61, right: 64 }
    ])
  })
})
