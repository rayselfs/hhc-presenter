import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLyricsLayout } from '@renderer/lib/lyrics/use-lyrics-layout'
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
  const { weight, family, key, validated } = useLyricsLayout(output, onOverflow)
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
              fontFamily: family,
              fontSize: output.style.fontSize,
              lineHeight: output.style.lineHeight,
              fontWeight: weight,
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
