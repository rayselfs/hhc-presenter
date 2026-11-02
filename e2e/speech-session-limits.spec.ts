import { expect, test } from '@playwright/test'
import { build } from 'esbuild'

test('browser speech refuses a remote-only implementation', async ({ page }) => {
  const bundle = await build({
    stdin: {
      contents:
        "export { WebSpeechAdapter } from './src/renderer/src/lib/speech-adapter/providers/web-speech-adapter'",
      resolveDir: process.cwd()
    },
    tsconfig: 'tsconfig.web.json',
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'LocalSpeechPrivacy'
  })
  await page.route('**/__test-speech.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text })
  )
  await page.goto('/')
  await page.addScriptTag({ url: '/__test-speech.js' })
  const outcome = await page.evaluate(async () => {
    let started = false
    Object.defineProperty(window, 'SpeechRecognition', {
      configurable: true,
      value: class {
        start(): void {
          started = true
        }
      }
    })
    const harness = (
      window as unknown as {
        LocalSpeechPrivacy: {
          WebSpeechAdapter: new (config: { language: string }) => {
            start(): Promise<void>
            dispose(): void
          }
        }
      }
    ).LocalSpeechPrivacy
    const adapter = new harness.WebSpeechAdapter({ language: 'zh-TW' })
    let rejected = false
    try {
      await adapter.start()
    } catch {
      rejected = true
    } finally {
      adapter.dispose()
    }
    return { started, rejected }
  })
  expect(outcome).toEqual({ started: false, rejected: true })
})
