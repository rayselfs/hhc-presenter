import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './e2e',
  testMatch: 'electron-lyrics.spec.ts',
  workers: 1,
  retries: 0,
  reporter: [
    ['line'],
    ['html', { outputFolder: 'playwright-report/lyrics-electron', open: 'never' }]
  ],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }
})
