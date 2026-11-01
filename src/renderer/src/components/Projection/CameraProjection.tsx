import { useEffect, useState } from 'react'
import LyricsOutput from '@renderer/components/Common/LyricsOutput'
import CameraStage from '@renderer/components/Common/CameraStage'
import { createCameraPeer } from '@renderer/lib/camera-peer'
import { createProjectionAdapter } from '@renderer/lib/projection-adapter'
import type { CameraState } from '@shared/camera'

export default function CameraProjection({
  camera,
  generation,
  browserSessionId
}: {
  camera: CameraState
  generation: number
  browserSessionId: string
}): React.JSX.Element {
  const [received, setReceived] = useState<{ sessionId: string; stream: MediaStream } | null>(null)
  const { sessionId } = camera
  const lyricsMode = camera.lyrics !== undefined
  useEffect(() => {
    if (lyricsMode) return
    const adapter = createProjectionAdapter('projection', browserSessionId)
    adapter.setGeneration(generation)
    let active = true
    const peer = createCameraPeer({
      role: 'projection',
      sessionId,
      sendSignal: (signal) => adapter.send('camera:signal', signal),
      onStream: (stream) => {
        if (active) setReceived({ sessionId, stream })
      },
      onStateChange: (state) => {
        if (active && (state === 'failed' || state === 'disconnected' || state === 'closed'))
          setReceived(null)
      }
    })
    const unsubscribe = adapter.on('camera:signal', (signal) => {
      void peer.acceptSignal(signal).catch(() => {
        if (active) setReceived(null)
      })
    })
    adapter.send('camera:ready', { sessionId })
    return () => {
      active = false
      unsubscribe()
      peer.dispose()
      adapter.dispose()
    }
  }, [sessionId, generation, browserSessionId, lyricsMode])
  return (
    <div
      className="grid h-screen w-screen place-items-center bg-black"
      data-testid="camera-projection"
    >
      <div
        className="relative"
        style={{ width: 'min(100vw, 177.777778vh)', aspectRatio: '16 / 9' }}
      >
        {camera.lyrics ? (
          <LyricsOutput
            output={{
              ...camera.lyrics,
              visible: camera.status !== 'unavailable' && camera.lyrics.visible
            }}
          />
        ) : (
          <CameraStage
            stream={
              camera.status !== 'unavailable' && received?.sessionId === sessionId
                ? received.stream
                : null
            }
            transform={camera.transform}
          />
        )}
      </div>
    </div>
  )
}
