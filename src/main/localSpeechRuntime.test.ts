import { it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { LocalSpeechRuntime } from './localSpeechRuntime'

vi.mock('node:child_process', () => {
  const spawn = vi.fn()
  return { spawn, default: { spawn } }
})
const fakeChild = (): ChildProcessWithoutNullStreams =>
  Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn()
  }) as unknown as ChildProcessWithoutNullStreams
const config = '/native-speech'

it('cancels preparation and cannot let old output consume a newer session', async () => {
  const old = fakeChild(),
    next = fakeChild()
  vi.mocked(spawn).mockReturnValueOnce(old).mockReturnValueOnce(next)
  const runtime = new LocalSpeechRuntime(config)
  const preparing = runtime.prepare('old', 'zh', '/model')
  const cancelled = expect(preparing).rejects.toThrow('stopped')
  runtime.stop('old')
  await cancelled
  const ready = runtime.prepare('next', 'zh', '/model')
  old.stdout.emit('data', '{"ready":true,"protocol":1}\n')
  next.stdout.emit('data', '{"ready":true,"protocol":1}\n')
  await ready
  runtime.stop('old')
  const request = runtime.transcribe('next', new Float32Array([0.1]))
  await expect(runtime.transcribe('next', new Float32Array([0.1]))).rejects.toThrow('busy')
  next.stdout.emit('data', '{"text":"x","reference":null,"asrMs":1,"locateMs":1}\n')
  expect((await request).text).toBe('x')
  runtime.dispose()
})

it('rejects pending work on process exit and rejects expired tokens', async () => {
  const child = fakeChild()
  vi.mocked(spawn).mockReturnValueOnce(child)
  const runtime = new LocalSpeechRuntime(config)
  const ready = runtime.prepare('session', 'zh', '/model')
  child.stdout.emit('data', '{"ready":true,"protocol":1}\n')
  await ready
  await expect(runtime.transcribe('other', new Float32Array([0.1]))).rejects.toThrow('expired')
  const request = runtime.transcribe('session', new Float32Array([0.1]))
  const failed = expect(request).rejects.toThrow('stopped')
  child.emit('exit', 1)
  await failed
})

it('keeps an idle model warm but never retains an inference after stop', async () => {
  const child = fakeChild()
  vi.mocked(spawn).mockReturnValueOnce(child)
  const runtime = new LocalSpeechRuntime(config)
  const ready = runtime.prepare('first', 'en', '/small')
  child.stdout.emit('data', '{"ready":true,"protocol":1}\n')
  await ready
  runtime.stop('first')
  await runtime.prepare('second', 'en', '/small')
  expect(child.kill).not.toHaveBeenCalled()
  const pending = runtime.transcribe('second', new Float32Array([0.1]))
  const cancelled = expect(pending).rejects.toThrow('stopped')
  runtime.stop('second')
  await cancelled
  expect(child.kill).toHaveBeenCalledOnce()
})
it('evicts an idle resident model after five minutes', async () => {
  vi.useFakeTimers()
  const child = fakeChild()
  vi.mocked(spawn).mockReturnValueOnce(child)
  const runtime = new LocalSpeechRuntime(config)
  try {
    const ready = runtime.prepare('session', 'zh', '/model')
    child.stdout.emit('data', '{"ready":true,"protocol":1}\n')
    await ready
    runtime.stop('session')
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(child.kill).toHaveBeenCalledOnce()
  } finally {
    runtime.dispose()
    vi.useRealTimers()
  }
})
