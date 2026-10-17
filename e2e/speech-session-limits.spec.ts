import { expect, test } from '@playwright/test'
import { build } from 'esbuild'

type SpeechHarness =
  typeof import('../src/renderer/src/lib/speech-adapter/providers/gcp-speech-adapter') &
    Pick<typeof import('../src/renderer/src/lib/speech-key-storage'), 'saveSpeechKey'>
type SpeechWindow = Window & {
  SpeechHarness: SpeechHarness
  speechStream: MediaStream
  speechAdapter: InstanceType<SpeechHarness['GcpSpeechAdapter']>
  speechEvents: string[]
}

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }
})

test('real MediaRecorder stops its synthetic microphone at the GCP session limit', async ({
  page
}) => {
  const bundle = await build({
    stdin: {
      contents:
        "export { GcpSpeechAdapter } from './src/renderer/src/lib/speech-adapter/providers/gcp-speech-adapter'; export { saveSpeechKey } from './src/renderer/src/lib/speech-key-storage'",
      resolveDir: process.cwd()
    },
    tsconfig: 'tsconfig.web.json',
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'SpeechHarness'
  })
  await page.route('**/__test-speech.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text })
  )
  await page.route('**/api/account/v1/session', (route) =>
    route.fulfill({ json: { authenticated: false } })
  )
  await page.route('**/api/bible/v2/versions', (route) => route.fulfill({ json: [] }))
  let requests = 0
  await page.route('https://speech.googleapis.com/**', (route) => {
    if (route.request().method() === 'POST') requests++
    return route.fulfill({
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type'
      },
      json: {}
    })
  })
  await page.goto('/')
  await page.addScriptTag({ url: '/__test-speech.js' })
  await page.evaluate(async () => {
    const target = window as SpeechWindow
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      target.speechStream = await getUserMedia(constraints)
      return target.speechStream
    }
    await target.SpeechHarness.saveSpeechKey('gcp', 'synthetic-smoke-key')
    const adapter = new target.SpeechHarness.GcpSpeechAdapter({
      language: 'cmn-Hant-TW',
      maxSessionMs: 2500
    })
    target.speechAdapter = adapter
    target.speechEvents = []
    for (const event of [
      'sessionStarted',
      'sessionStopped',
      'maxDurationReached',
      'error'
    ] as const) {
      adapter.on(event, () => target.speechEvents.push(event))
    }
    await adapter.start()
  })
  await expect
    .poll(() => page.evaluate(() => (window as SpeechWindow).speechEvents))
    .toEqual(['sessionStarted', 'sessionStopped', 'maxDurationReached'])
  expect(requests).toBe(1)
  expect(
    await page.evaluate(() =>
      (window as SpeechWindow).speechStream
        .getTracks()
        .every((track) => track.readyState === 'ended')
    )
  ).toBe(true)
  await page.waitForTimeout(2200)
  expect(requests).toBe(1)
  expect(await page.evaluate(() => (window as SpeechWindow).speechAdapter.isRecognizing())).toBe(
    false
  )
  await page.evaluate(() => (window as SpeechWindow).speechAdapter.dispose())
})
