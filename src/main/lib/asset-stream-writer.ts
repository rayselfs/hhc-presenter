import { readHhcSourceDeadline, watchHhcSourceDeadline } from '@shared/hhc-assets'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

const MAX_CONTENT_BYTES = 200 * 1024 * 1024

export async function saveAssetContent(
  response: Response,
  destinationPath: string,
  signal?: AbortSignal
): Promise<{ size: number; mimeType: string; etag: string; sourceExpiresAt?: number }> {
  const sourceExpiresAt = readHhcSourceDeadline(response.headers)
  const declaredSize = Number(response.headers.get('content-length') ?? 0)
  if (!Number.isFinite(declaredSize) || declaredSize < 0 || declaredSize > MAX_CONTENT_BYTES) {
    throw new Error('HHC_ASSET_FATAL')
  }
  if (!response.body) throw new Error('HHC_ASSET_FATAL')

  await fs.mkdir(dirname(destinationPath), { recursive: true })
  const file = await fs.open(destinationPath, 'wx')
  const reader = response.body.getReader()
  let size = 0
  const expired = (): boolean => sourceExpiresAt !== undefined && sourceExpiresAt <= Date.now()
  const stop =
    sourceExpiresAt === undefined
      ? () => undefined
      : watchHhcSourceDeadline(sourceExpiresAt, () => {
          void reader.cancel().catch(() => undefined)
        })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (expired()) throw new Error('HHC_SOURCE_FAILURE:410:item-expired')
      if (done) break
      if (signal?.aborted) throw new Error('HHC_ASSET_DOWNLOAD_CANCELLED')
      if (!value) continue
      size += value.byteLength
      if (size > MAX_CONTENT_BYTES) throw new Error('HHC_ASSET_FATAL')
      await file.writeFile(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (signal?.aborted) throw new Error('HHC_ASSET_DOWNLOAD_CANCELLED')
    throw error
  } finally {
    stop()
    await file.close()
  }
  if ((declaredSize > 0 && size !== declaredSize) || size === 0) {
    await fs.rm(destinationPath, { force: true })
    throw new Error('HHC_ASSET_FATAL')
  }
  if (signal?.aborted) throw new Error('HHC_ASSET_DOWNLOAD_CANCELLED')
  return {
    ...(sourceExpiresAt === undefined ? {} : { sourceExpiresAt }),
    size,
    mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
    etag: response.headers.get('etag') ?? ''
  }
}
