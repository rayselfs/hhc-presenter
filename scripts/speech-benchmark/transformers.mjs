// Node CPU proxy for the existing Transformers.js model, not renderer/WASM timing.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { env, pipeline } from '@huggingface/transformers'

const [root, output, subset = 'all', limit] = process.argv.slice(2)
if (!root || !output) throw new Error('Usage: node transformers.mjs ROOT OUTPUT [all|screen]')
env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = path.join(root, 'models') + '/'
env.useBrowserCache = false
const start = performance.now()
const model = await pipeline('automatic-speech-recognition', 'transformers', {
  device: 'cpu',
  dtype: 'q8',
  session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 }
})
writeFileSync(
  output,
  JSON.stringify({
    type: 'metadata',
    engine: 'transformers-base-q8-node',
    version: env.version,
    load_s: (performance.now() - start) / 1000,
    threads: 4,
    subset,
    timing: 'Node CPU proxy; presegmented decode; not Electron renderer/WASM'
  }) + '\n'
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Plain JavaScript benchmark.
function pcm(file, expectedHash) {
  const data = readFileSync(file)
  if (createHash('sha256').update(data).digest('hex') !== expectedHash) {
    throw new Error(`Audio checksum mismatch: ${file}`)
  }
  if (data.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Expected WAV')
  for (let offset = 12; offset + 8 <= data.length; ) {
    const kind = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    if (
      kind === 'fmt ' &&
      (data.readUInt16LE(offset + 10) !== 1 ||
        data.readUInt32LE(offset + 12) !== 16000 ||
        data.readUInt16LE(offset + 22) !== 16)
    ) {
      throw new Error('Expected mono 16kHz PCM16')
    }
    if (kind === 'data') {
      const samples = new Float32Array(size / 2)
      for (let i = 0; i < samples.length; i++)
        samples[i] = data.readInt16LE(offset + 8 + i * 2) / 32768
      return samples
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('Missing PCM data')
}

let rows = JSON.parse(readFileSync(path.join(root, 'corpus.json'), 'utf8'))
if (subset === 'screen')
  rows = rows.filter((row) => row.split === 'calibration' || row.kind === 'negative')
if (limit) rows = rows.slice(0, Number(limit))
for (const [index, row] of rows.entries()) {
  const audio = pcm(path.join(root, 'audio', `${row.id}.wav`), row.sha256)
  const cpu = process.cpuUsage()
  const start = performance.now()
  const result = await model(audio, { language: row.language, task: 'transcribe' })
  const seconds = (performance.now() - start) / 1000
  const usage = process.cpuUsage(cpu)
  appendFileSync(
    output,
    JSON.stringify({
      ...row,
      transcript: result.text,
      decode_s: seconds,
      cpu_s: (usage.user + usage.system) / 1e6,
      rtf: seconds / row.duration_s,
      max_rss_bytes: process.resourceUsage().maxRSS * 1024
    }) + '\n'
  )
  if (index % 25 === 0)
    console.log(`${index + 1}/${rows.length} ${seconds.toFixed(3)}s ${result.text}`)
}
await model.dispose()
