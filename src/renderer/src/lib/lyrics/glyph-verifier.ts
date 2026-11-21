import { traditionalGlyphForEdit } from './lines'

// Validate the single optical edit independently so existing words and spaces
// survive normalization of an inserted or substituted simplified glyph.
export function validateGlyphChange(before: string, after: string): string {
  if (before === after) return before
  const source = [...before],
    proposed = [...after]
  const inserted = proposed.length - source.length
  if (inserted !== 0 && inserted !== 1) return before
  let index = 0
  while (index < source.length && source[index] === proposed[index]) index++
  const glyph = proposed[index]
  if (!glyph || !/^\p{Script=Han}$/u.test(glyph)) return before
  if (source.slice(index + 1 - inserted).join('') !== proposed.slice(index + 1).join(''))
    return before
  const offset = proposed.slice(0, index).join('').length
  const accepted = traditionalGlyphForEdit(after, offset, glyph)
  if (!accepted) return before
  proposed[index] = accepted
  return proposed.join('')
}

export function createGlyphVerifier(): {
  verify(image: ImageData, lines: string[]): Promise<string[] | null>
  dispose(): void
} {
  let worker: Worker | undefined
  let pending: ((result?: string[]) => void) | undefined
  let stopped = false

  function dispose(): void {
    stopped = true
    worker?.terminate()
    pending?.()
  }

  return {
    verify(image, lines) {
      if (stopped || !lines.some((line) => /^[\p{Script=Han} ]{3,}$/u.test(line)))
        return Promise.resolve(lines)
      if (pending) return Promise.resolve(null)
      return new Promise((resolve) => {
        // A slow local font lookup is still checking these pixels. Leave this cue
        // unconfirmed and sample the current source again when the worker is ready.
        const timeout = setTimeout(() => resolve(null), 10000)
        const watchdog = setTimeout(dispose, 60000)

        const complete = (result?: string[]): void => {
          if (pending !== complete) return
          clearTimeout(timeout)
          clearTimeout(watchdog)
          pending = undefined
          const verified =
            result?.length === lines.length
              ? result.map((text, i) => validateGlyphChange(lines[i], text))
              : undefined
          resolve(verified ?? lines)
        }
        pending = complete
        try {
          worker ??= new Worker(new URL('./glyph.worker.ts', import.meta.url), { type: 'module' })
          worker.onmessage = (event: MessageEvent<string[]>) => complete(event.data)
          worker.onerror = () => {
            if (pending === complete) dispose()
          }
          worker.postMessage({ image, lines })
        } catch {
          dispose()
        }
      })
    },
    dispose
  }
}
