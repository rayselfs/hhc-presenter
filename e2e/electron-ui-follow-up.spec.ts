import { expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closePackaged, launchPackaged } from './helpers/packaged-app'

test('Electron next after the end screen hides the reusable projection window', async ({
  browserName: _browserName
}, testInfo) => {
  const executablePath = process.env.PACKAGED_APP_PATH
  if (!executablePath) throw new Error('PACKAGED_APP_PATH is required')
  const userDataPath = await mkdtemp(join(tmpdir(), 'hhc-ui-follow-up-'))
  let app: ElectronApplication | undefined
  try {
    const launched = await launchPackaged(resolve(executablePath), userDataPath)
    app = launched.app
    const page = launched.control
    console.log(
      'Desktop launched',
      app.windows().map((page) => page.url())
    )
    await page.getByRole('link', { name: 'FILES', exact: true }).click()
    const imagePath = join(userDataPath, 'End screen.png')
    await writeFile(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      )
    )
    await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(imagePath)
    const opened = app.waitForEvent('window')
    await page.getByText('End screen.png', { exact: true }).dblclick()
    await expect(page).toHaveURL(/#\/media$/)
    const projection = await opened
    await page.getByRole('button', { name: 'Next', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByText('End of slides', { exact: true })).toHaveCount(2)
    await page.screenshot({ path: testInfo.outputPath('electron-end-screen.png') })
    await page.keyboard.press('ArrowRight')
    await expect(page).toHaveURL(/#\/files$/)
    await expect
      .poll(() =>
        launched.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .filter((window) => window.webContents.getURL().endsWith('#/projection'))
            .every((window) => !window.isVisible())
        )
      )
      .toBe(true)
    expect(projection.isClosed()).toBe(false)
    expect(app.windows()).toHaveLength(2)
    console.log('Electron projection window hidden for reuse; media session returned to Files')
  } finally {
    try {
      if (app) await closePackaged(app)
    } finally {
      await rm(userDataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})
