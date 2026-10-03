import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { completeOnboarding } from './helpers'

test('Electron restores an unavailable account through the retry action', async ({
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'Electron uses Chromium')
  const executablePath = process.env.HHC_ELECTRON_EXECUTABLE
  test.skip(!executablePath, 'Set HHC_ELECTRON_EXECUTABLE to run the built desktop app')
  const userDataPath = await mkdtemp(join(tmpdir(), 'hhc-auth-recovery-'))
  const app = await electron.launch({
    executablePath,
    args: [resolve('out/main/index.js'), `--user-data-dir=${userDataPath}`]
  })
  try {
    const page = await app.firstWindow()
    await completeOnboarding(page)
    await app.evaluate(({ ipcMain }) => {
      let attempts = 0
      ipcMain.removeHandler('hhc-auth:get-session')
      ipcMain.handle('hhc-auth:get-session', () => {
        if (attempts++ === 0) throw new Error('Account service temporarily unavailable')
        return {
          userId: 'auth-recovery-test',
          displayName: 'Recovery Test',
          roles: [],
          permissions: []
        }
      })
    })
    await page.reload()
    const menu = page.getByRole('button', { name: /Account menu for|帳號選單|帐号菜单/ }).first()
    await expect(menu).not.toHaveAccessibleName(/Guest|訪客|访客/)
    await menu.click()
    await expect(
      page.getByText(/Account unavailable|帳號服務無法使用|帐号服务不可用/).last()
    ).toBeVisible()
    await page.screenshot({ path: '/tmp/hhc-auth-unavailable.png' })
    await page.getByRole('menuitem', { name: /Retry connection|重試連線|重试连接/ }).click()
    await expect(page.getByRole('button', { name: /Recovery Test/ })).toBeVisible()
    await page.getByRole('button', { name: /Recovery Test/ }).click()
    await page.getByRole('menuitem', { name: /Logout|登出|退出登录/ }).click()
    await expect(
      page.getByRole('button', { name: /Account menu for Guest|訪客|访客/ }).first()
    ).toBeVisible()
  } finally {
    const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()))
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await exited
    await rm(userDataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
