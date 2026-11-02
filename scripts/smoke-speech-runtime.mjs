/* eslint-disable @typescript-eslint/explicit-function-return-type -- Real native smoke. */
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
const root = resolve(process.argv[2] || '.local-runtimes/speech-smoke-models')
const binary = resolve(
  `resources/speech/${process.platform}-${process.arch}/hhc-speech${process.platform === 'win32' ? '.exe' : ''}`
)
const models = [
  [
    'zh',
    'ggml-large-v3-turbo-q5_0.bin',
    '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
  ],
  ['en', 'ggml-small.bin', '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b']
]
async function digest(path) {
  try {
    const hash = createHash('sha256')
    for await (const data of createReadStream(path)) hash.update(data)
    return hash.digest('hex')
  } catch {
    return null
  }
}
function pcm(wav) {
  let offset = 12
  while (offset + 8 <= wav.length) {
    const size = wav.readUInt32LE(offset + 4)
    if (wav.toString('ascii', offset, offset + 4) === 'data') {
      const samples = new Float32Array(size / 2)
      for (let i = 0; i < samples.length; i++)
        samples[i] = wav.readInt16LE(offset + 8 + i * 2) / 32768
      return samples
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('Invalid smoke WAV')
}
await mkdir(root, { recursive: true })
const results = []
for (const [language, filename, hash] of models) {
  const model = join(root, filename)
  if ((await digest(model)) !== hash) {
    const temporary = `${model}.part`
    try {
      const response = await fetch(
        `https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/${filename}`,
        { signal: AbortSignal.timeout(10 * 60 * 1000) }
      )
      if (!response.ok || !response.body) throw new Error('Model download failed')
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary))
      if ((await digest(temporary)) !== hash) throw new Error('Model hash mismatch')
      await rename(temporary, model)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  const start = performance.now()
  const child = spawn(binary, [model, language], { stdio: 'pipe', windowsHide: true })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  child.stderr.on('data', () => {})
  const timeout = setTimeout(() => child.kill(), 120000)
  try {
    const ready = JSON.parse((await lines.next()).value)
    if (!ready.ready || ready.protocol !== 1) throw new Error('Not ready')
    const readyMs = performance.now() - start
    const input = pcm(await readFile(`native/speech/fixtures/${language}.wav`))
    const header = Buffer.alloc(4)
    header.writeUInt32LE(input.length)
    const before = performance.now()
    child.stdin.write(Buffer.concat([header, Buffer.from(input.buffer)]))
    const answer = JSON.parse((await lines.next()).value)
    if (typeof answer.text !== 'string' || !Number.isFinite(answer.asrMs) || !answer.text.trim())
      throw new Error('Invalid native transcript')
    if (
      language === 'zh'
        ? !/[創创].*[世].*[記纪紀]/u.test(answer.text)
        : !/genesis/i.test(answer.text)
    )
      throw new Error('Native fixture recognition regressed')
    results.push({
      language,
      readyMs,
      processingMs: performance.now() - before,
      text: answer.text,
      nativeMs: answer.asrMs
    })
    // A second request proves the model stays resident and binary framing remains synchronized.
    header.writeUInt32LE(16000)
    child.stdin.write(Buffer.concat([header, Buffer.alloc(16000 * 4)]))
    if (JSON.parse((await lines.next()).value).text !== '') throw new Error('Silence hallucinated')
    child.stdin.end()
    const exit = await new Promise((resolve, reject) => {
      child.on('exit', resolve)
      child.on('error', reject)
    })
    if (exit !== 0) throw new Error('Native shutdown failed')
  } finally {
    clearTimeout(timeout)
    child.kill()
  }
}
console.log(JSON.stringify({ target: `${process.platform}-${process.arch}`, results }, null, 2))
