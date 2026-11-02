import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SPEECH_MODELS,
  SPEECH_MODEL_REVISION,
  type RecognitionLanguage,
  type SpeechModelStatus
} from '../shared/local-speech'

export async function verifySpeechFile(
  path: string,
  bytes: number,
  expected: string
): Promise<boolean> {
  try {
    if ((await stat(path)).size !== bytes) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex') === expected
  } catch {
    return false
  }
}

function allowedDownload(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (url.hostname === 'huggingface.co' ||
      url.hostname.endsWith('.huggingface.co') ||
      url.hostname.endsWith('.hf.co'))
  )
}

export async function fetchSpeechModel(url: URL, signal: AbortSignal): Promise<Response> {
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!allowedDownload(url)) throw new Error('download-source')
    const response = await fetch(url, { signal, redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('download-source')
      url = new URL(location, url)
      continue
    }
    if (!response.ok || !response.body) throw new Error('download-failed')
    return response
  }
  throw new Error('download-source')
}

export class SpeechModels {
  private removing = false

  get busy(): boolean {
    return this.removing || this.job !== null
  }

  private states = new Map<RecognitionLanguage, SpeechModelStatus>()
  private checks = new Map<RecognitionLanguage, Promise<SpeechModelStatus>>()
  private job: {
    language: RecognitionLanguage
    controller: AbortController
    done: Promise<void>
  } | null = null

  constructor(
    private readonly root: string,
    private readonly runtimeAvailable: () => boolean
  ) {}

  path(language: RecognitionLanguage): string {
    return join(this.root, SPEECH_MODELS[language].id, 'model.bin')
  }

  async status(language: RecognitionLanguage): Promise<SpeechModelStatus> {
    const state = this.states.get(language)
    if (state) return { ...state, runtimeAvailable: this.runtimeAvailable() }
    const checking = this.checks.get(language)
    if (checking) return checking
    const promise = this.inspect(language)
    this.checks.set(language, promise)
    try {
      return await promise
    } finally {
      this.checks.delete(language)
    }
  }

  private async inspect(language: RecognitionLanguage): Promise<SpeechModelStatus> {
    const model = SPEECH_MODELS[language]
    const valid = await verifySpeechFile(this.path(language), model.bytes, model.sha256)
    const state: SpeechModelStatus = {
      language,
      phase: valid ? 'installed' : 'absent',
      received: valid ? model.bytes : 0,
      total: model.bytes,
      jobId: null,
      error: null,
      runtimeAvailable: this.runtimeAvailable()
    }
    this.states.set(language, state)
    return { ...state }
  }

  async install(language: RecognitionLanguage): Promise<void> {
    if (this.removing) throw new Error('installation-busy')
    if (this.job) {
      if (this.job.language === language) return this.job.done
      throw new Error('installation-busy')
    }
    const controller = new AbortController()
    const done = this.download(language, controller)
    this.job = { language, controller, done }
    try {
      await done
    } finally {
      if (this.job?.controller === controller) this.job = null
    }
  }

  private async download(
    language: RecognitionLanguage,
    controller: AbortController
  ): Promise<void> {
    // Complete startup validation before installing so it cannot overwrite newer progress.
    const previousVerified = (await this.status(language)).phase === 'installed'
    const model = SPEECH_MODELS[language]
    const directory = join(this.root, model.id)
    const staging = join(directory, 'download.part')
    const state: SpeechModelStatus = {
      language,
      phase: 'downloading',
      received: 0,
      total: model.bytes,
      jobId: randomUUID(),
      error: null,
      runtimeAvailable: this.runtimeAvailable()
    }
    this.states.set(language, state)
    const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000)
    try {
      await mkdir(directory, { recursive: true })
      const space = await statfs(directory)
      if (space.bavail * space.bsize < model.bytes + 128 * 1024 * 1024)
        throw new Error('disk-space')
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)])
      const response = await fetchSpeechModel(
        new URL(
          `https://huggingface.co/ggerganov/whisper.cpp/resolve/${SPEECH_MODEL_REVISION}/${model.filename}`
        ),
        signal
      )
      const file = await open(staging, 'w')
      const hash = createHash('sha256')
      try {
        const reader = response.body!.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            signal.throwIfAborted()
            state.received += value.byteLength
            if (state.received > model.bytes) throw new Error('checksum')
            hash.update(value)
            let offset = 0
            while (offset < value.byteLength) {
              const { bytesWritten } = await file.write(value, offset, value.byteLength - offset)
              if (!bytesWritten) throw new Error('download-failed')
              offset += bytesWritten
            }
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
        state.phase = 'verifying'
        if (state.received !== model.bytes || hash.digest('hex') !== model.sha256)
          throw new Error('checksum')
        await file.sync()
      } finally {
        await file.close()
      }
      signal.throwIfAborted()
      await rename(staging, this.path(language))
      state.phase = 'installed'
    } catch (error) {
      state.phase = previousVerified ? 'installed' : 'error'
      if (previousVerified) state.received = model.bytes
      state.error = controller.signal.aborted
        ? 'cancelled'
        : error instanceof Error &&
            ['checksum', 'disk-space', 'download-source'].includes(error.message)
          ? error.message
          : 'download-failed'
      throw new Error(state.error)
    } finally {
      clearTimeout(timeout)
      await rm(staging, { force: true }).catch(() => {})
    }
  }

  cancel(): void {
    this.job?.controller.abort()
  }

  async remove(language: RecognitionLanguage): Promise<void> {
    if (this.busy) throw new Error('installation-busy')
    this.removing = true
    try {
      await this.status(language)
      await rm(join(this.root, SPEECH_MODELS[language].id), { recursive: true, force: true })
      this.states.delete(language)
    } finally {
      this.removing = false
    }
  }
}
