import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { loadPresentationFont } from '@renderer/lib/font-loader'
import type { LyricsOutput as Output } from '@shared/lyrics'
export default function LyricsOutput({
  output,
  onOverflow
}: {
  output: Output
  onOverflow?: (value: boolean) => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)
  const [validated, setValidated] = useState<{ key: string; overflow: boolean } | null>(null)
  const key = JSON.stringify({ lines: output.lines, style: output.style })
  const subscribe = useCallback(
    (notify: () => void) => {
      const timer = setTimeout(
        notify,
        Math.min(2147483647, Math.max(0, output.expiresAt - Date.now()) + 1)
      )
      return () => clearTimeout(timer)
    },
    [output.expiresAt]
  )
  const expired = useSyncExternalStore(subscribe, () => Date.now() >= output.expiresAt)
  useEffect(() => {
    const update = (): void => setScale((box.current?.getBoundingClientRect().width ?? 0) / 1920)
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    if (box.current) observer?.observe(box.current)
    return () => observer?.disconnect()
  }, [])
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const family =
          output.style.font === 'sans-serif' ? 'sans-serif' : JSON.stringify(output.style.font)
        await loadPresentationFont(output.style.font)
        await document.fonts?.load(
          `600 ${output.style.fontSize}px ${family}`,
          output.lines.join('')
        )
        if (!active) return
        const context = document.createElement('canvas').getContext('2d')
        if (!context) throw new Error('Text measurement unavailable')
        context.font = `600 ${output.style.fontSize}px ${family}`
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
  }, [key, output.lines, output.style, onOverflow])
  const show = output.visible && !expired && validated?.key === key && !validated.overflow
  return (
    <div
      ref={box}
      data-testid="lyrics-output"
      data-overflow={validated?.overflow ?? false}
      className="relative h-full w-full overflow-hidden bg-black"
    >
      <div
        style={{
          width: 1920,
          height: 1080,
          position: 'absolute',
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          background: '#000',
          color: '#fff'
        }}
      >
        {show && (
          <div
            data-testid="lyrics-lines"
            style={{
              position: 'absolute',
              left: 96,
              right: 96,
              bottom: `${output.style.bottom}%`,
              fontFamily: output.style.font,
              fontSize: output.style.fontSize,
              lineHeight: output.style.lineHeight,
              fontWeight: 600,
              textAlign: 'center'
            }}
          >
            {output.lines.map((line, index) => (
              <div
                data-testid="lyrics-line"
                key={index}
                style={{ whiteSpace: 'pre', minHeight: '1em' }}
              >
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
