import type { SpeechLanguage } from '@shared/openai-speech'
import { speechToken } from './openai-key'

type Options = {
  language: SpeechLanguage
  deviceId: string
  onText: (text: string) => void
  onDisconnect: () => void
}

// Each instance owns one microphone and one Realtime connection.
class TranscriptionConnection {
  private readonly abort = new AbortController()
  private stream?: MediaStream
  private peer?: RTCPeerConnection
  private channel?: RTCDataChannel
  private context?: AudioContext
  private timer?: ReturnType<typeof setInterval>
  private awaitingCommit = 0
  private drained?: () => void
  private finishing?: Promise<void>
  private speaking = false
  private order: string[] = []
  private completed = new Map<string, string>()
  private delivered = new Set<string>()

  constructor(private readonly options: Options) {}

  async start(): Promise<void> {
    const signal = this.abort.signal
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: this.options.deviceId ? { deviceId: { exact: this.options.deviceId } } : true
    })
    if (signal.aborted) {
      stream.getTracks().forEach((track) => track.stop())
      signal.throwIfAborted()
    }
    this.stream = stream
    const track = stream.getAudioTracks()[0]
    track.onended = this.options.onDisconnect
    const token = await speechToken(this.options.language).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : ''
      const known = message.match(/credential|insufficientQuota|token HTTP [1-5][0-9]{2}/)
      throw new Error(known?.[0] ?? 'tokenFailed')
    })
    signal.throwIfAborted()
    const peer = new RTCPeerConnection()
    this.peer = peer
    peer.addTrack(track, stream)
    const channel = peer.createDataChannel('oai-events')
    this.channel = channel
    channel.onmessage = (event) => this.message(event.data)
    channel.onclose = this.options.onDisconnect
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected')
        this.options.onDisconnect()
    }
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/sdp' },
      body: offer.sdp,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      redirect: 'error'
    })
    if (!response.ok) throw new Error('connection HTTP ' + response.status)
    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() })
    if (channel.readyState !== 'open') {
      await new Promise<void>((resolve, reject) => {
        const timeout = AbortSignal.any([signal, AbortSignal.timeout(12000)])
        const fail = (): void => {
          cleanup()
          reject(new Error('connection'))
        }
        const open = (): void => {
          cleanup()
          resolve()
        }
        const cleanup = (): void => {
          timeout.removeEventListener('abort', fail)
          channel.removeEventListener('open', open)
          channel.removeEventListener('close', fail)
        }
        timeout.throwIfAborted()
        channel.addEventListener('open', open)
        channel.addEventListener('close', fail)
        timeout.addEventListener('abort', fail, { once: true })
      })
    }
    signal.throwIfAborted()
    const context = new AudioContext()
    this.context = context
    await context.resume()
    signal.throwIfAborted()
    const analyser = context.createAnalyser()
    context.createMediaStreamSource(stream).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    let lastVoice = 0
    let speechStart = 0
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples)
      const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length)
      const now = performance.now()
      if (rms > 0.012) {
        if (!this.speaking) speechStart = now
        lastVoice = now
        this.speaking = true
      }
      if (this.speaking && (now - lastVoice >= 800 || now - speechStart >= 20000)) {
        this.commit()
      }
    }, 100)
  }

  private message(raw: unknown): void {
    if (typeof raw !== 'string' || this.abort.signal.aborted) return
    let event
    try {
      event = JSON.parse(raw)
    } catch {
      return
    }
    if (event?.type === 'error') {
      this.options.onDisconnect()
      return
    }
    const id = event?.item_id
    if (typeof id !== 'string' || this.delivered.has(id)) return
    if (event.type === 'input_audio_buffer.committed') {
      if (!this.order.includes(id)) {
        this.awaitingCommit = Math.max(0, this.awaitingCommit - 1)
        this.order.push(id)
      }
    } else if (
      event.type === 'conversation.item.input_audio_transcription.completed' ||
      event.type === 'conversation.item.input_audio_transcription.failed'
    ) {
      this.completed.set(id, typeof event.transcript === 'string' ? event.transcript : '')
    }
    while (this.order.length && this.completed.has(this.order[0])) {
      const first = this.order.shift()!
      const text = this.completed.get(first)!
      this.completed.delete(first)
      this.delivered.add(first)
      if (text) this.options.onText(text)
    }
    if (this.awaitingCommit === 0 && this.order.length === 0) this.drained?.()
  }

  private commit(): void {
    if (this.channel?.readyState === 'open') {
      this.channel.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
      this.awaitingCommit++
    }
    this.speaking = false
  }

  finish(): Promise<void> {
    return (this.finishing ??= this.finishPending())
  }

  private async finishPending(): Promise<void> {
    clearInterval(this.timer)
    this.stream?.getTracks().forEach((track) => {
      track.enabled = false
    })
    if (this.speaking) this.commit()
    if (this.channel?.readyState === 'open' && (this.awaitingCommit || this.order.length)) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 5000)
        this.drained = () => {
          clearTimeout(timeout)
          resolve()
        }
      })
      this.drained = undefined
    }
    this.close()
  }

  close(): void {
    if (this.abort.signal.aborted) return
    this.abort.abort()
    this.drained?.()
    clearInterval(this.timer)
    if (this.channel) {
      this.channel.onclose = null
      this.channel.onmessage = null
      this.channel.close()
    }
    if (this.peer) {
      this.peer.onconnectionstatechange = null
      this.peer.close()
    }
    this.stream?.getTracks().forEach((track) => {
      track.onended = null
      track.stop()
    })
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {})
  }
}

// Renew the upstream connection before a long service reaches the Realtime session limit.
// A replacement starts only after its predecessor releases the microphone.
export class OpenAITranscription {
  private active?: TranscriptionConnection
  private renewal?: ReturnType<typeof setTimeout>
  private stopped = false

  constructor(private readonly options: Options) {}

  async start(): Promise<void> {
    if (this.stopped) return
    const connection = new TranscriptionConnection(this.options)
    this.active = connection
    await connection.start()
    if (this.stopped || this.active !== connection) return
    this.renewal = setTimeout(
      () => {
        void this.renew(connection).catch(() => {
          if (!this.stopped) this.options.onDisconnect()
        })
      },
      55 * 60 * 1000
    )
  }

  private async renew(connection: TranscriptionConnection): Promise<void> {
    await connection.finish()
    if (!this.stopped && this.active === connection) await this.start()
  }

  async finish(): Promise<void> {
    this.stopped = true
    clearTimeout(this.renewal)
    await this.active?.finish()
  }

  close(): void {
    this.stopped = true
    clearTimeout(this.renewal)
    this.active?.close()
  }
}
