/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { normalizeOcrPipelineConfig } from '@paddleocr/paddleocr-js'
const output = resolve('src/renderer/public/lyrics-runtime')
await mkdir(output, { recursive: true })
const sdkRoot = resolve('node_modules/@paddleocr/paddleocr-js')
const sdk = JSON.parse(await readFile(resolve(sdkRoot, 'package.json'), 'utf8'))
if (sdk.version !== '0.4.2') throw new Error('Revalidate the OCR worker transport before upgrading')
const ort = JSON.parse(await readFile(resolve('node_modules/onnxruntime-web/package.json'), 'utf8'))
if (ort.version !== '1.24.3')
  throw new Error('Revalidate the pinned OCR WASM runtime before upgrading')
const entry = (await readdir(resolve(sdkRoot, 'dist/assets'))).find((name) =>
  /^worker-entry-.*\.js$/.test(name)
)
if (!entry) throw new Error('OCR worker entry missing')
await copyFile(resolve(sdkRoot, 'dist/assets', entry), resolve(output, 'ocr-worker.js'))
for (const name of await readdir(resolve('resources/licenses/lyrics-ocr'))) {
  await copyFile(resolve('resources/licenses/lyrics-ocr', name), resolve(output, name))
}
const pipelineConfig = normalizeOcrPipelineConfig({
  pipeline_name: 'OCR',
  text_type: 'general',
  SubModules: {
    TextDetection: {
      model_name: 'PP-OCRv5_mobile_det',
      model_dir: { url: 'det.tar' },
      limit_side_len: 64,
      limit_type: 'min',
      max_side_limit: 4000,
      thresh: 0.3,
      box_thresh: 0.6,
      unclip_ratio: 1.5
    },
    TextRecognition: {
      model_name: 'PP-OCRv6_small_rec',
      model_dir: { url: 'rec.tar' },
      batch_size: 6,
      score_thresh: 0
    }
  }
})
await writeFile(resolve(output, 'pipeline.json'), JSON.stringify(pipelineConfig))

for (const name of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  await copyFile(resolve('node_modules/onnxruntime-web/dist', name), resolve(output, name))
}
const origin =
  'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/'
for (const [slot, name, digest] of [
  [
    'det',
    'PP-OCRv5_mobile_det',
    '781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30'
  ],
  ['rec', 'PP-OCRv6_small_rec', 'd267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1']
]) {
  const path = resolve(output, `${slot}.tar`)
  let bytes
  try {
    bytes = await readFile(path)
  } catch {
    /* Download the pinned public model on first build. */
  }
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  if (!bytes || hash(bytes) !== digest) {
    const response = await fetch(`${origin}${name}_onnx_infer.tar`, {
      signal: AbortSignal.timeout(120000)
    })
    if (!response.ok) throw new Error(`OCR model download failed: ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
    if (hash(bytes) !== digest) throw new Error(`OCR ${slot} model checksum mismatch`)
    await writeFile(path, bytes)
  }
}
console.log('Verified pinned OCR models and local WASM runtime')
