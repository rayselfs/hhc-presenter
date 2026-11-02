/* eslint-disable @typescript-eslint/explicit-function-return-type -- Build tool. */
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const target = `${process.platform}-${process.arch}`
if (!['darwin-arm64', 'win32-x64', 'linux-x64'].includes(target))
  throw new Error('Unsupported speech build target')
const output = resolve('resources/speech', target)
const build = resolve('.local-runtimes/speech-build', target)
const cmake = process.env.HHC_CMAKE || 'cmake'
const run = (args) => {
  const result = spawnSync(cmake, args, { stdio: 'inherit' })
  if (result.error || result.status !== 0)
    throw new Error('Speech runtime build failed', { cause: result.error })
}
run(['-S', 'native/speech', '-B', build, '-DCMAKE_BUILD_TYPE=Release'])
run(['--build', build, '--config', 'Release', '--parallel', '4'])
run([
  '--install',
  build,
  '--config',
  'Release',
  '--prefix',
  output,
  '--component',
  'speech-runtime'
])
const filename = process.platform === 'win32' ? 'hhc-speech.exe' : 'hhc-speech'
const bytes = await readFile(join(output, filename))
await mkdir(output, { recursive: true })
await writeFile(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      protocol: 1,
      target,
      filename,
      revision: 'f24588a272ae8e23280d9c220536437164e6ed28',
      sha256: createHash('sha256').update(bytes).digest('hex')
    },
    null,
    2
  )
)
const probe = spawnSync(join(output, filename), ['--version'], { encoding: 'utf8' })
if (probe.status !== 0 || !probe.stdout.startsWith('hhc-speech/1 '))
  throw new Error('Speech runtime self-check failed')
console.log(probe.stdout.trim())
