/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone native product qualification. */
import { _electron, expect } from '@playwright/test'
import { readFile, writeFile, mkdir, mkdtemp, rm, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
const root = resolve(process.argv[2])
const output = resolve(process.argv[3])
await mkdir(output, { recursive: true })
const json = async (path) => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
const names = await json(join(root, 'books.json'))
const corpus = await json(join(root, 'corpus.json'))
const ids = process.argv.includes('--full')
  ? ['0000', '0001', '0201', '0291', '0292', '0300', '0301', '0500', '0591']
  : ['0000', '0201', '0300', '0500']
const profile = await mkdtemp(join(tmpdir(), 'hhc-product-speech-'))
for (const [id, filename] of [
  ['turbo-q5-0-v1', 'ggml-large-v3-turbo-q5_0.bin'],
  ['small-v1', 'ggml-small.bin']
]) {
  const directory = join(profile, 'speech-models', id)
  await mkdir(directory, { recursive: true })
  await link(join(root, 'models/whisper', filename), join(directory, 'model.bin'))
}
const env = { ...process.env }
for (const key of Object.keys(env)) if (key.startsWith('HHC_SPEECH_')) delete env[key]
const app = await _electron.launch({
  args: [process.cwd(), `--user-data-dir=${profile}`],
  env,
  timeout: 60000
})
const logs = []
app.process().stderr?.on('data', (data) => logs.push(String(data)))
const results = []
try {
  const all = []
  for (const [language, file] of [
    ['zh', 'zh_cuv.json'],
    ['en', 'en_kjv.json']
  ]) {
    let id = 0
    all.push(
      (await json(join(root, 'sources', file))).map((book, b) => ({
        number: b + 1,
        code: names[b].code,
        name: language === 'zh' ? names[b].zh : names[b].en,
        abbreviation: names[b].en,
        chapters: book.chapters.map((verses, c) => ({
          number: c + 1,
          verses: verses.map((text, v) => ({ id: ++id, number: v + 1, text }))
        }))
      }))
    )
  }
  await app.evaluate(({ ipcMain }, all) => {
    ipcMain.removeHandler('bible:get-versions')
    ipcMain.removeHandler('bible:get-content')
    ipcMain.handle('bible:get-versions', () => [
      { id: 101, code: 'cuv', name: 'CUV fixture', locale: 'zh-TW', updatedAt: 1 },
      { id: 102, code: 'kjv', name: 'KJV fixture', locale: 'en-US', updatedAt: 1 }
    ])
    ipcMain.handle('bible:get-content', (_event, id) => all[id === 102 ? 1 : 0])
  }, all)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => logs.push(error.message))
  await page.waitForURL(/#\/(welcome|timer)$/, { timeout: 60000 })
  if (page.url().endsWith('#/welcome'))
    await page.getByRole('button', { name: /Get Started|開始使用|开始使用/ }).click()
  for (const language of ['zh', 'en']) {
    await page.evaluate((language) => {
      const settings = JSON.parse(localStorage.getItem('hhc-settings') || '{}')
      settings.version = 14
      settings.state = {
        ...settings.state,
        speech: { recognitionLanguage: language, microphoneId: '' }
      }
      localStorage.setItem('hhc-settings', JSON.stringify(settings))
      localStorage.setItem(
        'hhc-bible-settings',
        JSON.stringify({
          version: 4,
          state: {
            selectedVersionId: language === 'zh' ? 101 : 102,
            speechEnabled: true,
            fontSize: 90,
            scriptureTemplateId: 'dark-stage'
          }
        })
      )
    }, language)
    await page.reload()
    await page.goto(`${page.url().split('#')[0]}#/bible`)
    await expect(page.locator('[data-speech-status]')).toHaveAttribute(
      'data-speech-status',
      'ready',
      { timeout: 90000 }
    )
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext({ sampleRate: 16000 })
        const destination = context.createMediaStreamDestination()
        await context.resume()
        window.productFixture = { context, destination }
        return destination.stream
      }
    })
    await page.getByRole('button', { name: /^(開始聆聽|Start listening)$/ }).click()
    await expect(page.locator('[data-speech-status]')).toHaveAttribute(
      'data-speech-status',
      'listening',
      { timeout: 90000 }
    )
    for (const id of ids) {
      const row = corpus.find((r) => r.id === id)
      if (!row || row.language !== language) continue
      const wav = await readFile(join(root, 'audio', `${id}.wav`))
      let position = 12,
        bytes
      while (position + 8 <= wav.length) {
        const size = wav.readUInt32LE(position + 4)
        if (wav.toString('ascii', position, position + 4) === 'data') {
          bytes = wav.subarray(position + 8, position + 8 + size)
          break
        }
        position += 8 + size + (size % 2)
      }
      if (!bytes) throw new Error('Missing PCM')
      const pcm = new Float32Array(bytes.length / 2)
      let last = 0
      for (let i = 0; i < pcm.length; i++) {
        pcm[i] = bytes.readInt16LE(i * 2) / 32768
        if (pcm[i] !== 0) last = i
      }
      const target = row.target.join(':')
      const end = await page.evaluate(
        ({ encoded, last, target }) => {
          window.productPaint = null
          window.productTarget = target
          const observer = new MutationObserver(() => {
            const passage = document.querySelector('[data-bible-passage]')
            if (passage?.getAttribute('data-bible-passage') === target) {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  const verse = passage.querySelector(
                    `[data-verse-number="${target.split(':')[2]}"]`
                  )
                  const a = passage.getBoundingClientRect(),
                    b = verse?.getBoundingClientRect()
                  if (
                    window.productTarget === target &&
                    window.productPaint === null &&
                    b &&
                    b.top >= a.top &&
                    b.bottom <= a.bottom
                  )
                    window.productPaint = performance.now()
                })
              )
            }
          })
          window.productObserver?.disconnect()
          window.productObserver = observer
          observer.observe(document.body, { subtree: true, childList: true, attributes: true })
          const { context, destination } = window.productFixture
          const samples = new Float32Array(
            Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)).buffer
          )
          const buffer = context.createBuffer(1, samples.length, 16000)
          buffer.copyToChannel(samples, 0)
          const source = context.createBufferSource()
          source.buffer = buffer
          source.connect(destination)
          const start = context.currentTime + 0.5
          source.start(start)
          const stamp = context.getOutputTimestamp()
          return stamp.performanceTime + (start + last / 16000 - stamp.contextTime) * 1000
        },
        { encoded: Buffer.from(pcm.buffer).toString('base64'), last, target }
      )
      let passed = true
      try {
        await page.waitForFunction(
          () =>
            window.productPaint !== null &&
            document.querySelector('[data-bible-passage]')?.getAttribute('data-bible-passage') ===
              window.productTarget,
          null,
          { timeout: Math.ceil(row.duration_s * 1000 + 15000) }
        )
      } catch {
        passed = false
      }
      const result = await page.evaluate(() => ({
        paint: window.productPaint,
        displayed: document
          .querySelector('[data-bible-passage]')
          ?.getAttribute('data-bible-passage'),
        status: document.querySelector('[data-speech-status]')?.getAttribute('data-speech-status')
      }))
      passed = passed && result.displayed === target && result.paint >= end
      results.push({
        id,
        language,
        target,
        passed,
        ...result,
        lastSampleToPaintMs: result.paint === null ? null : result.paint - end
      })
      await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
      console.log(JSON.stringify(results.at(-1)))
      await page.screenshot({ path: join(output, `${id}.png`) })
    }
    await page.getByRole('button', { name: /^(停止|Stop)$/ }).click()
    await page.evaluate(() => window.productFixture.context.close())
  }
} finally {
  await app.close()
  await writeFile(join(output, 'console.log'), logs.join('\n'))
  await rm(profile, { recursive: true, force: true })
}
if (results.some((r) => !r.passed || r.lastSampleToPaintMs > 3000)) process.exitCode = 1
