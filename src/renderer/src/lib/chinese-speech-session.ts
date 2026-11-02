import type { ChineseSpeechResult } from '@shared/chinese-speech'

export interface ChineseSpeechCompletion {
  result: ChineseSpeechResult
  lastSampleAt: number
  requestAt: number
  responseAt: number
  stableAt: number
  manual: boolean
}

// shortcut: Exact-zero endpointing needs human/noisy-room VAD validation before production.
export class ChineseSpeechSession {
  private chunks: Float32Array[] = []
  private length = 0
  private revision = 0
  private lastVoiceAt: number | null = null
  private throughAt = 0
  private busy = false
  private closed = false
  private manual = false
  private candidate: ChineseSpeechCompletion | null = null

  constructor(
    private readonly decode: (pcm: Float32Array) => Promise<ChineseSpeechResult>,
    private readonly complete: (value: ChineseSpeechCompletion) => void,
    private readonly error: (error: Error) => void,
    private readonly now: () => number = () => performance.now()
  ) {}

  push(pcm: Float32Array, firstSampleAt: number): void {
    if (this.closed || this.manual) return
    let lastSignal = -1
    for (let i = 0; i < pcm.length; i++) if (pcm[i] !== 0) lastSignal = i
    this.throughAt = firstSampleAt + pcm.length / 16
    if (lastSignal >= 0) {
      this.lastVoiceAt = firstSampleAt + lastSignal / 16
      this.revision++
      this.candidate = null
    }
    if (this.lastVoiceAt === null) {
      this.chunks.push(pcm.slice())
      this.length += pcm.length
      while (this.length > 4800) {
        const first = this.chunks[0]
        const remove = Math.min(first.length, this.length - 4800)
        if (remove === first.length) this.chunks.shift()
        else this.chunks[0] = first.slice(remove)
        this.length -= remove
      }
      return
    }
    if (this.length + pcm.length > 480000) {
      this.stop()
      this.error(new Error('utterance-too-long'))
      return
    }
    this.chunks.push(pcm.slice())
    this.length += pcm.length
    this.advance()
  }

  finish(): void {
    if (this.closed) return
    this.manual = true
    if (this.lastVoiceAt === null) {
      this.stop()
      this.error(new Error('no-speech'))
      return
    }
    this.advance()
  }

  stop(): void {
    this.closed = true
    this.chunks = []
    this.length = 0
    this.candidate = null
    this.revision++
  }

  private advance(): void {
    if (this.closed || this.lastVoiceAt === null) return
    const quietMs = this.throughAt - this.lastVoiceAt
    if (this.candidate && (this.manual || quietMs >= 1500)) {
      const result = { ...this.candidate, stableAt: this.now(), manual: this.manual }
      this.candidate = null
      this.chunks = []
      this.length = 0
      this.lastVoiceAt = null
      this.revision++
      this.complete(result)
      return
    }
    if (this.busy || this.candidate || (!this.manual && quietMs < 300)) return
    const pcm = new Float32Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      pcm.set(chunk, offset)
      offset += chunk.length
    }
    const revision = this.revision
    const lastSampleAt = this.lastVoiceAt
    const requestAt = this.now()
    this.busy = true
    void this.decode(pcm)
      .then((result) => {
        if (this.closed) return
        if (revision === this.revision) {
          this.candidate = {
            result,
            lastSampleAt,
            requestAt,
            responseAt: this.now(),
            stableAt: 0,
            manual: this.manual
          }
        }
      })
      .catch((error: unknown) => {
        if (!this.closed) {
          this.stop()
          this.error(error instanceof Error ? error : new Error('recognition-failed'))
        }
      })
      .finally(() => {
        this.busy = false
        this.advance()
      })
  }
}
