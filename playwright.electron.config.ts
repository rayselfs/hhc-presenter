import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'electron-packaged.spec.ts',
    'electron-auth-recovery.spec.ts',
    'electron-ui-follow-up.spec.ts'
  ],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['line'], ['html', { outputFolder: 'playwright-report/electron', open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
})
