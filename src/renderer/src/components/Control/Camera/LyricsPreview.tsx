import { useEffect, useRef, useState } from 'react'
import { useCameraLyricsStore } from '@renderer/stores/camera-lyrics'

export default function LyricsPreview({
  stream
}: {
  stream: MediaStream | null
}): React.JSX.Element {
  const crop = useCameraLyricsStore((state) => state.crop)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [ratio, setRatio] = useState('16 / 9')
  useEffect(() => {
    const video = videoRef.current
    if (!video || !stream) return
    video.srcObject = stream
    void video.play().catch(() => undefined)
    return () => {
      video.srcObject = null
    }
  }, [stream])
  return (
    <div
      data-testid="lyrics-source-preview"
      className="relative w-full max-w-xl self-center overflow-hidden bg-black"
      style={{ aspectRatio: ratio }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="absolute inset-0 h-full w-full object-contain"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget
          if (video.videoWidth && video.videoHeight)
            setRatio(`${video.videoWidth} / ${video.videoHeight}`)
        }}
      />
      <div
        data-testid="lyrics-crop-overlay"
        className="pointer-events-none absolute border-2 border-accent"
        style={{
          left: crop.x * 100 + '%',
          top: crop.y * 100 + '%',
          width: crop.width * 100 + '%',
          height: crop.height * 100 + '%'
        }}
      />
    </div>
  )
}
