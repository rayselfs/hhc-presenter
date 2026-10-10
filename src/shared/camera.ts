export type CameraSourceKind = 'screen' | 'window' | 'video'
export type CameraSource = { id: string; label: string; kind: CameraSourceKind }

export function cameraSourceKind(id: string): CameraSourceKind {
  if (id.startsWith('screen:') || id.startsWith('browser:screen')) return 'screen'
  if (id.startsWith('window:') || id.startsWith('browser:window')) return 'window'
  return 'video'
}

export type CameraSignal = { sessionId: string } & (
  | { kind: 'offer' | 'answer'; sdp: string }
  | {
      kind: 'ice'
      candidate: {
        candidate: string
        sdpMid?: string | null
        sdpMLineIndex?: number | null
        usernameFragment?: string | null
      }
    }
)

export function isCameraSignal(value: unknown): value is CameraSignal {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.sessionId !== 'string' || v.sessionId.length === 0 || v.sessionId.length > 128)
    return false
  if (v.kind === 'offer' || v.kind === 'answer') {
    return typeof v.sdp === 'string' && v.sdp.length > 0 && v.sdp.length <= 65536
  }
  if (v.kind !== 'ice' || !v.candidate || typeof v.candidate !== 'object') return false
  const c = v.candidate as Record<string, unknown>
  return (
    typeof c.candidate === 'string' &&
    c.candidate.length <= 8192 &&
    (c.sdpMid == null || (typeof c.sdpMid === 'string' && c.sdpMid.length <= 256)) &&
    (c.usernameFragment == null ||
      (typeof c.usernameFragment === 'string' && c.usernameFragment.length <= 256)) &&
    (c.sdpMLineIndex == null ||
      (Number.isInteger(c.sdpMLineIndex) &&
        Number(c.sdpMLineIndex) >= 0 &&
        Number(c.sdpMLineIndex) <= 65535))
  )
}

export function isCameraSignalFrom(value: unknown, role: 'main' | 'projection'): boolean {
  return (
    isCameraSignal(value) &&
    (value.kind === 'ice' || value.kind === (role === 'main' ? 'offer' : 'answer'))
  )
}

export type CameraTransform = { x: number; y: number; width: number; height: number }
export type CameraState = {
  sessionId: string
  transform: CameraTransform
  status: 'connecting' | 'live' | 'unavailable'
}
export function isCameraState(value: unknown): value is CameraState {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (
    typeof v.sessionId !== 'string' ||
    !v.sessionId ||
    v.sessionId.length > 128 ||
    !['connecting', 'live', 'unavailable'].includes(String(v.status))
  )
    return false
  if (!v.transform || typeof v.transform !== 'object') return false
  const t = v.transform as Record<string, unknown>
  return (
    ['x', 'y', 'width', 'height'].every(
      (key) => typeof t[key] === 'number' && Number.isFinite(t[key]) && Math.abs(t[key]) <= 320000
    ) &&
    Number(t.width) > 0 &&
    Number(t.height) > 0
  )
}
export function isCameraMessageFrom(
  channel: string,
  value: unknown,
  role: 'main' | 'projection'
): boolean {
  if (channel === 'camera:signal') return isCameraSignalFrom(value, role)
  if (channel === 'camera:state') return role === 'main' && isCameraState(value)
  if (channel === 'camera:ready')
    return (
      role === 'projection' &&
      !!value &&
      typeof value === 'object' &&
      'sessionId' in value &&
      typeof value.sessionId === 'string' &&
      value.sessionId.length > 0 &&
      value.sessionId.length <= 128
    )
  return true
}
