import { useEffect, useState } from 'react'
import { loadPresentationFont } from '@renderer/lib/font-loader'
import type { LyricsOutput } from '@shared/lyrics'

export function useLyricsLayout(
  output: Pick<LyricsOutput, 'lines' | 'style'>,
  onOverflow?: (value: boolean) => void
): {
  weight: number
  family: string
  key: string
  validated: { key: string; overflow: boolean } | null
} {
  const [validated, setValidated] = useState<{ key: string; overflow: boolean } | null>(null)
  const weight = output.style.bold ? 700 : 400
  const family =
    output.style.font === 'sans-serif'
      ? 'sans-serif'
      : `${JSON.stringify(output.style.font)}, "Noto Sans TC Variable", sans-serif`
  const key = JSON.stringify({ lines: output.lines, style: output.style })
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await loadPresentationFont(output.style.font)
        if (output.style.font !== 'sans-serif') await loadPresentationFont('Noto Sans TC Variable')
        await document.fonts?.load(
          `${weight} ${output.style.fontSize}px ${family}`,
          output.lines.join('')
        )
        if (!active) return
        const context = document.createElement('canvas').getContext('2d')
        if (!context) throw new Error('Text measurement unavailable')
        context.font = `${weight} ${output.style.fontSize}px ${family}`
        const overflow =
          output.lines.some((line) => {
            const text = context.measureText(line)
            return (
              Math.max(
                text.width,
                (text.actualBoundingBoxLeft || 0) + (text.actualBoundingBoxRight || 0)
              ) > 1728
            )
          }) ||
          output.lines.length * output.style.fontSize * output.style.lineHeight >
            1080 * (0.95 - output.style.bottom / 100)
        setValidated({ key, overflow })
        onOverflow?.(overflow)
      } catch {
        if (active) {
          setValidated({ key, overflow: true })
          onOverflow?.(true)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [key, output.lines, output.style, onOverflow, family, weight])
  return { weight, family, key, validated }
}
