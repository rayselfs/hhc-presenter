import { it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ChineseSpeechRuntime } from './chineseSpeechRuntime'

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
const config = { python: '/python', script: '/runtime.py', data: '/data', node: '/node' }

it('cancels preparation and cannot let old output consume a newer session', async () => {
  const old = fakeChild(),
    next = fakeChild()
  vi.mocked(spawn).mockReturnValueOnce(old).mockReturnValueOnce(next)
  const runtime = new ChineseSpeechRuntime(config)
  const preparing = runtime.prepare('old')
  const cancelled = expect(preparing).rejects.toThrow('stopped')
  runtime.stop('old')
  await cancelled
  const ready = runtime.prepare('next')
  old.stdout.emit('data', '{"ready":true}\n')
  next.stdout.emit('data', '{"ready":true}\n')
  await ready
  runtime.stop('old')
  const request = runtime.transcribe('next', new Float32Array([0.1]))
  await expect(runtime.transcribe('next', new Float32Array([0.1]))).rejects.toThrow('busy')
  next.stdout.emit('data', '{"text":"x","reference":null,"asrMs":1,"locateMs":1}\n')
  expect((await request).reference).toBeNull()
  runtime.stop('next')
})

it('rejects pending work on process exit and rejects expired tokens', async () => {
  const child = fakeChild()
  vi.mocked(spawn).mockReturnValueOnce(child)
  const runtime = new ChineseSpeechRuntime(config)
  const ready = runtime.prepare('session')
  child.stdout.emit('data', '{"ready":true}\n')
  await ready
  await expect(runtime.transcribe('other', new Float32Array([0.1]))).rejects.toThrow('Expired')
  const request = runtime.transcribe('session', new Float32Array([0.1]))
  const failed = expect(request).rejects.toThrow('stopped')
  child.emit('exit', 1)
  await failed
})
