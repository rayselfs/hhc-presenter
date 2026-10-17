import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveAssetContent } from '../../lib/asset-stream-writer'

let directory: string
let destination: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hhc-stream-writer-'))
  destination = join(directory, 'download.part')
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('writes actual stream bytes with the existing metadata and exclusive destination contract', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const response = new Response(bytes, {
    headers: {
      'content-length': '3',
      'content-type': 'image/png',
      etag: 'revision-1'
    }
  })
  await expect(saveAssetContent(response, destination)).resolves.toEqual({
    size: 3,
    mimeType: 'image/png',
    etag: 'revision-1'
  })
  expect(await readFile(destination)).toEqual(Buffer.from(bytes))
  await expect(saveAssetContent(new Response(bytes), destination)).rejects.toMatchObject({
    code: 'EEXIST'
  })
  expect(await readFile(destination)).toEqual(Buffer.from(bytes))
})
it.each(['-1', 'NaN', String(200 * 1024 * 1024 + 1)])(
  'rejects invalid declared length %s before creating a file',
  async (length) => {
    await expect(
      saveAssetContent(new Response('x', { headers: { 'content-length': length } }), destination)
    ).rejects.toThrow('HHC_ASSET_FATAL')
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  }
)
it.each([
  ['', '0'],
  ['abc', '4']
])('removes an empty or truncated completed staging file (%j)', async (bytes, length) => {
  await expect(
    saveAssetContent(new Response(bytes, { headers: { 'content-length': length } }), destination)
  ).rejects.toThrow('HHC_ASSET_FATAL')
  await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('cancels an actual oversized stream before writing its overflowing chunk', async () => {
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(200 * 1024 * 1024 + 1))
    },
    cancel
  })
  await expect(saveAssetContent(new Response(stream), destination)).rejects.toThrow(
    'HHC_ASSET_FATAL'
  )
  expect(cancel).toHaveBeenCalledOnce()
  expect((await stat(destination)).size).toBe(0)
})
it('preserves cancellation error semantics and cancels the reader on abort', async () => {
  const abort = new AbortController()
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      abort.abort()
    },
    cancel
  })
  await expect(saveAssetContent(new Response(stream), destination, abort.signal)).rejects.toThrow(
    'HHC_ASSET_DOWNLOAD_CANCELLED'
  )
  expect(cancel).toHaveBeenCalledOnce()
})
it('propagates a failed body and leaves caller-owned staging cleanup possible', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('connection ended'))
    }
  })
  await expect(saveAssetContent(new Response(stream), destination)).rejects.toThrow(
    'connection ended'
  )
  await rm(destination)
  await writeFile(destination, 'recovered', { flag: 'wx' })
  expect(await readFile(destination, 'utf8')).toBe('recovered')
})
