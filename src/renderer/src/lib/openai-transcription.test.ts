import { afterEach, expect, it, vi } from 'vitest'
import { OpenAITranscription } from './openai-transcription'
vi.mock('./openai-key', () => ({ speechToken: async () => 'ek_fixture' }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('delivers committed items in spoken order exactly once and releases audio on close', async () => {
  const stop = vi.fn()
  const channel = {
    readyState: 'open',
    onmessage: null as ((e: { data: string }) => void) | null,
    close: vi.fn(),
    send: vi.fn()
  }
  const track = { stop, enabled: true }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] }
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream } })
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      addTrack = vi.fn()
      createDataChannel = vi.fn().mockReturnValue(channel)
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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('answer')))
  const onText = vi.fn()
  const connection = new OpenAITranscription({
    language: 'zh',
    deviceId: 'usb',
    onText,
    onDisconnect: vi.fn()
  })
  await connection.start()
  const send = (type: string, id: string, transcript = ''): void =>
    channel.onmessage?.({ data: JSON.stringify({ type, item_id: id, transcript }) })
  send('input_audio_buffer.committed', 'a')
  send('input_audio_buffer.committed', 'b')
  const done = 'conversation.item.input_audio_transcription.completed'
  send(done, 'b', '第十六節')
  send(done, 'a', '約翰福音第三章')
  send(done, 'a', '約翰福音第三章')
  expect(onText.mock.calls).toEqual([['約翰福音第三章'], ['第十六節']])
  connection.close()
  connection.close()
  expect(stop).toHaveBeenCalledOnce()
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
