import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const bindingPath = join(
  process.cwd(),
  'node_modules',
  'electron-vlc-player',
  'build',
  'Release',
  'vlc_binding.node'
)

try {
  await access(bindingPath)
  const binary = await readFile(bindingPath)
  // Short strings such as --no-osd can be emitted as inline machine instructions.
  if (
    !['--no-snapshot-preview', 'hhc_vlc_event_dispatch_main'].every((marker) =>
      binary.includes(Buffer.from(marker))
    )
  )
    throw new Error('VLC projection patch is not compiled')
  console.log('ready: electron-vlc-player native binding')
} catch {
  console.error(`Missing or unpatched electron-vlc-player native binding: ${bindingPath}`)
  console.error('Install the platform C++ toolchain, then run:')
  console.error('  npm run rebuild:vlc')
  console.error(
    'Windows requires Visual Studio Build Tools with Desktop development with C++ and a Windows SDK.'
  )
  process.exitCode = 1
}
