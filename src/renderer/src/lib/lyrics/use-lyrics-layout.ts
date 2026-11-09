import { useEffect, useState } from 'react'
import { loadPresentationFont } from '@renderer/lib/font-loader'
import type { LyricsOutput } from '@shared/lyrics'

type ValidatedLayout = {
  overflow: boolean
  output: Pick<LyricsOutput, 'lines' | 'style'>
  weight: number
  family: string
}

export function useLyricsLayout(
  output: Pick<LyricsOutput, 'lines' | 'style'>,
  onOverflow?: (value: boolean) => void
): {
  validated: ValidatedLayout | null
} {
  const { lines, style } = output
  const [validated, setValidated] = useState<ValidatedLayout | null>(null)
  if (!lines.length && validated?.output.lines.length) setValidated(null)
  const weight = style.bold ? 700 : 400
  const family =
    style.font === 'sans-serif'
      ? 'sans-serif'
      : `${JSON.stringify(style.font)}, "Noto Sans TC Variable", sans-serif`
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await loadPresentationFont(style.font)
        if (style.font !== 'sans-serif') await loadPresentationFont('Noto Sans TC Variable')
        await document.fonts?.load(`${weight} ${style.fontSize}px ${family}`, lines.join(''))
        if (!active) return
        const context = document.createElement('canvas').getContext('2d')
        if (!context) throw new Error('Text measurement unavailable')
        context.font = `${weight} ${style.fontSize}px ${family}`
        const overflow =
          lines.some((line) => {
            const text = context.measureText(line)
            return (
              Math.max(
                text.width,
                (text.actualBoundingBoxLeft || 0) + (text.actualBoundingBoxRight || 0)
              ) > 1728
            )
          }) ||
          lines.length * style.fontSize * style.lineHeight > 1080 * (0.95 - style.bottom / 100)
        setValidated({ overflow, output: { lines, style }, weight, family })
        onOverflow?.(overflow)
      } catch {
        if (active) {
          setValidated({ overflow: true, output: { lines, style }, weight, family })
          onOverflow?.(true)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [lines, style, onOverflow, family, weight])
  return { validated }
}
