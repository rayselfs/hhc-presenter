/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone Electron validation. */
import { _electron, expect } from '@playwright/test'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const root = resolve(process.argv[2])
const output = resolve(process.argv[3])
const noisy = process.argv.includes('--noisy-probe')
const full = process.argv.includes('--full')
const refusals = process.argv.includes('--refusals')
const repo = process.cwd()
await mkdir(output, { recursive: true })
const readJson = async (path) => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
const screen = await readJson(join(root, 'segmentation-paired-corpus.json'))
const original = await readJson(join(root, 'segmentation-regression-corpus.json'))
const baseline = new Map(
  (await readFile(join(root, 'segmentation/regression-digital-v3.decisions.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => {
      const row = JSON.parse(line)
      return [row.id, row]
    })
)
const refusedCases = [
  ...original
    .filter((row) => row.kind === 'reference' && !baseline.get(row.id)['phonetic-0.85'].correct)
    .slice(0, 8),
  ...original.filter((row) => row.kind === 'negative' && row.id.startsWith('ref3-')).slice(0, 8)
]
const retentionCases = [
  ...screen.filter((row) => row.split === 'segmentation-challenge'),
  ...original
    .filter((row) => row.kind === 'reference' && baseline.get(row.id)['phonetic-0.85'].correct)
    .slice(0, 12),
  ...original.filter((row) => ['0291', '0292', '0297', '0298'].includes(row.id))
]
const selected = noisy
  ? await readJson(
      join(
        root,
        'noisy-endpoint/flow-fixtures',
        process.argv.includes('--long-noise') ? 'long-corpus.json' : 'corpus.json'
      )
    )
  : process.argv.includes('--scroll-recovery')
    ? original.filter((row) => row.id === '0292')
    : process.argv.includes('--all')
      ? [...retentionCases, ...refusedCases]
      : process.argv.includes('--visibility')
        ? original.filter((row) => ['0297', '0298'].includes(row.id))
        : refusals
          ? refusedCases
          : full
            ? retentionCases
            : ['0000', 'segment-007', 'segment-002', '0291'].map((id) =>
                screen.find((row) => row.id === id)
              )
if (selected.some((row) => !row)) throw new Error('Missing fixture')
await writeFile(
  join(output, 'protocol.json'),
  JSON.stringify(
    {
      ids: selected.map((row) => row.id),
      noisyProbe: noisy,
      inferenceWarmup: noisy && process.argv.includes('--warm-noise'),
      coveredAudioContext: noisy && process.argv.includes('--fit-noise'),
      endpointDriver: noisy
        ? 'Experimental stationary-noise detector endpoint schedules the existing Finish action; not a shipped automatic endpoint. Native gain is enabled only for this probe.'
        : 'Application exact-zero endpoint',
      noiseCalibration: noisy
        ? 'One second supplied noise-only prefix; fixed floor, 1.15 RMS ratio, 1.5 second endpoint; source speech-end labels used only for latency scoring.'
        : null,
      scrollFaultInjection: process.argv.includes('--scroll-recovery'),
      method:
        'Real-time synthetic WebAudio MediaStream → production AudioWorklet → Electron IPC → resident native Turbo → frozen locator → actual Bible preview',
      audioDevice:
        'Synthetic loopback replaces getUserMedia device only; no ASR or navigation mocks',
      omissions:
        'Physical microphone, room acoustics, human-labelled recordings, Windows, packaged native distribution',
      clock:
        'Source AudioContext output timestamp maps the last nonzero fixture sample to renderer performance time; independently compare captured last nonzero sample',
      endpoint: noisy
        ? '1500 ms stationary-noise endpoint, entire retained PCM; driver clicks Finish at detected endpoint'
        : '300 ms speculative processing, 1500 ms exact-zero stability; all nonzero samples preserved',
      data: 'Only Bible content transport is replaced with the fixed local CUV fixture; no speech handler is replaced'
    },
    null,
    2
  )
)
const scripture = await readJson(join(root, 'sources/zh_cuv.json'))
const names = await readJson(join(root, 'books.json'))
let verseId = 0
const books = scripture.map((book, b) => ({
  number: b + 1,
  code: names[b].code,
  name: names[b].zh,
  abbreviation: names[b].zh,
  chapters: book.chapters.map((verses, c) => ({
    number: c + 1,
    verses: verses.map((text, v) => ({ id: ++verseId, number: v + 1, text }))
  }))
}))
const profile = await mkdtemp(join(tmpdir(), 'hhc-chinese-flow-'))
const app = await _electron.launch({
  args: [repo, `--user-data-dir=${profile}`],
  timeout: 60000,
  env: {
    ...process.env,
    HHC_SPEECH_DATA: root,
    HHC_SPEECH_PYTHON: join(root, 'venv/bin/python'),
    HHC_SPEECH_NODE: process.execPath,
    HHC_SPEECH_NOISE_GAIN: noisy ? '1' : '0',
    HHC_SPEECH_NOISE_CONTEXT: noisy && process.argv.includes('--fit-noise') ? '1' : '0',
    HHC_SPEECH_NOISE_WARMUP: noisy && process.argv.includes('--warm-noise') ? '1' : '0'
  }
})
const logs = []
app.process().stderr?.on('data', (data) => logs.push(String(data)))
const results = []
let page
try {
  await app.evaluate(({ ipcMain }, books) => {
    ipcMain.removeHandler('bible:get-versions')
    ipcMain.removeHandler('bible:get-content')
    ipcMain.handle('bible:get-versions', () => [
      { id: 101, code: 'cuv', name: '和合本（本機測試）', locale: 'zh-TW', updatedAt: 1 }
    ])
    ipcMain.handle('bible:get-content', () => books)
  }, books)
  page = await app.firstWindow()
  page.on('pageerror', (error) => logs.push(error.message))
  await page.waitForURL(/#\/(welcome|timer)$/, { timeout: 60000 })
  if (page.url().endsWith('#/welcome'))
    await page.getByRole('button', { name: /Get Started|開始使用|开始使用/ }).click()
  await page.evaluate(() => {
    localStorage.setItem(
      'hhc-bible-settings',
      JSON.stringify({
        version: 4,
        state: {
          selectedVersionId: 101,
          speechEnabled: true,
          speechMaxSessionSec: 3600,
          fontSize: 90,
          scriptureTemplateId: 'dark-stage'
        }
      })
    )
  })
  await page.reload()
  await page.goto(`${page.url().split('#')[0]}#/bible`)
  await expect(page.getByRole('button', { name: '開始中文聆聽', exact: true })).toBeEnabled({
    timeout: 60000
  })
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext({ sampleRate: 16000 })
      const destination = context.createMediaStreamDestination()
      await context.resume()
      window.chineseFixture = { context, destination }
      return destination.stream
    }
  })
  if (process.argv.includes('--scroll-recovery')) {
    await page.evaluate(() => {
      const original = HTMLElement.prototype.scrollTo
      let blocked = 0
      HTMLElement.prototype.scrollTo = function (...args) {
        if (this.matches('[data-bible-passage]') && blocked++ < 2) return
        return original.apply(this, args)
      }
    })
  }
  const preparing = Date.now()
  await page.getByRole('button', { name: '開始中文聆聽', exact: true }).click()
  await expect(page.locator('[data-speech-status]')).toHaveAttribute(
    'data-speech-status',
    'listening',
    { timeout: 60000 }
  )
  const readyMs = Date.now() - preparing
  console.log('Ready', readyMs, 'ms')
  for (const row of selected) {
    if (noisy && results.length) {
      await page.getByRole('button', { name: '開始中文聆聽', exact: true }).click()
      await expect(page.locator('[data-speech-status]')).toHaveAttribute(
        'data-speech-status',
        'listening',
        { timeout: 60000 }
      )
    }
    const wav = await readFile(
      join(root, noisy ? 'noisy-endpoint/flow-fixtures' : 'audio', `${row.id}.wav`)
    )
    if (createHash('sha256').update(wav).digest('hex') !== row.sha256)
      throw new Error('Fixture checksum mismatch')
    let position = 12,
      bytes
    while (position + 8 <= wav.length) {
      const size = wav.readUInt32LE(position + 4)
      const tag = wav.toString('ascii', position, position + 4)
      if (
        tag === 'fmt ' &&
        (wav.readUInt16LE(position + 10) !== 1 ||
          wav.readUInt32LE(position + 12) !== 16000 ||
          wav.readUInt16LE(position + 22) !== 16)
      )
        throw new Error('Unsupported WAV format')
      if (tag === 'data') {
        bytes = wav.subarray(position + 8, position + 8 + size)
        break
      }
      position += 8 + size + (size % 2)
    }
    if (!bytes) throw new Error('Missing audio samples')
    const pcm = new Float32Array(bytes.length / 2)
    let lastSignal = -1
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = bytes.readInt16LE(i * 2) / 32768
      if (pcm[i] !== 0) lastSignal = i
    }
    if (noisy) lastSignal = row.speech_end_sample
    const count = await page.locator('[data-speech-trace]').count()
    const previous = (await page.locator('[data-bible-passage]').count())
      ? await page.locator('[data-bible-passage]').getAttribute('data-bible-passage')
      : null
    const sourceEnd = await page.evaluate(
      ({ encoded, lastSignal }) => {
        const { context, destination } = window.chineseFixture
        const raw = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
        const samples = new Float32Array(raw.buffer)
        const buffer = context.createBuffer(1, samples.length, 16000)
        buffer.copyToChannel(samples, 0)
        const source = context.createBufferSource()
        source.buffer = buffer
        if (!window.chineseFixture.firstBuffer) {
          window.chineseFixture.firstBuffer = buffer
          window.chineseFixture.firstLastSignalSeconds = lastSignal / 16000
        }
        source.connect(destination)
        const start = context.currentTime + 0.5
        source.start(start)
        const stamp = context.getOutputTimestamp()
        return stamp.performanceTime + (start + lastSignal / 16000 - stamp.contextTime) * 1000
      },
      { encoded: Buffer.from(pcm.buffer).toString('base64'), lastSignal }
    )
    if (noisy) {
      const endpointAt = sourceEnd + (row.endpoint_sample - row.speech_end_sample) / 16
      await page.evaluate(async (at) => {
        await new Promise((done) => setTimeout(done, Math.max(0, at - performance.now())))
      }, endpointAt)
      await page.getByRole('button', { name: '完成一句', exact: true }).click()
    }
    await expect(page.locator('[data-speech-trace]')).toHaveCount(count + 1, {
      timeout: Math.ceil((row.duration_s + 18) * 1000)
    })
    const trace = JSON.parse(
      await page.locator('[data-speech-trace]').first().getAttribute('data-speech-trace')
    )
    const displayed = (await page.locator('[data-bible-passage]').count())
      ? await page.locator('[data-bible-passage]').getAttribute('data-bible-passage')
      : null
    const correct =
      row.target !== null &&
      JSON.stringify(trace.result.reference) === JSON.stringify(row.target) &&
      trace.outcome === 'located'
    const wrong =
      trace.result.reference !== null &&
      JSON.stringify(trace.result.reference) !== JSON.stringify(row.target)
    const item = {
      id: row.id,
      kind: row.kind,
      target: row.target,
      reference: trace.result.reference,
      correct,
      wrong,
      lostCorrect:
        row.target !== null &&
        (row.id.startsWith('segment-') ||
          baseline.get(row.id)?.['phonetic-0.85'].correct === true) &&
        !correct,
      unexpectedNavigation: row.target === null && displayed !== previous,
      sourceToPaintMs: trace.paintedAt - sourceEnd,
      captureClockOffsetMs: noisy ? null : trace.lastSampleAt - sourceEnd,
      trace
    }
    results.push(item)
    await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
    console.log(
      row.id,
      JSON.stringify({
        correct,
        wrong,
        outcome: trace.outcome,
        sourceToPaintMs: item.sourceToPaintMs
      })
    )
    if (trace.outcome === 'not-visible')
      console.log(
        'visibility',
        await page.locator('[data-bible-passage]').evaluate((el) => ({
          parent: el.getBoundingClientRect().toJSON(),
          target: el
            .querySelector(`[data-verse-number="${el.dataset.biblePassage.split(':')[2]}"]`)
            ?.getBoundingClientRect()
            .toJSON()
        }))
      )
    if (results.length === 1 || trace.outcome === 'not-visible')
      await page.screenshot({ path: join(output, 'first-result.png') })
    if (noisy) {
      await expect(page.locator('[data-speech-status]')).toHaveAttribute(
        'data-speech-status',
        'idle'
      )
      await page.evaluate(() => window.chineseFixture.context.close())
    }
  }
  if (
    process.argv.includes('--scroll-recovery') &&
    !results.some((row) => row.trace.scrollCorrected)
  ) {
    throw new Error('Scroll recovery was not exercised')
  }
  if (!noisy) {
    const beforeCancel = await page.locator('[data-speech-trace]').count()
    const beforePassage = (await page.locator('[data-bible-passage]').count())
      ? await page.locator('[data-bible-passage]').getAttribute('data-bible-passage')
      : null
    const cancelDelay = await page.evaluate(() => {
      const fixture = window.chineseFixture
      const source = fixture.context.createBufferSource()
      source.buffer = fixture.firstBuffer
      source.connect(fixture.destination)
      source.start(fixture.context.currentTime + 0.1)
      return (fixture.firstLastSignalSeconds + 0.5) * 1000
    })
    await page.waitForTimeout(cancelDelay)
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await page.waitForTimeout(1800)
    await expect(page.locator('[data-speech-trace]')).toHaveCount(beforeCancel)
    const afterPassage = (await page.locator('[data-bible-passage]').count())
      ? await page.locator('[data-bible-passage]').getAttribute('data-bible-passage')
      : null
    if (afterPassage !== beforePassage) throw new Error('Cancelled audio navigated')
  }
  await expect(page.locator('[data-speech-status]')).toHaveAttribute('data-speech-status', 'idle')
  const tracksEnded = await page.evaluate(() =>
    window.chineseFixture.destination.stream
      .getTracks()
      .every((track) => track.readyState === 'ended')
  )
  const projectionWindows = await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((window) =>
        window.webContents.getURL().endsWith('#/projection')
      ).length
  )
  await writeFile(
    join(output, 'summary.json'),
    JSON.stringify(
      {
        n: results.length,
        readyMs,
        lostCorrect: results.filter((r) => r.lostCorrect).map((r) => r.id),
        correct: results.filter((r) => r.correct).length,
        wrong: results.filter((r) => r.wrong || r.unexpectedNavigation).length,
        over3s: results.filter((r) => r.sourceToPaintMs > 3000).map((r) => r.id),
        tracksEnded,
        projectionWindows,
        cancelLateResultIgnored: noisy ? null : true
      },
      null,
      2
    )
  )
  if (!tracksEnded || projectionWindows !== 0)
    throw new Error('Capture/projection lifecycle failed')
  if (
    results.some(
      (r) => r.wrong || r.unexpectedNavigation || r.lostCorrect || r.sourceToPaintMs > 3000
    )
  )
    throw new Error('Navigation retention or latency gate failed')
} catch (error) {
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  await writeFile(join(output, 'failure.txt'), String(error))
  throw error
} finally {
  await writeFile(join(output, 'app.log'), logs.join('\n'))
  await app.close()
  await rm(profile, { recursive: true, force: true })
}
