/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const outputDir = join(process.cwd(), 'out', 'renderer')
const assetsDir = join(outputDir, 'assets')
const MAX_PRECACHE_BYTES = 5 * 1024 * 1024
const MAX_FONT_ASSETS_BYTES = 10 * 1024 * 1024
const MAX_JS_CHUNK_BYTES = 2.25 * 1024 * 1024
const MAX_LYRICS_RUNTIME_BYTES = 64 * 1024 * 1024
const OPTIONAL_CHUNK_PATTERN =
  /assets\/(pdf|transformers(?:\.web)?|microsoft\.cognitiveservices\.speech\.sdk)-.*\.js$/

async function listFiles(directory) {
  return Promise.all(
    (await readdir(directory, { withFileTypes: true })).flatMap((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? listFiles(path) : [path]
    })
  ).then((entries) => entries.flat())
}

const serviceWorker = await readFile(join(outputDir, 'sw.js'), 'utf8')
const precacheUrls = new Set(
  Array.from(serviceWorker.matchAll(/url:"([^"]+)"/g), (match) => match[1])
)
let precacheBytes = 0
for (const url of precacheUrls) {
  const filePath = join(outputDir, url.replace(/^\//, ''))
  precacheBytes += (await stat(filePath)).size
}

const assetFiles = await listFiles(assetsDir)
const lyricsFiles = await listFiles(join(outputDir, 'lyrics-runtime'))
const lyricsBytes = (
  await Promise.all(lyricsFiles.map(async (path) => (await stat(path)).size))
).reduce((sum, size) => sum + size, 0)
if (lyricsBytes > MAX_LYRICS_RUNTIME_BYTES) throw new Error('Optional OCR runtime budget exceeded')
let fontAssetBytes = 0
let largestJsChunk = { path: '', size: 0 }
for (const filePath of assetFiles) {
  const size = (await stat(filePath)).size
  if (filePath.endsWith('.woff2')) {
    fontAssetBytes += size
  }
  if (filePath.endsWith('.js') && size > largestJsChunk.size) {
    largestJsChunk = { path: filePath, size }
  }
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

console.log(`PWA precache: ${formatMiB(precacheBytes)} / ${formatMiB(MAX_PRECACHE_BYTES)}`)
console.log(`Font assets: ${formatMiB(fontAssetBytes)} / ${formatMiB(MAX_FONT_ASSETS_BYTES)}`)
console.log(
  `Largest JS chunk: ${formatMiB(largestJsChunk.size)} / ${formatMiB(MAX_JS_CHUNK_BYTES)}`
)

if (precacheBytes > MAX_PRECACHE_BYTES) {
  throw new Error('PWA precache budget exceeded')
}
if (fontAssetBytes > MAX_FONT_ASSETS_BYTES) {
  throw new Error('Font asset budget exceeded')
}
if (largestJsChunk.size > MAX_JS_CHUNK_BYTES) {
  throw new Error('JavaScript chunk budget exceeded')
}
if (
  Array.from(precacheUrls).some(
    (url) => OPTIONAL_CHUNK_PATTERN.test(url) || /lyrics-runtime\//.test(url)
  )
) {
  throw new Error('Optional dependency chunk must not be precached')
}
