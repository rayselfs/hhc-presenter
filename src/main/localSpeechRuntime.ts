import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  isLocalTranscript,
  type LocalTranscript,
  type RecognitionLanguage
} from '../shared/local-speech'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class LocalSpeechRuntime {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending: Pending | null = null
  private session: string | null = null
  private language: RecognitionLanguage | null = null
  private ready = false
  private idle: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly binary: string) {}

  async prepare(session: string, language: RecognitionLanguage, model: string): Promise<void> {
    if (this.session && this.session !== session) this.dispose()
    if (this.ready && this.language === language && !this.pending) {
      this.clearIdle()
      this.session = session
      return
    }
    this.dispose()
    this.session = session
    this.language = language
    const child = spawn(this.binary, [model, language], { stdio: 'pipe', windowsHide: true })
    this.child = child
    const preparation = this.response(90000)
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return
      buffer += chunk
      if (buffer.length > 100000) return this.fail(new Error('invalid-response'))
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        const pending = this.pending
        if (!pending) return this.fail(new Error('unexpected-response'))
        try {
          const value: unknown = JSON.parse(line)
          this.pending = null
          clearTimeout(pending.timer)
          pending.resolve(value)
        } catch {
          this.fail(new Error('invalid-response'))
        }
      }
    })
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => {
      if (this.child === child) this.fail(new Error('runtime-stopped'))
    })
    child.on('error', () => {
      if (this.child === child) this.fail(new Error('runtime-unavailable'))
    })
    child.on('exit', () => {
      if (this.child === child) this.fail(new Error('runtime-stopped'))
    })
    const result = await preparation
    if (
      typeof result !== 'object' ||
      result === null ||
      !('ready' in result) ||
      result.ready !== true ||
      !('protocol' in result) ||
      result.protocol !== 1
    ) {
      this.fail(new Error('invalid-readiness'))
      throw new Error('invalid-readiness')
    }
    if (this.child !== child || this.session !== session) throw new Error('expired-session')
    this.ready = true
  }

  async transcribe(session: string, pcm: Float32Array): Promise<LocalTranscript> {
    if (!this.child || !this.ready || session !== this.session) throw new Error('expired-session')
    if (this.pending) throw new Error('runtime-busy')
    const reply = this.response(15000)
    const child = this.child
    const header = Buffer.alloc(4)
    header.writeUInt32LE(pcm.length)
    const input = Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)])
    child.stdin.write(input, (error) => {
      if (error && this.child === child) this.fail(new Error('runtime-stopped'))
    })
    const result = await reply
    if (this.session !== session) throw new Error('expired-session')
    if (!isLocalTranscript(result)) {
      this.fail(new Error('invalid-response'))
      throw new Error('invalid-response')
    }
    return result
  }

  stop(session?: string): void {
    if (session && this.session !== session) return
    this.session = null
    if (this.pending) return this.dispose()
    this.clearIdle()
    this.idle = setTimeout(() => this.dispose(), 5 * 60 * 1000)
  }

  dispose(): void {
    this.fail(new Error('session-stopped'))
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
  }

  private response(timeout: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        timer: setTimeout(() => this.fail(new Error('runtime-timeout')), timeout)
      }
    })
  }

  private fail(error: Error): void {
    this.clearIdle()
    const child = this.child
    this.child = null
    this.ready = false
    this.session = null
    this.language = null
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(error)
      this.pending = null
    }
    child?.kill()
  }
}
