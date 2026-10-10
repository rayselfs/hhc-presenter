import { isElectron } from '@renderer/lib/env'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useProjection } from './ProjectionContext'
import { createCameraSession } from '@renderer/lib/camera-session'
import { createCameraPeer } from '@renderer/lib/camera-peer'
import { createCameraCover } from '@renderer/lib/camera-transform'
import { useCameraStore } from '@renderer/stores/camera'
import { cameraSourceKind, type CameraState } from '@shared/camera'

interface CameraContextValue {
  stream: MediaStream | null
  selectSource(deviceId: string): Promise<void>
  prepareSources(): Promise<void>
  reset(): void
  retry(): void
}
const Context = createContext<CameraContextValue | null>(null)

export function CameraSessionProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const { pathname } = useLocation()
  const { activeOwner, isProjectionOpen, recovery, projectionReadyCount, on, send } =
    useProjection()
  const session = useRef<ReturnType<typeof createCameraSession> | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [retry, setRetry] = useState(0)
  const projecting = activeOwner === 'camera' && isProjectionOpen
  const keepCapture = pathname === '/camera' || projecting

  useEffect(() => {
    if (!keepCapture) return
    session.current = createCameraSession()
    return () => {
      session.current?.dispose()
      session.current = null
      setStream(null)
      useCameraStore.setState({
        capturing: false,
        busy: false,
        selectorOpen: false,
        connection: 'idle'
      })
    }
  }, [keepCapture])

  const listDevices = useCallback(async (): Promise<void> => {
    const current = session.current
    if (!current) return
    const devices = await navigator.mediaDevices?.enumerateDevices()
    if (session.current !== current) return
    useCameraStore.setState({
      devices:
        devices
          ?.filter((d) => d.kind === 'videoinput')
          .map((d, index) => ({ id: d.deviceId, label: d.label || `Camera ${index + 1}` })) ?? []
    })
  }, [])
  useEffect(() => {
    if (pathname !== '/camera') return
    const changed = (): void => {
      void listDevices().catch(() => undefined)
    }
    navigator.mediaDevices?.addEventListener('devicechange', changed)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', changed)
  }, [pathname, listDevices])

  const selectSource = useCallback(
    async (deviceId: string): Promise<void> => {
      const current = session.current
      if (!current || !navigator.mediaDevices) {
        useCameraStore.setState({ error: 'unavailable' })
        return
      }
      useCameraStore.setState({ busy: true, capturing: false, error: null, deviceId })
      setStream(null)
      try {
        const next = await current.selectSource(deviceId)
        if (session.current !== current) return
        const track = next.getVideoTracks()[0]
        const settings = track.getSettings()
        const cover = createCameraCover(settings.width ?? 1920, settings.height ?? 1080)
        const requestedKind = cameraSourceKind(deviceId)
        const kind =
          requestedKind !== 'video' && !isElectron() && settings.displaySurface
            ? settings.displaySurface === 'monitor'
              ? 'screen'
              : 'window'
            : requestedKind
        // shortcut: browsers expose labels, not stable desktop IDs; identical labels share framing.
        const sourceId =
          kind === 'video'
            ? (settings.deviceId ?? deviceId)
            : isElectron()
              ? deviceId
              : `browser:${kind}:${track.label}`
        useCameraStore.getState().activateSource(sourceId, cover)
        useCameraStore.setState({
          busy: false,
          capturing: true
        })
        track.addEventListener(
          'ended',
          () => {
            if (session.current !== current || current.getStream() !== next) return
            setStream(null)
            useCameraStore.setState({ error: 'ended', capturing: false, connection: 'unavailable' })
          },
          { once: true }
        )
        setStream(next)
        await listDevices()
      } catch (error) {
        if (
          session.current !== current ||
          (error instanceof DOMException && error.name === 'AbortError')
        )
          return
        useCameraStore.setState({
          busy: false,
          error: error instanceof Error ? error.name : 'unavailable'
        })
      }
    },
    [listDevices]
  )

  useEffect(() => {
    if (pathname !== '/camera' || session.current?.getStream()) return
    let cancelled = false
    const restore = async (): Promise<void> => {
      const last = useCameraStore.getState().lastDeviceId
      if (cameraSourceKind(last) !== 'video') {
        useCameraStore.setState({ sourceKind: cameraSourceKind(last) })
        if (!isElectron()) return
        const desktopSources = await window.api.capture.getSources()
        if (
          cancelled ||
          useCameraStore.getState().busy ||
          session.current?.getStream() ||
          useCameraStore.getState().lastDeviceId !== last
        )
          return
        useCameraStore.setState({ desktopSources })
        if (desktopSources.some((source) => source.id === last)) await selectSource(last)
        else useCameraStore.setState({ error: 'NotFoundError' })
        return
      }
      await listDevices()
      if (cancelled || useCameraStore.getState().busy || session.current?.getStream()) return
      const { lastDeviceId, devices } = useCameraStore.getState()
      if (!lastDeviceId) return
      if (devices.some((device) => device.id === lastDeviceId)) {
        await selectSource(lastDeviceId)
      } else {
        useCameraStore.setState({ error: 'NotFoundError' })
      }
    }
    void restore().catch(() => {
      if (!cancelled) useCameraStore.setState({ error: 'unavailable' })
    })
    return () => {
      cancelled = true
    }
  }, [pathname, listDevices, selectSource])

  useEffect(() => {
    if (!projecting || recovery.status !== 'ready' || !stream) {
      useCameraStore.setState({ connection: projecting ? 'unavailable' : 'idle' })
      return
    }
    let disposed = false
    let peer: ReturnType<typeof createCameraPeer> | null = null
    let sessionId = ''
    let retries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let frame: number | undefined
    const publish = (status: CameraState['status']): void => {
      send('camera:state', { sessionId, transform: useCameraStore.getState().transform, status })
    }
    const fail = (): void => {
      if (disposed || timer) return
      if (watchdog) clearTimeout(watchdog)
      useCameraStore.setState({ connection: 'unavailable' })
      publish('unavailable')
      if (retries++ >= 3) {
        useCameraStore.setState({ error: 'connection' })
        return
      }
      timer = setTimeout(() => {
        timer = undefined
        connect()
      }, 1000)
    }
    const connect = (): void => {
      if (disposed) return
      peer?.dispose()
      sessionId = crypto.randomUUID()
      useCameraStore.setState({ connection: 'connecting', error: null })
      peer = createCameraPeer({
        role: 'main',
        sessionId,
        sendSignal: (signal) => send('camera:signal', signal),
        onStream: () => undefined,
        onStateChange: (state) => {
          if (disposed) return
          if (state === 'connected') {
            if (watchdog) clearTimeout(watchdog)
            if (timer) {
              clearTimeout(timer)
              timer = undefined
            }
            useCameraStore.setState({ connection: 'live' })
            publish('live')
          }
          if (state === 'failed' || state === 'disconnected') fail()
        }
      })
      publish('connecting')
      watchdog = setTimeout(fail, 8000)
    }
    const unready = on('camera:ready', (message) => {
      if (message.sessionId === sessionId) void peer?.start(stream).catch(fail)
    })
    const unsignal = on('camera:signal', (message) => {
      void peer?.acceptSignal(message).catch(fail)
    })
    const unstore = useCameraStore.subscribe((next, previous) => {
      if (next.transform === previous.transform || frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        const status = useCameraStore.getState().connection
        publish(
          status === 'live' ? 'live' : status === 'unavailable' ? 'unavailable' : 'connecting'
        )
      })
    })
    connect()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      if (watchdog) clearTimeout(watchdog)
      if (frame !== undefined) cancelAnimationFrame(frame)
      publish('unavailable')
      peer?.dispose()
      unready()
      unsignal()
      unstore()
    }
  }, [
    projecting,
    recovery.status,
    recovery.generation,
    projectionReadyCount,
    stream,
    retry,
    on,
    send
  ])

  useEffect(() => {
    if (
      !keepCapture ||
      !stream ||
      !isElectron() ||
      cameraSourceKind(useCameraStore.getState().deviceId) === 'video'
    )
      return
    const current = session.current
    let cancelled = false
    void window.api.capture
      .getSources()
      .then((desktopSources) => {
        if (cancelled || session.current !== current) return
        useCameraStore.setState({ desktopSources })
        const { deviceId, capturing } = useCameraStore.getState()
        if (
          capturing &&
          cameraSourceKind(deviceId) !== 'video' &&
          !desktopSources.some((source) => source.id === deviceId)
        ) {
          current?.stop()
          setStream(null)
          useCameraStore.setState({
            capturing: false,
            connection: 'unavailable',
            error: 'sourceExcluded'
          })
        }
      })
      .catch(() => {
        if (cancelled || session.current !== current) return
        current?.stop()
        setStream(null)
        useCameraStore.setState({
          capturing: false,
          connection: 'unavailable',
          error: 'unavailable'
        })
      })
    return () => {
      cancelled = true
    }
  }, [keepCapture, isProjectionOpen, recovery.generation, stream])

  const prepareSources = async (): Promise<void> => {
    const current = session.current
    if (!current || useCameraStore.getState().busy) return
    useCameraStore.setState({ busy: true, error: null })
    try {
      if (useCameraStore.getState().sourceKind !== 'video') {
        if (isElectron()) {
          const desktopSources = await window.api.capture.getSources()
          if (session.current === current) useCameraStore.setState({ desktopSources })
        }
        return
      }
      await listDevices()
      if (session.current !== current) return
      const devices = useCameraStore.getState().devices
      if (!devices.some((device) => device.id)) {
        // Permission discovery does not select or retain a default camera.
        const permissionStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        })
        permissionStream.getTracks().forEach((track) => track.stop())
        if (session.current !== current) return
        await listDevices()
      }
      if (!useCameraStore.getState().devices.some((device) => device.id))
        useCameraStore.setState({ error: 'NotFoundError' })
    } catch (error) {
      if (session.current !== current) return
      useCameraStore.setState({ error: error instanceof Error ? error.name : 'unavailable' })
    } finally {
      if (session.current === current) useCameraStore.setState({ busy: false })
    }
  }
  return (
    <Context.Provider
      value={{
        stream,
        selectSource,
        prepareSources,
        reset: () => useCameraStore.getState().updateTransform(useCameraStore.getState().cover),
        retry: () => setRetry((value) => value + 1)
      }}
    >
      {children}
    </Context.Provider>
  )
}
// eslint-disable-next-line react-refresh/only-export-components
export function useCameraSession(): CameraContextValue {
  const context = useContext(Context)
  if (!context) throw new Error('CameraSessionProvider is required')
  return context
}
