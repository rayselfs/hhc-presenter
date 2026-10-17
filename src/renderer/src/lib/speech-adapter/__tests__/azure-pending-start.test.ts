import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../verse-parser', () => ({
  parseVerseReference: vi.fn(() => null)
}))

vi.mock('../../bible-book-matcher', () => ({
  matchBookName: vi.fn(() => null),
  getAllBookNames: vi.fn(() => [])
}))

vi.mock('microsoft-cognitiveservices-speech-sdk', () => {
  return {
    SpeechConfig: {
      fromSubscription: vi.fn(() => ({
        speechRecognitionLanguage: '',
        outputFormat: 0,
        setServiceProperty: vi.fn(),
        setProfanity: vi.fn()
      }))
    },
    AudioConfig: {
      fromDefaultMicrophoneInput: vi.fn(() => ({}))
    },
    SpeechRecognizer: vi.fn().mockImplementation(function () {
      return {
        recognizing: null as unknown,
        recognized: null as unknown,
        sessionStarted: null as unknown,
        sessionStopped: null as unknown,
        canceled: null as unknown,
        startContinuousRecognitionAsync: vi.fn(),
        stopContinuousRecognitionAsync: vi.fn((onSuccess: () => void) => onSuccess()),
        close: vi.fn()
      }
    }),
    ResultReason: {
      RecognizingSpeech: 15,
      RecognizedSpeech: 3
    },
    CancellationReason: {
      Error: 1,
      EndOfStream: 0
    },
    ServicePropertyChannel: {
      UriQueryParameter: 0
    },
    PhraseListGrammar: {
      fromRecognizer: vi.fn(() => ({
        addPhrase: vi.fn()
      }))
    },
    OutputFormat: {
      Detailed: 1
    },
    PropertyId: {
      SpeechServiceResponse_JsonResult: 'SpeechServiceResponse_JsonResult'
    },
    ProfanityOption: {
      Raw: 2
    },
    Connection: {
      fromRecognizer: vi.fn(() => ({
        openConnection: vi.fn()
      }))
    }
  }
})

import * as sdk from 'microsoft-cognitiveservices-speech-sdk'
import { AzureSpeechAdapter } from '../providers/azure-speech-adapter'

let adapter: AzureSpeechAdapter
function recognizer(): sdk.SpeechRecognizer {
  return vi.mocked(sdk.SpeechRecognizer).mock.results.at(-1)!.value
}
function succeed(instance = recognizer()): void {
  vi.mocked(instance.startContinuousRecognitionAsync).mock.calls[0][0]!()
}
function fail(message: string, instance = recognizer()): void {
  vi.mocked(instance.startContinuousRecognitionAsync).mock.calls[0][1]!(message)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('navigator', { onLine: true, language: 'en-US' })
  adapter = new AzureSpeechAdapter({ subscriptionKey: 'test-key', region: 'eastus' })
})
afterEach(() => {
  adapter.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Azure pending recognition start', () => {
  it('waits for SDK success before resolving and starting its watchdog', async () => {
    const resolved = vi.fn()
    const pending = adapter.start().then(resolved)
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    expect(adapter.isRecognizing()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    succeed()
    await pending
    expect(resolved).toHaveBeenCalledOnce()
    expect(adapter.isRecognizing()).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('rejects SDK startup failure and releases the recognizer', async () => {
    const error = vi.fn()
    adapter.on('error', error)
    const pending = adapter.start()
    const rejected = expect(pending).rejects.toThrow('microphone denied')
    const instance = recognizer()
    fail('microphone denied')
    await rejected
    expect(instance.close).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledOnce()
    expect(adapter.isRecognizing()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a concurrent start without creating another recognizer', async () => {
    const pending = adapter.start()
    await expect(adapter.start()).rejects.toThrow('already active')
    expect(sdk.SpeechRecognizer).toHaveBeenCalledOnce()
    succeed()
    await pending
  })

  it('disposal settles pending start and ignores late success and events', async () => {
    const events = vi.fn()
    adapter.on('recognizing', events)
    const pending = adapter.start()
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const instance = recognizer()
    adapter.dispose()
    await rejected
    succeed(instance)
    instance.recognizing(instance, {
      result: { reason: sdk.ResultReason.RecognizingSpeech, text: 'late' }
    } as sdk.SpeechRecognitionEventArgs)
    expect(events).not.toHaveBeenCalled()
    expect(instance.close).toHaveBeenCalledOnce()
    expect(adapter.isRecognizing()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await expect(adapter.start()).rejects.toThrow('disposed')
  })

  it('stop cancels pending start and an old callback cannot affect its replacement', async () => {
    const errors = vi.fn()
    const recognizing = vi.fn()
    const raw = vi.fn()
    const stopped = vi.fn()
    const canceled = vi.fn()
    adapter.on('rawRecognized', raw)
    adapter.on('sessionStopped', stopped)
    adapter.on('canceled', canceled)
    adapter.on('error', errors)
    adapter.on('recognizing', recognizing)
    const first = adapter.start()
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const old = recognizer()
    await adapter.stop()
    await rejected
    const next = adapter.start()
    const current = recognizer()
    succeed(old)
    fail('obsolete error', old)
    old.recognizing(old, {
      result: { reason: sdk.ResultReason.RecognizingSpeech, text: 'obsolete' }
    } as sdk.SpeechRecognitionEventArgs)
    expect(recognizing).not.toHaveBeenCalled()
    expect(adapter.isRecognizing()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(errors).not.toHaveBeenCalled()
    succeed(current)
    await next
    old.recognized(old, {
      result: {
        reason: sdk.ResultReason.RecognizedSpeech,
        text: 'obsolete'
      }
    } as sdk.SpeechRecognitionEventArgs)
    old.sessionStopped(old, { sessionId: 'obsolete' } as sdk.SessionEventArgs)
    old.canceled(old, {
      reason: sdk.CancellationReason.Error,
      errorDetails: 'obsolete'
    } as sdk.SpeechRecognitionCanceledEventArgs)
    expect(raw).not.toHaveBeenCalled()
    expect(stopped).not.toHaveBeenCalled()
    expect(canceled).not.toHaveBeenCalled()
    expect(adapter.isRecognizing()).toBe(true)
    expect(old.close).toHaveBeenCalledOnce()
    expect(current.close).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
  })
  it.each(['beforeunload', 'offline'])('cancels pending start on %s', async (event) => {
    const pending = adapter.start()
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const instance = recognizer()
    window.dispatchEvent(new Event(event))
    await rejected
    succeed(instance)
    fail('obsolete failure', instance)
    expect(instance.close).toHaveBeenCalledOnce()
    expect(adapter.isRecognizing()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['canceled', 'sessionStopped'] as const)(
    'settles pending start on SDK %s before success',
    async (event) => {
      const pending = adapter.start()
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      const instance = recognizer()
      if (event === 'canceled')
        instance.canceled(instance, {
          reason: sdk.CancellationReason.Error,
          errorDetails: 'denied'
        } as sdk.SpeechRecognitionCanceledEventArgs)
      else instance.sessionStopped(instance, { sessionId: 'stopped' } as sdk.SessionEventArgs)
      await rejected
      succeed(instance)
      fail('obsolete failure', instance)
      expect(instance.close).toHaveBeenCalledOnce()
      expect(adapter.isRecognizing()).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
