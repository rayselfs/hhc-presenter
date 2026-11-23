import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAITranscription } from './openai-transcription'
vi.mock('./openai-key', () => ({ speechToken: async () => 'ek_fixture' }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
describe('live session', () => {
  const stop = vi.fn()
  const channels: Array<{
    readyState: string
    onmessage: ((e: { data: string }) => void) | null
    close: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
  }> = []
  beforeEach(() => {
    vi.useFakeTimers()
    stop.mockClear()
    channels.length = 0
    const makeChannel = (): (typeof channels)[number] => {
      const channel = {
        readyState: 'open',
        onmessage: null as ((e: { data: string }) => void) | null,
        close: vi.fn(),
        send: vi.fn()
      }
      channels.push(channel)
      return channel
    }
    const track = { stop, enabled: true }
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] }
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream } })
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        addTrack = vi.fn()
        createDataChannel = makeChannel
        createOffer = vi.fn().mockResolvedValue({ sdp: 'offer' })
        setLocalDescription = vi.fn()
        setRemoteDescription = vi.fn()
        close = vi.fn()
      }
    )
    vi.stubGlobal(
      'AudioContext',
      class {
        resume = vi.fn()
        createAnalyser = vi.fn().mockReturnValue({ fftSize: 32, getFloatTimeDomainData: vi.fn() })
        createMediaStreamSource = vi.fn().mockReturnValue({ connect: vi.fn() })
        close = vi.fn().mockResolvedValue(undefined)
      }
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('answer'))
    )
  })
  it('renews the connection during a simulated 90-minute service and stops further renewal', async () => {
    const onDisconnect = vi.fn()
    const connection = new OpenAITranscription({
      language: 'zh',
      deviceId: 'usb',
      onText: vi.fn(),
      onDisconnect
    })
    await connection.start()
    vi.advanceTimersByTime(55 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(channels).toHaveLength(2)
    expect(channels[0].close).toHaveBeenCalledOnce()
    expect(channels[1].close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(35 * 60 * 1000)
    await connection.finish()
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(55 * 60 * 1000)
    expect(channels).toHaveLength(2)
  })
  it('delivers committed items in spoken order exactly once and releases audio on close', async () => {
    const onText = vi.fn()
    const connection = new OpenAITranscription({
      language: 'zh',
      deviceId: 'usb',
      onText,
      onDisconnect: vi.fn()
    })
    await connection.start()
    const channel = channels[0]
    const send = (type: string, id: string, transcript = ''): void =>
      channel.onmessage?.({ data: JSON.stringify({ type, item_id: id, transcript }) })
    send('input_audio_buffer.committed', 'a')
    send('input_audio_buffer.committed', 'b')
    const done = 'conversation.item.input_audio_transcription.completed'
    const finishing = connection.finish()
    await vi.advanceTimersByTimeAsync(1800)
    expect(channel.close).not.toHaveBeenCalled()
    send(done, 'b', '第十六節')
    send(done, 'a', '約翰福音第三章')
    send(done, 'a', '約翰福音第三章')
    expect(onText.mock.calls).toEqual([['約翰福音第三章'], ['第十六節']])
    await finishing
    expect(channel.close).toHaveBeenCalledOnce()
    connection.close()
    expect(stop).toHaveBeenCalledOnce()
  })
})
it('releases a microphone grant received after cancellation', async () => {
  let grant!: (s: unknown) => void
  const stop = vi.fn()
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: () =>
        new Promise((resolve) => {
          grant = resolve
        })
    }
  })
  const connection = new OpenAITranscription({
    language: 'zh',
    deviceId: '',
    onText: vi.fn(),
    onDisconnect: vi.fn()
  })
  const started = connection.start()
  connection.close()
  grant({ getTracks: () => [{ stop }] })
  await expect(started).rejects.toThrow()
  expect(stop).toHaveBeenCalledOnce()
})
