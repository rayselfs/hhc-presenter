import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const directory = resolve(process.argv[2] || `resources/speech/${process.platform}-${process.arch}`)
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
const filename = process.platform === 'win32' ? 'hhc-speech.exe' : 'hhc-speech'
if (
  manifest.protocol !== 1 ||
  manifest.target !== `${process.platform}-${process.arch}` ||
  manifest.filename !== filename
)
  throw new Error('Invalid speech runtime manifest')
const binary = join(directory, filename)
if (
  !(await stat(binary)).isFile() ||
  createHash('sha256')
    .update(await readFile(binary))
    .digest('hex') !== manifest.sha256
)
  throw new Error('Invalid speech runtime integrity')
const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 })
if (result.status !== 0 || result.stdout.trim() !== `hhc-speech/1 whisper/${manifest.revision}`)
  throw new Error('Speech runtime launch failed')
await readFile(join(directory, 'whisper-LICENSE'))
console.log(`Verified speech runtime ${manifest.target}`)
