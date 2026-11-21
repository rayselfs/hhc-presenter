import { createGlyphMatcher } from './glyph-match'

const match = createGlyphMatcher()
self.onmessage = ({ data }: MessageEvent<{ image: ImageData; lines: string[] }>) => {
  let result = data.lines
  try {
    result = match(data.image, data.lines)
  } finally {
    self.postMessage(result)
  }
}
