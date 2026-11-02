import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpeechModels, fetchSpeechModel, verifySpeechFile } from './speechModels'
vi.mock('../shared/local-speech', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/local-speech')>()
  const model = {
    id: 'fixture',
    filename: 'fixture.bin',
    bytes: 3,
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  }
  return { ...original, SPEECH_MODELS: { zh: model, en: { ...model, id: 'english' } } }
})
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'speech-models-'))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})
it('verifies exact bytes and hash before making an install available, and rechecks on restart', async () => {
  const fetch = vi.fn(async () => new Response('abc'))
  vi.stubGlobal('fetch', fetch)
  const models = new SpeechModels(root, () => true)
  expect((await models.status('zh')).phase).toBe('absent')
  await Promise.all([models.install('zh'), models.install('zh')])
  expect(fetch).toHaveBeenCalledOnce()
  expect((await models.status('zh')).phase).toBe('installed')
  expect(await readFile(models.path('zh'), 'utf8')).toBe('abc')
  await writeFile(models.path('zh'), 'bad')
  expect((await new SpeechModels(root, () => true).status('zh')).phase).toBe('absent')
})
it('does not activate a corrupt download or destroy the previous verified pack', async () => {
  const models = new SpeechModels(root, () => true)
  await mkdir(join(root, 'fixture'))
  await writeFile(models.path('zh'), 'abc')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('bad'))
  )
  await expect(models.install('zh')).rejects.toThrow('checksum')
  expect(await readFile(models.path('zh'), 'utf8')).toBe('abc')
  expect((await models.status('zh')).phase).toBe('installed')
  expect(await verifySpeechFile(join(root, 'fixture', 'download.part'), 3, '')).toBe(false)
})
it('rejects a redirect outside trusted model hosts before requesting it', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/model' } })
  )
  vi.stubGlobal('fetch', fetch)
  await expect(
    fetchSpeechModel(new URL('https://huggingface.co/model'), new AbortController().signal)
  ).rejects.toThrow('download-source')
  expect(fetch).toHaveBeenCalledOnce()
})
it('does not publish a cancelled installation and allows a retry', async () => {
  const models = new SpeechModels(root, () => true)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      models.cancel()
      return new Response('abc')
    })
  )
  await expect(models.install('zh')).rejects.toThrow('cancelled')
  expect((await models.status('zh')).phase).toBe('error')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('abc'))
  )
  await models.install('zh')
  expect((await models.status('zh')).phase).toBe('installed')
})
it('serializes removal against install and preserves unrelated files', async () => {
  const models = new SpeechModels(root, () => true)
  await writeFile(join(root, 'unrelated.txt'), 'keep')
  const removing = models.remove('zh')
  await expect(models.install('zh')).rejects.toThrow('installation-busy')
  await removing
  expect(await readFile(join(root, 'unrelated.txt'), 'utf8')).toBe('keep')
})
