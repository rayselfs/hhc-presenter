import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

type AfterPackContext = {
  appOutDir: string
  electronPlatformName: string
  arch: number
  packager: {
    projectDir: string
    getResourcesDir(appOutDir: string): string
  }
}

type AfterPackModule = {
  afterPack(context: AfterPackContext): Promise<void>
}

const hookPath = resolve(process.cwd(), 'scripts/after-pack.mjs')
const tempRoots: string[] = []

async function write(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value)
}

describe('after-pack hook', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('is configured for electron-builder', async () => {
    const config = await readFile(resolve(process.cwd(), 'electron-builder.yml'), 'utf8')

    expect(config).toContain('afterPack: ./scripts/after-pack.mjs')
  })

  it('restores packaged VLC plugin files with source timestamps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'after-pack-'))
    tempRoots.push(root)
    const source = join(
      root,
      'resources/video-engine/vlc/darwin-arm64/plugins/libvideo_plugin.dylib'
    )
    const destinationResources = join(root, 'packed-resources')
    const destination = join(
      destinationResources,
      'video-engine/vlc/darwin-arm64/plugins/libvideo_plugin.dylib'
    )
    await write(
      join(root, 'scripts/check-speech-runtime.mjs'),
      "if (!process.argv[2].replaceAll('\\\\', '/').endsWith('/speech/darwin-arm64')) process.exit(1)"
    )
    const timestamp = new Date('2020-01-02T03:04:05.000Z')
    await write(source, 'source-plugin')
    await utimes(source, timestamp, timestamp)
    await write(destination, 'builder-copy')
    const module = (await import(pathToFileURL(hookPath).href)) as AfterPackModule

    await module.afterPack({
      appOutDir: join(root, 'app-out'),
      electronPlatformName: 'darwin',
      arch: 3,
      packager: {
        projectDir: root,
        getResourcesDir: () => destinationResources
      }
    })

    await expect(readFile(destination, 'utf8')).resolves.toBe('source-plugin')
    await expect(stat(destination)).resolves.toMatchObject({ mtimeMs: timestamp.getTime() })
  }, 15000)
})
