import { execFile } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const scriptPath = resolve(process.cwd(), 'scripts/prepare-video-engine-runtime.mjs')
const tempRoots: string[] = []

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'video-engine-runtime-'))
  tempRoots.push(root)
  return root
}

async function writeRuntimeFile(root: string, path: string): Promise<void> {
  const absolutePath = join(root, path)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, '')
}

async function runPrepare(root: string, args: string[] = []): Promise<void> {
  await execFileAsync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    env: {
      ...process.env,
      VIDEO_ENGINE_RUNTIME_PLATFORM: 'darwin',
      VIDEO_ENGINE_RUNTIME_ARCH: 'arm64'
    }
  })
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('prepare video engine runtime script', () => {
  it('allows non-strict preparation without local runtime binaries', async () => {
    await expect(runPrepare(await createTempRoot())).resolves.toBeUndefined()
  })

  it('prepares the video runtime before development starts', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }

    expect(packageJson.scripts.predev.split(' && ')).toContain('npm run prepare:video-engine')
    expect(packageJson.scripts.predev.split(' && ')).toContain('npm run prepare:lyrics-runtime')
  })

  it('requires only the current platform runtime in strict mode', async () => {
    const root = await createTempRoot()
    await writeRuntimeFile(root, '.local-runtimes/vlc/darwin-arm64/lib/libvlc.dylib')
    await writeRuntimeFile(root, '.local-runtimes/ffmpeg/darwin-arm64/ffmpeg')

    await expect(runPrepare(root, ['--strict'])).resolves.toBeUndefined()
    await expect(
      access(join(root, 'resources/video-engine/vlc/darwin-arm64/lib/libvlc.dylib'))
    ).resolves.toBeUndefined()
    await expect(
      access(join(root, 'resources/video-engine/ffmpeg/darwin-arm64/ffmpeg'))
    ).resolves.toBeUndefined()
  })

  it('preserves relative VLC links so packaged runtimes stay inside the app bundle', async () => {
    const root = await createTempRoot()
    const vlcDir = join(root, '.local-runtimes/vlc/darwin-arm64')
    await writeRuntimeFile(root, '.local-runtimes/vlc/darwin-arm64/libvlc.5.dylib')
    await symlink('libvlc.5.dylib', join(vlcDir, 'libvlc.dylib'))
    await writeRuntimeFile(root, '.local-runtimes/ffmpeg/darwin-arm64/ffmpeg')

    await runPrepare(root, ['--strict'])

    await expect(
      readlink(join(root, 'resources/video-engine/vlc/darwin-arm64/libvlc.dylib'))
    ).resolves.toBe('libvlc.5.dylib')
  })

  it('preserves VLC plugin timestamps so the copied cache stays valid', async () => {
    const root = await createTempRoot()
    const plugin = '.local-runtimes/vlc/darwin-arm64/plugins/libvideo_plugin.dylib'
    const cache = '.local-runtimes/vlc/darwin-arm64/plugins/plugins.dat'
    const timestamp = new Date('2020-01-02T03:04:05.000Z')
    await writeRuntimeFile(root, '.local-runtimes/vlc/darwin-arm64/lib/libvlc.dylib')
    await writeRuntimeFile(root, plugin)
    await writeRuntimeFile(root, cache)
    await writeFile(join(root, plugin), 'source-plugin')
    await writeFile(join(root, cache), 'source-cache')
    await utimes(join(root, plugin), timestamp, timestamp)
    await utimes(join(root, cache), timestamp, timestamp)
    await writeRuntimeFile(root, '.local-runtimes/ffmpeg/darwin-arm64/ffmpeg')
    const destinationPlugin =
      'resources/video-engine/vlc/darwin-arm64/plugins/libvideo_plugin.dylib'
    const destinationCache = 'resources/video-engine/vlc/darwin-arm64/plugins/plugins.dat'
    await writeRuntimeFile(root, destinationPlugin)
    await writeRuntimeFile(root, destinationCache)
    await writeFile(join(root, destinationPlugin), 'stale-plugin')
    await writeFile(join(root, destinationCache), 'stale-cache')

    await runPrepare(root, ['--strict'])

    await expect(
      stat(join(root, 'resources/video-engine/vlc/darwin-arm64/plugins/libvideo_plugin.dylib'))
    ).resolves.toMatchObject({ mtimeMs: timestamp.getTime() })
    await expect(
      stat(join(root, 'resources/video-engine/vlc/darwin-arm64/plugins/plugins.dat'))
    ).resolves.toMatchObject({ mtimeMs: timestamp.getTime() })
  })

  it('requires every runtime when strict all mode is requested', async () => {
    const root = await createTempRoot()
    await writeRuntimeFile(root, '.local-runtimes/vlc/darwin-arm64/libvlc.dylib')
    await writeRuntimeFile(root, '.local-runtimes/ffmpeg/darwin-arm64/ffmpeg')

    await expect(runPrepare(root, ['--strict', '--all'])).rejects.toMatchObject({ code: 1 })
  })
})
