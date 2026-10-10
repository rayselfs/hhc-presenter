import { cameraSourceKind } from '@shared/camera'
import { isElectron } from './env'

export function createCameraSession(
  media: Pick<MediaDevices, 'getUserMedia'> &
    Partial<Pick<MediaDevices, 'getDisplayMedia'>> = navigator.mediaDevices
): {
  getStream(): MediaStream | null
  selectSource(deviceId: string): Promise<MediaStream>
  stop(): void
  dispose(): void
} {
  let stream: MediaStream | null = null
  let revision = 0
  let disposed = false
  let pending: Promise<void> = Promise.resolve()

  function stop(): void {
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
  }

  return {
    getStream: (): MediaStream | null => stream,
    selectSource(deviceId: string): Promise<MediaStream> {
      if (disposed) return Promise.reject(new DOMException('Camera session closed', 'AbortError'))
      const request = ++revision
      stop()
      // getUserMedia cannot be aborted; serialize acquisition to avoid overlapping devices.
      const result = pending.then(async () => {
        if (disposed || request !== revision)
          throw new DOMException('Camera selection superseded', 'AbortError')
        const kind = cameraSourceKind(deviceId)
        if (kind !== 'video' && isElectron()) await window.api.capture.selectSource(deviceId)
        const captured =
          kind !== 'video'
            ? await media.getDisplayMedia!({
                audio: false,
                video: {
                  displaySurface: kind === 'screen' ? 'monitor' : 'window',
                  frameRate: { ideal: 30 }
                }
              })
            : await media.getUserMedia({
                audio: false,
                video: {
                  ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
                  width: { ideal: 1920 },
                  height: { ideal: 1080 },
                  frameRate: { ideal: 30 }
                }
              })
        if (disposed || request !== revision) {
          captured.getTracks().forEach((track) => track.stop())
          throw new DOMException('Camera selection superseded', 'AbortError')
        }
        stream = captured
        return captured
      })
      pending = result.then(
        () => undefined,
        () => undefined
      )
      return result
    },
    stop(): void {
      revision++
      stop()
    },
    dispose(): void {
      disposed = true
      revision++
      stop()
    }
  }
}
