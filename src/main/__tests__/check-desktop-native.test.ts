import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const scriptPath = resolve(process.cwd(), 'scripts/check-desktop-native.mjs')
const tempRoots: string[] = []

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-native-'))
  tempRoots.push(root)
  return root
}

async function writeFileIn(root: string, path: string, content = ''): Promise<void> {
  const absolutePath = join(root, path)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, content)
}

async function runChecker(root: string): Promise<void> {
  await execFileAsync(process.execPath, [scriptPath], { cwd: root })
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('check desktop native script', () => {
  it('rejects a missing VLC binding with actionable rebuild guidance', async () => {
    const root = await createTempRoot()

    await expect(runChecker(root)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('npm run rebuild:vlc')
    })
  })

  it.each(['unpatched', '--no-snapshot-preview'])(
    'rejects an incompletely patched compiled VLC binding (%s)',
    async (content) => {
      const root = await createTempRoot()
      await writeFileIn(
        root,
        'node_modules/electron-vlc-player/build/Release/vlc_binding.node',
        content
      )
      await expect(runChecker(root)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('unpatched')
      })
    }
  )

  it('accepts a compiled VLC binding', async () => {
    const root = await createTempRoot()
    await writeFileIn(
      root,
      'node_modules/electron-vlc-player/build/Release/vlc_binding.node',
      '--no-snapshot-preview hhc_vlc_event_dispatch_main'
    )

    await expect(runChecker(root)).resolves.toBeUndefined()
  })
})
