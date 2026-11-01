import { _electron as electron, test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { completeOnboarding } from './helpers'
import { installLyricsFixture, verifyLyricsWorkflow } from './helpers/lyrics-fixtures'
import { closePackaged } from './helpers/packaged-app'
test('loads bundled OCR in sandboxed Electron and projects unchanged lyric rows', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(300000)
  const profile = testInfo.outputPath('profile'),
    bootstrap = testInfo.outputPath('bootstrap.cjs')
  await mkdir(profile, { recursive: true })
  // Isolate app data and avoid changing the user's deep-link registration during the smoke test.
  await writeFile(
    bootstrap,
    `const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});app.setPath('temp',${JSON.stringify(profile)});app.setAsDefaultProtocolClient=()=>false;require(${JSON.stringify(resolve('out/main/index.js'))});`
  )
  const app = await electron.launch({
    args: [bootstrap, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    timeout: 30000
  })
  try {
    const page = await app.firstWindow()
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('lyrics'))
        console.error(message.text())
    })
    await installLyricsFixture(page)
    await page.reload()
    await completeOnboarding(page)
    const url = new URL(page.url())
    url.hash = '/camera'
    await page.goto(url.href)
    await expect(page).toHaveURL(/^file:/)
    await verifyLyricsWorkflow(page, testInfo, () => app.waitForEvent('window'))
  } finally {
    await closePackaged(app)
  }
})
