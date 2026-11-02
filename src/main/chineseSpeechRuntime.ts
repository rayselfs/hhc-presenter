import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isChineseSpeechResult, type ChineseSpeechResult } from '../shared/chinese-speech'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Development pilot only. Packaging a self-contained native runtime is a separate gate.
export class ChineseSpeechRuntime {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending: Pending | null = null
  private session: string | null = null

  constructor(
    private readonly config: { python: string; script: string; data: string; node: string }
  ) {}

  async prepare(session: string): Promise<void> {
    if (this.child) throw new Error('Chinese speech is already active')
    const child = spawn(this.config.python, ['-u', this.config.script, this.config.data], {
      stdio: 'pipe',
      env: { ...process.env, HHC_SPEECH_NODE: this.config.node }
    })
    this.child = child
    this.session = session
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return
      buffer += chunk
      if (buffer.length > 100000) return this.fail(new Error('Invalid speech response'))
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        try {
          const value: unknown = JSON.parse(line)
          const pending = this.pending
          this.pending = null
          if (!pending) return this.fail(new Error('Unexpected speech response'))
          clearTimeout(pending.timer)
          pending.resolve(value)
        } catch {
          this.fail(new Error('Invalid speech response'))
        }
      }
    })
    // Drain native diagnostics without logging private transcripts or PCM.
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => {
      if (this.child === child) this.fail(new Error('Speech input closed'))
    })
    child.on('error', () => {
      if (this.child === child) this.fail(new Error('Speech runtime failed to start'))
    })
    child.on('exit', () => {
      if (this.child === child) this.fail(new Error('Speech runtime stopped'))
    })
    const ready = await this.response(60000)
    if (
      typeof ready !== 'object' ||
      ready === null ||
      !('ready' in ready) ||
      ready.ready !== true
    ) {
      this.fail(new Error('Invalid speech readiness'))
      throw new Error('Invalid speech readiness')
    }
    if (this.child !== child || this.session !== session) throw new Error('Expired session')
  }

  async transcribe(session: string, pcm: Float32Array): Promise<ChineseSpeechResult> {
    if (!this.child || !this.session || session !== this.session) throw new Error('Expired session')
    if (this.pending) throw new Error('Speech runtime busy')
    const reply = this.response(15000)
    const child = this.child
    child.stdin.write(
      JSON.stringify({
        pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')
      }) + '\n',
      (error) => {
        if (error && this.child === child) this.fail(new Error('Speech request failed'))
      }
    )
    const result = await reply
    if (session !== this.session) throw new Error('Expired session')
    if (!isChineseSpeechResult(result)) {
      this.fail(new Error('Invalid speech result'))
      throw new Error('Invalid speech result')
    }
    return result
  }

  stop(session?: string): void {
    if (session && session !== this.session) return
    this.fail(new Error('Speech session stopped'))
  }

  private response(timeout: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        timer: setTimeout(() => this.fail(new Error('Speech runtime timed out')), timeout)
      }
    })
  }

  private fail(error: Error): void {
    const child = this.child
    this.child = null
    this.session = null
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(error)
      this.pending = null
    }
    child?.kill()
  }
}
