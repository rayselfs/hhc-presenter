import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import electronBuilder from 'electron-builder'

const { Arch } = electronBuilder

/**
 * @param {import('electron-builder').AfterPackContext} context
 * @returns {Promise<void>}
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JavaScript hook API
export async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' && context.electronPlatformName !== 'win32') return

  const platformDir = `${context.electronPlatformName}-${Arch[context.arch]}`
  const relativePlugins = join('video-engine', 'vlc', platformDir, 'plugins')
  const source = join(context.packager.projectDir, 'resources', relativePlugins)
  const destination = join(context.packager.getResourcesDir(context.appOutDir), relativePlugins)

  await cp(source, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true
  })
}
