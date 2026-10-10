import { createCameraSession } from '../camera-session'

function videoStream(): {
  stream: MediaStream
  track: { kind: string; readyState: string; stop: ReturnType<typeof vi.fn> }
} {
  const track = { kind: 'video', readyState: 'live', stop: vi.fn() }
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track]
  } as unknown as MediaStream
  return { stream, track }
}

it('captures only video and stops the old source before switching', async () => {
  const first = videoStream()
  const second = videoStream()
  const getUserMedia = vi
    .fn()
    .mockResolvedValueOnce(first.stream)
    .mockImplementationOnce(() => {
      expect(first.track.stop).toHaveBeenCalledOnce()
      return Promise.resolve(second.stream)
    })
  const session = createCameraSession({ getUserMedia })
  await session.selectSource('one')
  await session.selectSource('two')
  expect(getUserMedia).toHaveBeenLastCalledWith({
    audio: false,
    video: {
      deviceId: { exact: 'two' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 }
    }
  })
  expect(session.getStream()).toBe(second.stream)
  session.dispose()
  expect(second.track.stop).toHaveBeenCalledOnce()
  expect(session.getStream()).toBeNull()
})

it('serializes pending selections and stops superseded streams before opening another', async () => {
  const first = videoStream()
  const second = videoStream()
  let resolve!: (stream: MediaStream) => void
  const getUserMedia = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<MediaStream>((r) => {
          resolve = r
        })
    )
    .mockResolvedValueOnce(second.stream)
  const session = createCameraSession({ getUserMedia })
  const pending = session.selectSource('one')
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce())
  const latest = session.selectSource('two')
  expect(getUserMedia).toHaveBeenCalledOnce()
  resolve(first.stream)
  await rejected
  await latest
  expect(first.track.stop).toHaveBeenCalledOnce()
  expect(session.getStream()).toBe(second.stream)
  session.dispose()
})

it('releases a stream resolving after disposal and does not reopen a disposed session', async () => {
  const source = videoStream()
  let resolve!: (stream: MediaStream) => void
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((r) => {
        resolve = r
      })
  )
  const session = createCameraSession({ getUserMedia })
  const pending = session.selectSource('one')
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce())
  session.dispose()
  resolve(source.stream)
  await rejected
  expect(source.track.stop).toHaveBeenCalledOnce()
  await expect(session.selectSource('two')).rejects.toMatchObject({ name: 'AbortError' })
  expect(getUserMedia).toHaveBeenCalledOnce()
})

it('surfaces permission denial without retries or stale capture', async () => {
  const denied = new DOMException('Denied', 'NotAllowedError')
  const getUserMedia = vi.fn().mockRejectedValue(denied)
  const session = createCameraSession({ getUserMedia })
  await expect(session.selectSource('one')).rejects.toBe(denied)
  expect(getUserMedia).toHaveBeenCalledOnce()
  expect(session.getStream()).toBeNull()
})

it('captures display sources without requesting camera access and releases them on switching', async () => {
  const display = videoStream()
  const video = videoStream()
  const getUserMedia = vi.fn().mockResolvedValue(video.stream)
  const getDisplayMedia = vi.fn().mockResolvedValue(display.stream)
  const session = createCameraSession({ getUserMedia, getDisplayMedia })
  await session.selectSource('browser:screen')
  expect(getUserMedia).not.toHaveBeenCalled()
  expect(getDisplayMedia).toHaveBeenCalledWith({
    audio: false,
    video: { displaySurface: 'monitor', frameRate: { ideal: 30 } }
  })
  await session.selectSource('cam')
  expect(display.track.stop).toHaveBeenCalledOnce()
  session.dispose()
})
