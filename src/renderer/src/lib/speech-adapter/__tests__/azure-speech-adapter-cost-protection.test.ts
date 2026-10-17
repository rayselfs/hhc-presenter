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
        startContinuousRecognitionAsync: vi.fn((onSuccess: () => void) => onSuccess()),
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
import { parseVerseReference } from '../../verse-parser'
import { AzureSpeechAdapter } from '../providers/azure-speech-adapter'
import { createSpeechAdapter } from '..'
import { DEFAULT_SPEECH } from '@renderer/stores/settings'

function getRecognizerInstance(): Record<string, unknown> {
  const mock = vi.mocked(sdk.SpeechRecognizer)
  return mock.mock.results[mock.mock.results.length - 1].value as Record<string, unknown>
}

function createAdapter(overrides: Record<string, unknown> = {}): AzureSpeechAdapter {
  return new AzureSpeechAdapter({
    subscriptionKey: 'test-key',
    region: 'eastus',
    language: 'en-US',
    ...overrides
  })
}

async function startAdapter(adapter: AzureSpeechAdapter): Promise<void> {
  await adapter.start()
}

describe('AzureSpeechAdapter - Cost Protection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { onLine: true, language: 'en-US' })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('selects the tested Azure provider for both factory entry points', async () => {
    const legacy = await createSpeechAdapter({ subscriptionKey: 'test-key', region: 'eastus' })
    const selected = await createSpeechAdapter('azure', DEFAULT_SPEECH, { maxSessionMs: 30_000 })
    try {
      expect(legacy).toBeInstanceOf(AzureSpeechAdapter)
      expect(selected).toBeInstanceOf(AzureSpeechAdapter)
      const stopped = vi.fn()
      selected.on('maxDurationReached', stopped)
      await selected.start()
      await vi.advanceTimersByTimeAsync(29_999)
      expect(stopped).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(stopped).toHaveBeenCalledOnce()
    } finally {
      await legacy.dispose()
      await selected.dispose()
    }
  })

  describe('idle timeout', () => {
    it('emits idleTimeout with default 3min timeout', async () => {
      const handler = vi.fn()
      const adapter = createAdapter()
      adapter.on('idleTimeout', handler)

      await startAdapter(adapter)

      vi.advanceTimersByTime(2 * 60 * 1000 + 30_000)
      expect(handler).not.toHaveBeenCalled()

      vi.advanceTimersByTime(60_000)
      expect(handler).toHaveBeenCalledTimes(1)

      adapter.dispose()
    })

    it('respects custom idleTimeoutMs', async () => {
      const handler = vi.fn()
      const adapter = createAdapter({ idleTimeoutMs: 60_000 })
      adapter.on('idleTimeout', handler)

      await startAdapter(adapter)

      vi.advanceTimersByTime(30_000)
      expect(handler).not.toHaveBeenCalled()

      vi.advanceTimersByTime(30_000)
      expect(handler).toHaveBeenCalledTimes(1)

      adapter.dispose()
    })

    it('resets idle timer on recognizing event', async () => {
      const handler = vi.fn()
      const adapter = createAdapter({ idleTimeoutMs: 60_000 })
      adapter.on('idleTimeout', handler)

      await startAdapter(adapter)

      vi.advanceTimersByTime(50_000)

      const instance = getRecognizerInstance()
      const recognizingCb = instance.recognizing as (_s: unknown, e: unknown) => void
      recognizingCb(null, { result: { reason: 15, text: 'test' } })

      vi.advanceTimersByTime(50_000)
      expect(handler).not.toHaveBeenCalled()

      vi.advanceTimersByTime(30_000)
      expect(handler).toHaveBeenCalledTimes(1)

      adapter.dispose()
    })

    it('calls stop on idle timeout', async () => {
      const adapter = createAdapter({ idleTimeoutMs: 60_000 })
      await startAdapter(adapter)

      vi.advanceTimersByTime(90_000)

      const instance = getRecognizerInstance()
      const stopFn = instance.stopContinuousRecognitionAsync as ReturnType<typeof vi.fn>
      expect(stopFn).toHaveBeenCalled()

      adapter.dispose()
    })
  })

  describe('max session duration', () => {
    it('emits maxDurationReached with default 60min', async () => {
      const handler = vi.fn()
      const adapter = createAdapter({ idleTimeoutMs: 90 * 60 * 1000 })
      adapter.on('maxDurationReached', handler)

      await startAdapter(adapter)

      vi.advanceTimersByTime(59 * 60 * 1000 + 30_000)
      expect(handler).not.toHaveBeenCalled()

      vi.advanceTimersByTime(60_000)
      expect(handler).toHaveBeenCalledTimes(1)

      adapter.dispose()
    })

    it('respects custom maxSessionMs', async () => {
      const handler = vi.fn()
      const adapter = createAdapter({ maxSessionMs: 120_000 })
      adapter.on('maxDurationReached', handler)

      await startAdapter(adapter)

      vi.advanceTimersByTime(90_000)
      expect(handler).not.toHaveBeenCalled()

      vi.advanceTimersByTime(60_000)
      expect(handler).toHaveBeenCalledTimes(1)

      adapter.dispose()
    })

    it('max session fires before idle when both would trigger', async () => {
      const idleHandler = vi.fn()
      const maxHandler = vi.fn()
      const adapter = createAdapter({ idleTimeoutMs: 60_000, maxSessionMs: 60_000 })
      adapter.on('idleTimeout', idleHandler)
      adapter.on('maxDurationReached', maxHandler)

      await startAdapter(adapter)

      vi.advanceTimersByTime(90_000)
      expect(maxHandler).toHaveBeenCalledTimes(1)
      expect(idleHandler).not.toHaveBeenCalled()

      adapter.dispose()
    })
  })

  describe('error retry limit', () => {
    it('stops after 3 consecutive errors', async () => {
      const errorHandler = vi.fn()
      const adapter = createAdapter()
      adapter.on('error', errorHandler)

      await startAdapter(adapter)
      const instance = getRecognizerInstance()
      const canceledCb = instance.canceled as (_s: unknown, e: unknown) => void

      for (let i = 0; i < 3; i++) {
        canceledCb(null, { reason: 1, errorDetails: `Error ${i + 1}` })
      }

      expect(errorHandler).toHaveBeenCalledTimes(3)
      const thirdCall = errorHandler.mock.calls[2][0] as { message: string }
      expect(thirdCall.message).toContain('3')

      adapter.dispose()
    })

    it('resets error count on successful recognition', async () => {
      const errorHandler = vi.fn()
      const adapter = createAdapter()
      adapter.on('error', errorHandler)

      await startAdapter(adapter)
      const instance = getRecognizerInstance()
      const canceledCb = instance.canceled as (_s: unknown, e: unknown) => void
      const recognizedCb = instance.recognized as (_s: unknown, e: unknown) => void

      for (let i = 0; i < 2; i++) {
        canceledCb(null, { reason: 1, errorDetails: `Error ${i}` })
      }

      recognizedCb(null, { result: { reason: 3, text: 'test' } })

      for (let i = 0; i < 2; i++) {
        canceledCb(null, { reason: 1, errorDetails: `Error after ${i}` })
      }

      expect(errorHandler).toHaveBeenCalledTimes(4)
      for (const call of errorHandler.mock.calls) {
        const data = call[0] as { message: string }
        expect(data.message).not.toContain('stopped after')
      }

      adapter.dispose()
    })
  })

  describe('beforeunload handler', () => {
    it('calls stopContinuousRecognitionAsync and close on beforeunload when active', async () => {
      const adapter = createAdapter()
      await startAdapter(adapter)

      window.dispatchEvent(new Event('beforeunload'))

      const instance = getRecognizerInstance()
      const stopFn = instance.stopContinuousRecognitionAsync as ReturnType<typeof vi.fn>
      const closeFn = instance.close as ReturnType<typeof vi.fn>
      expect(stopFn).toHaveBeenCalled()
      expect(closeFn).toHaveBeenCalled()

      adapter.dispose()
    })
  })

  describe('dispose cleanup', () => {
    it('stops watchdog on dispose', async () => {
      const handler = vi.fn()
      const adapter = createAdapter({ idleTimeoutMs: 60_000 })
      adapter.on('idleTimeout', handler)

      await startAdapter(adapter)
      adapter.dispose()

      vi.advanceTimersByTime(120_000)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('confidence filtering', () => {
    function makeResult(
      text: string,
      confidence: number
    ): {
      result: {
        reason: number
        text: string
        properties: { getProperty: ReturnType<typeof vi.fn> }
      }
    } {
      return {
        result: {
          reason: 3,
          text,
          properties: {
            getProperty: vi.fn(() => JSON.stringify({ NBest: [{ Confidence: confidence }] }))
          }
        }
      }
    }

    it('accepts high-confidence results (>= 0.7)', async () => {
      const handler = vi.fn()
      const adapter = createAdapter()
      adapter.on('recognized', handler)

      await startAdapter(adapter)
      const instance = getRecognizerInstance()
      const recognizedCb = instance.recognized as (_s: unknown, e: unknown) => void

      recognizedCb(null, makeResult('創世記第一章', 0.85))
      expect(parseVerseReference).toHaveBeenCalledWith('創世記第一章')

      adapter.dispose()
    })

    it('ignores low-confidence results (< 0.4)', async () => {
      const handler = vi.fn()
      const adapter = createAdapter()
      adapter.on('recognized', handler)

      await startAdapter(adapter)
      const instance = getRecognizerInstance()
      const recognizedCb = instance.recognized as (_s: unknown, e: unknown) => void

      recognizedCb(null, makeResult('random noise', 0.2))
      expect(parseVerseReference).not.toHaveBeenCalled()

      expect(handler).not.toHaveBeenCalled()
      adapter.dispose()
    })

    it('accepts medium-confidence results (0.4-0.7) for verse parsing', async () => {
      const handler = vi.fn()
      const adapter = createAdapter()
      adapter.on('rawRecognized', handler)

      await startAdapter(adapter)
      const instance = getRecognizerInstance()
      const recognizedCb = instance.recognized as (_s: unknown, e: unknown) => void

      recognizedCb(null, makeResult('可能的文字', 0.55))
      expect(parseVerseReference).toHaveBeenCalledWith('可能的文字')

      expect(handler).toHaveBeenCalledWith({ text: '可能的文字', confidence: 0.55 })
      adapter.dispose()
    })

    it('passes through when confidence is unavailable', async () => {
      const adapter = createAdapter()

      await startAdapter(adapter)
      const instance = getRecognizerInstance()
      const recognizedCb = instance.recognized as (_s: unknown, e: unknown) => void

      recognizedCb(null, { result: { reason: 3, text: 'no properties' } })
      expect(parseVerseReference).toHaveBeenCalledWith('no properties')

      adapter.dispose()
    })
  })
})
