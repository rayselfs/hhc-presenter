import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'bulletin-reader.spec.ts',
  grep: /Electron bulletin presenter/,
  reporter: 'line',
  workers: 1
})
