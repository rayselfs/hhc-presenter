import { expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closePackaged, launchPackaged } from './helpers/packaged-app'

test('Electron restores an unavailable account through the retry action', async ({
  browserName: _browserName
}, testInfo) => {
  const executablePath = process.env.PACKAGED_APP_PATH
  if (!executablePath) throw new Error('PACKAGED_APP_PATH is required')
  const userDataPath = await mkdtemp(join(tmpdir(), 'hhc-auth-recovery-'))
  let app: ElectronApplication | undefined
  try {
    const launched = await launchPackaged(resolve(executablePath), userDataPath)
    app = launched.app
    const page = launched.control
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
    await page.screenshot({ path: testInfo.outputPath('auth-unavailable.png') })
    await page.getByRole('menuitem', { name: /Retry connection|重試連線|重试连接/ }).click()
    await expect(page.getByRole('button', { name: /Recovery Test/ })).toBeVisible()
    await page.getByRole('button', { name: /Recovery Test/ }).click()
    await page.getByRole('menuitem', { name: /Logout|登出|退出登录/ }).click()
    await expect(
      page.getByRole('button', { name: /Account menu for Guest|訪客|访客/ }).first()
    ).toBeVisible()
  } finally {
    try {
      if (app) await closePackaged(app)
    } finally {
      await rm(userDataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})
