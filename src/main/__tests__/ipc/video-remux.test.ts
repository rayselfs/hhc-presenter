import { promises as fs } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const testRoot = `/tmp/hhc-video-remux-test-${process.pid}`
const { mockRunFfmpeg, mockResolveFfmpegRuntime } = vi.hoisted(() => ({
  mockRunFfmpeg: vi.fn(),
  mockResolveFfmpegRuntime: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => testRoot } }))
vi.mock('../../ipc/ffmpeg-process', () => ({ runFfmpegProcess: mockRunFfmpeg }))
vi.mock('../../video-engine-runtime', () => ({ resolveFfmpegRuntime: mockResolveFfmpegRuntime }))

import {
  cleanupStaleVideoRemuxTemps,
  clearVideoCache,
  getVideoCacheUsage,
  lockVideoPlaybackSource,
  mutateVideoSource,
  resolveVideoPlaybackPath
} from '../../ipc/video-remux'
import { getNativeFilePath } from '../../ipc/native-fs'

const sourceId = '123e4567-e89b-42d3-a456-426614174000'

async function writeSource(bytes: string): Promise<void> {
  const path = getNativeFilePath(sourceId)
  await fs.mkdir(join(testRoot, 'native-files'), { recursive: true })
  await fs.writeFile(path, bytes)
}

beforeEach(async () => {
  vi.clearAllMocks()
  await fs.rm(testRoot, { recursive: true, force: true })
  mockResolveFfmpegRuntime.mockReturnValue({
    status: 'ready',
    path: '/runtime/ffmpeg',
    source: 'bundled'
  })
  mockRunFfmpeg.mockImplementation(async ({ args }: { args: string[] }) => {
    if (args.at(-1) !== '-') await fs.writeFile(args.at(-1)!, 'remuxed')
    return { stdout: '', stderr: '' }
  })
})

describe('video remux cache', () => {
  it('accounts for cache and temporary bytes and clears only idle derivatives', async () => {
    await writeSource('original')
    const output = await resolveVideoPlaybackPath(sourceId, 'matroska-remux')
    const temporary = join(testRoot, 'video-remux-cache', `.${sourceId}.test.tmp.mkv`)
    await fs.writeFile(temporary, 'temp')
    const usage = await getVideoCacheUsage()
    expect(usage.cacheBytes).toBeGreaterThan(7)
    expect(usage.temporaryBytes).toBe(4)
    const release = lockVideoPlaybackSource(sourceId)
    await clearVideoCache()
    await expect(fs.readFile(output, 'utf8')).resolves.toBe('remuxed')
    release()
    await clearVideoCache()
    expect(await getVideoCacheUsage()).toEqual({ cacheBytes: 0, temporaryBytes: 0 })
    await expect(fs.readFile(getNativeFilePath(sourceId), 'utf8')).resolves.toBe('original')
  })

  it('does not remove an in-flight remux temporary output', async () => {
    await writeSource('original')
    let complete: (() => void) | undefined
    mockRunFfmpeg.mockImplementationOnce(async ({ args }: { args: string[] }) => {
      await fs.writeFile(args.at(-1)!, 'remuxed')
      await new Promise<void>((resolve) => {
        complete = resolve
      })
      return { stdout: '', stderr: '' }
    })
    const preparing = resolveVideoPlaybackPath(sourceId, 'matroska-remux')
    await vi.waitFor(() => expect(complete).toBeDefined())
    await clearVideoCache()
    expect((await getVideoCacheUsage()).temporaryBytes).toBe(7)
    complete?.()
    await expect(preparing).resolves.toContain(sourceId)
  })

  it('reports inspection and remux separately without pretending cache hits are remux work', async () => {
    await writeSource('source')
    const phase = vi.fn()
    await resolveVideoPlaybackPath(sourceId, 'matroska-remux', phase)
    expect(phase.mock.calls).toEqual([['inspection'], ['remux']])
    phase.mockClear()
    await resolveVideoPlaybackPath(sourceId, 'matroska-remux', phase)
    expect(phase.mock.calls).toEqual([['inspection']])
  })

  it('reuses only a non-empty derivative with the current SHA-256 fingerprint', async () => {
    await writeSource('first bytes')
    const first = await resolveVideoPlaybackPath(sourceId, 'matroska-remux')
    const reused = await resolveVideoPlaybackPath(sourceId, 'matroska-remux')
    expect(reused).toBe(first)
    expect(mockRunFfmpeg).toHaveBeenCalledTimes(2)

    await writeSource('replacement bytes')
    await resolveVideoPlaybackPath(sourceId, 'matroska-remux')
    expect(mockRunFfmpeg).toHaveBeenCalledTimes(4)

    await fs.rm(join(testRoot, 'video-remux-cache', `${sourceId}.json`))
    await resolveVideoPlaybackPath(sourceId, 'matroska-remux')
    expect(mockRunFfmpeg).toHaveBeenCalledTimes(6)

    await fs.writeFile(first, '')
    await resolveVideoPlaybackPath(sourceId, 'matroska-remux')
    expect(mockRunFfmpeg).toHaveBeenCalledTimes(8)
    await expect(fs.readFile(getNativeFilePath(sourceId), 'utf8')).resolves.toBe(
      'replacement bytes'
    )
  })

  it('deduplicates concurrent remux and uses the exact stream-copy contract', async () => {
    await writeSource('source bytes')
    const [first, second] = await Promise.all([
      resolveVideoPlaybackPath(sourceId, 'matroska-remux'),
      resolveVideoPlaybackPath(sourceId, 'matroska-remux')
    ])

    expect(second).toBe(first)
    expect(mockRunFfmpeg).toHaveBeenCalledTimes(2)
    expect(mockRunFfmpeg).toHaveBeenNthCalledWith(1, {
      executable: '/runtime/ffmpeg',
      args: [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-i',
        getNativeFilePath(sourceId),
        '-map',
        '0',
        '-c',
        'copy',
        '-f',
        'matroska',
        expect.stringMatching(/\.tmp\.mkv$/)
      ],
      timeoutMs: 30 * 60 * 1000,
      signal: expect.any(AbortSignal)
    })
    expect(mockRunFfmpeg).toHaveBeenNthCalledWith(2, {
      executable: '/runtime/ffmpeg',
      args: [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-xerror',
        '-i',
        expect.stringMatching(/\.tmp\.mkv$/),
        '-map',
        '0',
        '-c',
        'copy',
        '-f',
        'null',
        '-'
      ],
      timeoutMs: expect.any(Number),
      signal: expect.any(AbortSignal)
    })
  })

  it('rejects and removes a non-empty derivative with no readable packets', async () => {
    await writeSource('truncated packet bytes')
    mockRunFfmpeg
      .mockImplementationOnce(async ({ args }: { args: string[] }) => {
        await fs.writeFile(args.at(-1)!, 'header only')
        return { stdout: '', stderr: '' }
      })
      .mockRejectedValueOnce(new Error('Error opening input files: End of file'))

    await expect(resolveVideoPlaybackPath(sourceId, 'matroska-remux')).rejects.toThrow(
      'matroska-remux-failed'
    )
    await expect(fs.readFile(getNativeFilePath(sourceId), 'utf8')).resolves.toBe(
      'truncated packet bytes'
    )
    await expect(
      fs.stat(join(testRoot, 'video-remux-cache', `${sourceId}.mkv`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      fs.stat(join(testRoot, 'video-remux-cache', `${sourceId}.json`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('enforces the exact free-space threshold', async () => {
    await writeSource('1234567890')
    const required = Math.ceil(10 * 1.2) + 256 * 1024 * 1024
    const statfs = vi.spyOn(fs, 'statfs')
    statfs.mockResolvedValueOnce({ bavail: required - 1, bsize: 1 } as Awaited<
      ReturnType<typeof fs.statfs>
    >)
    await expect(resolveVideoPlaybackPath(sourceId, 'matroska-remux')).rejects.toThrow(
      'insufficient-storage'
    )
    statfs.mockResolvedValueOnce({ bavail: required, bsize: 1 } as Awaited<
      ReturnType<typeof fs.statfs>
    >)
    await expect(resolveVideoPlaybackPath(sourceId, 'matroska-remux')).resolves.toMatch(/\.mkv$/)
  })

  it('aborts and settles active work before a source mutation, then resolves new bytes', async () => {
    await writeSource('old bytes')
    let rejectRun!: (error: Error) => void
    mockRunFfmpeg.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          rejectRun = reject
          signal.addEventListener('abort', () => undefined)
        })
    )
    const oldResolve = resolveVideoPlaybackPath(sourceId, 'matroska-remux')
    await vi.waitFor(() => expect(mockRunFfmpeg).toHaveBeenCalledOnce())
    const signal = mockRunFfmpeg.mock.calls[0][0].signal as AbortSignal
    let mutationStarted = false
    const mutation = mutateVideoSource(sourceId, async () => {
      mutationStarted = true
      await writeSource('new bytes')
    })
    const newResolve = resolveVideoPlaybackPath(sourceId, 'matroska-remux')

    expect(signal.aborted).toBe(true)
    expect(mutationStarted).toBe(false)
    rejectRun(new Error('FFmpeg process aborted'))
    await expect(oldResolve).rejects.toThrow('aborted')
    await mutation
    await expect(newResolve).resolves.toMatch(/\.mkv$/)
    expect(mockRunFfmpeg).toHaveBeenCalledTimes(3)
  })

  it('rejects a derivative when source identity changes before publish', async () => {
    await writeSource('old bytes')
    mockRunFfmpeg.mockImplementationOnce(async ({ args }: { args: string[] }) => {
      await fs.writeFile(args.at(-1)!, 'remuxed')
      await writeSource('new bytes')
      return { stdout: '', stderr: '' }
    })

    await expect(resolveVideoPlaybackPath(sourceId, 'matroska-remux')).rejects.toThrow(
      'source-replaced'
    )
    await expect(
      fs.stat(join(testRoot, 'video-remux-cache', `${sourceId}.mkv`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes only remux temps older than 24 hours', async () => {
    const cache = join(testRoot, 'video-remux-cache')
    await fs.mkdir(cache, { recursive: true })
    const stale = join(cache, `.${sourceId}.stale.tmp.mkv`)
    const fresh = join(cache, `.${sourceId}.fresh.tmp.mkv`)
    await Promise.all([fs.writeFile(stale, 'x'), fs.writeFile(fresh, 'x')])
    const now = Date.now()
    await fs.utimes(stale, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000))

    await expect(cleanupStaleVideoRemuxTemps(now)).resolves.toBe(1)
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(fresh)).resolves.toBeDefined()
  })
})
