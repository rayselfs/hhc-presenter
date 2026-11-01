import { net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const runtimeFiles = new Set([
  'pipeline.json',
  'ocr-worker.js',
  'det.tar',
  'rec.tar',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm'
])
export function lyricsAssetPath(root: string, input: string): string | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (
    url.protocol !== 'hhc-lyrics:' ||
    url.host !== 'runtime' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null
  const match = /^\/(lyrics-runtime)\/([a-zA-Z0-9_.-]+)$/.exec(url.pathname)
  if (!match) return null
  const [, folder, name] = match
  if (!runtimeFiles.has(name)) return null
  return join(root, folder, name)
}
export function registerLyricsProtocol(root: string): void {
  protocol.handle('hhc-lyrics', async (request) => {
    if (request.method !== 'GET') return new Response(null, { status: 405 })
    const path = lyricsAssetPath(root, request.url)
    if (!path) return new Response(null, { status: 404 })
    try {
      const response = await net.fetch(pathToFileURL(path).href)
      const headers = new Headers(response.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      headers.set(
        'Content-Type',
        path.endsWith('.wasm')
          ? 'application/wasm'
          : /\.m?js$/.test(path)
            ? 'application/javascript'
            : 'application/octet-stream'
      )
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
