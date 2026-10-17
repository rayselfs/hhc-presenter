import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

const MAX_CONTENT_BYTES = 200 * 1024 * 1024

export async function saveAssetContent(
  response: Response,
  destinationPath: string,
  signal?: AbortSignal
): Promise<{ size: number; mimeType: string; etag: string }> {
  const declaredSize = Number(response.headers.get('content-length') ?? 0)
  if (!Number.isFinite(declaredSize) || declaredSize < 0 || declaredSize > MAX_CONTENT_BYTES) {
    throw new Error('HHC_ASSET_FATAL')
  }
  if (!response.body) throw new Error('HHC_ASSET_FATAL')

  await fs.mkdir(dirname(destinationPath), { recursive: true })
  const file = await fs.open(destinationPath, 'wx')
  const reader = response.body.getReader()
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
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
    await file.close()
  }
  if ((declaredSize > 0 && size !== declaredSize) || size === 0) {
    await fs.rm(destinationPath, { force: true })
    throw new Error('HHC_ASSET_FATAL')
  }
  if (signal?.aborted) throw new Error('HHC_ASSET_DOWNLOAD_CANCELLED')
  return {
    size,
    mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
    etag: response.headers.get('etag') ?? ''
  }
}
