import { test, expect, type ElectronApplication } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closePackaged, launchPackaged } from './helpers/packaged-app'
import { verifyLegacyRetirement } from './helpers/legacy-retirement'

test('Electron preserves retired Service settings and shared assets without restoring live output', async () => {
  const executable = process.env.PACKAGED_APP_PATH
  if (!executable) throw new Error('PACKAGED_APP_PATH is required')
  const userData = await mkdtemp(join(tmpdir(), 'hhc-legacy-retirement-'))
  let app: ElectronApplication | undefined
  try {
    const launched = await launchPackaged(resolve(executable), userData)
    app = launched.app
    const actualUserData = await app.evaluate(({ app }) => app.getPath('userData'))
    expect(await realpath(actualUserData)).toBe(await realpath(userData))
    await verifyLegacyRetirement(launched.control)
  } finally {
    try {
      if (app) await closePackaged(app)
    } finally {
      await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})
