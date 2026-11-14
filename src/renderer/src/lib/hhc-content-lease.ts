import { watchHhcSourceDeadline } from '@shared/hhc-assets'
import { HhcAssetApiError } from './hhc-asset-api'
import type { SyncRemoteContentSource } from './sync-provider'

const leases = new Map<string, () => void>()
const MAX_BYTES = 200 * 1024 * 1024

export function releaseHhcBrowserLease(url: string): void {
  leases.get(url)?.()
  leases.delete(url)
  URL.revokeObjectURL(url)
}

export async function createHhcBrowserLease(
  response: Response,
  deadline: number,
  etag: string
): Promise<SyncRemoteContentSource> {
  if (!Number.isFinite(deadline) || deadline <= Date.now())
    throw new HhcAssetApiError('access-revoked', 410, 'item-expired')
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BYTES || !response.body)
    throw new HhcAssetApiError('fatal')
  const reader = response.body.getReader()
  const chunks: ArrayBuffer[] = []
  let size = 0
  const stop = watchHhcSourceDeadline(deadline, () => {
    void reader.cancel().catch(() => undefined)
  })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (deadline <= Date.now()) throw new HhcAssetApiError('access-revoked', 410, 'item-expired')
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new HhcAssetApiError('fatal')
      chunks.push(new Uint8Array(value).buffer)
    }
    if (!size || (declared > 0 && size !== declared)) throw new HhcAssetApiError('retryable')
  } finally {
    stop()
    await reader.cancel().catch(() => undefined)
  }
  const url = URL.createObjectURL(
    new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' })
  )
  leases.set(
    url,
    watchHhcSourceDeadline(deadline, () => releaseHhcBrowserLease(url))
  )
  return { kind: 'browser-lease', url, sourceExpiresAt: deadline, etag }
}
