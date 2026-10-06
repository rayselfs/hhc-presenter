import { app } from 'electron'
import type { VideoCacheUsage } from '../../shared/ipc-channels'
import { createHash, randomUUID } from 'crypto'
import { createReadStream, promises as fs } from 'fs'
import { join, resolve } from 'path'
import { isValidNativeFileId } from '../../shared/native-media'
import { resolveFfmpegRuntime } from '../video-engine-runtime'
import { runFfmpegProcess } from './ffmpeg-process'
import { getNativeFilePath } from './native-fs'

export type VideoPlaybackVariant = 'source' | 'matroska-remux'

interface SourceIdentity {
  fingerprint: string
  size: number
  mtimeMs: number
}

interface RemuxSidecar extends SourceIdentity {
  outputSize: number
  createdAt: number
}

interface SourceState {
  generation: number
  tail: Promise<void>
  ensure: Promise<string> | null
  controller: AbortController | null
}

const REMUX_TIMEOUT_MS = 30 * 60 * 1000
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000
const states = new Map<string, SourceState>()
const playbackSources = new Map<string, number>()

export function lockVideoPlaybackSource(sourceFileId: string): () => void {
  playbackSources.set(sourceFileId, (playbackSources.get(sourceFileId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (playbackSources.get(sourceFileId) ?? 1) - 1
    if (count > 0) playbackSources.set(sourceFileId, count)
    else playbackSources.delete(sourceFileId)
  }
}

async function listCacheArtifacts(): Promise<
  { name: string; sourceId: string; temporary: boolean }[]
> {
  let names: string[]
  try {
    names = await fs.readdir(cacheDir())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.flatMap((name) => {
    const temporary = name.startsWith('.') && name.endsWith('.tmp.mkv')
    const sourceId = temporary ? name.slice(1).split('.')[0] : name.replace(/\.(mkv|json)$/, '')
    return isValidNativeFileId(sourceId) && (temporary || /\.(mkv|json)$/.test(name))
      ? [{ name, sourceId, temporary }]
      : []
  })
}

export async function getVideoCacheUsage(): Promise<VideoCacheUsage> {
  const usage: VideoCacheUsage = { cacheBytes: 0, temporaryBytes: 0 }
  for (const artifact of await listCacheArtifacts()) {
    try {
      const stat = await fs.lstat(join(cacheDir(), artifact.name))
      if (stat.isFile()) usage[artifact.temporary ? 'temporaryBytes' : 'cacheBytes'] += stat.size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return usage
}

export async function clearVideoCache(): Promise<void> {
  const sourceIds = new Set((await listCacheArtifacts()).map((artifact) => artifact.sourceId))
  for (const sourceId of sourceIds) {
    const state = stateFor(sourceId)
    if (playbackSources.has(sourceId) || state.ensure || state.controller) continue
    await serialize(state, async () => {
      if (playbackSources.has(sourceId) || state.ensure || state.controller) return
      await removeCacheArtifacts(sourceId)
    })
  }
}

function cacheDir(): string {
  return resolve(app.getPath('userData'), 'video-remux-cache')
}

function paths(sourceFileId: string): { output: string; sidecar: string } {
  const dir = cacheDir()
  return {
    output: join(dir, `${sourceFileId}.mkv`),
    sidecar: join(dir, `${sourceFileId}.json`)
  }
}

function stateFor(sourceFileId: string): SourceState {
  let state = states.get(sourceFileId)
  if (!state) {
    state = { generation: 0, tail: Promise.resolve(), ensure: null, controller: null }
    states.set(sourceFileId, state)
  }
  return state
}

function serialize<T>(state: SourceState, operation: () => Promise<T>): Promise<T> {
  const task = state.tail.then(operation)
  state.tail = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

async function fingerprint(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function sourceIdentity(sourceFileId: string): Promise<SourceIdentity> {
  const sourcePath = getNativeFilePath(sourceFileId)
  const stat = await fs.stat(sourcePath)
  if (!stat.isFile()) throw new Error('source-replaced')
  return {
    fingerprint: await fingerprint(sourcePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs
  }
}

async function readReusableCache(
  sourceFileId: string,
  identity: SourceIdentity
): Promise<string | null> {
  const { output, sidecar } = paths(sourceFileId)
  try {
    const [outputStat, raw] = await Promise.all([fs.stat(output), fs.readFile(sidecar, 'utf8')])
    const metadata = JSON.parse(raw) as RemuxSidecar
    return outputStat.isFile() &&
      outputStat.size > 0 &&
      metadata.fingerprint === identity.fingerprint &&
      metadata.size === identity.size &&
      metadata.mtimeMs === identity.mtimeMs &&
      metadata.outputSize === outputStat.size
      ? output
      : null
  } catch {
    return null
  }
}

async function removeCacheArtifacts(sourceFileId: string): Promise<void> {
  const { output, sidecar } = paths(sourceFileId)
  await Promise.all([fs.rm(output, { force: true }), fs.rm(sidecar, { force: true })])
  let names: string[] = []
  try {
    names = await fs.readdir(cacheDir())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(`.${sourceFileId}.`) && name.endsWith('.tmp.mkv'))
      .map((name) => fs.rm(join(cacheDir(), name), { force: true }))
  )
}

async function ensureRemux(
  sourceFileId: string,
  state: SourceState,
  onPhase?: (phase: 'inspection' | 'remux') => void
): Promise<string> {
  onPhase?.('inspection')
  const sourcePath = getNativeFilePath(sourceFileId)
  const identity = await sourceIdentity(sourceFileId)
  await fs.mkdir(cacheDir(), { recursive: true })
  const reusable = await readReusableCache(sourceFileId, identity)
  if (reusable) return reusable

  onPhase?.('remux')
  const requiredBytes = Math.ceil(identity.size * 1.2) + 256 * 1024 * 1024
  const storage = await fs.statfs(cacheDir())
  if (storage.bavail * storage.bsize < requiredBytes) throw new Error('insufficient-storage')

  const runtime = resolveFfmpegRuntime()
  if (runtime.status !== 'ready' || !runtime.path) throw new Error('runtime-missing')
  const generation = state.generation
  const controller = new AbortController()
  state.controller = controller
  const { output, sidecar } = paths(sourceFileId)
  const token = randomUUID()
  const temporaryOutput = join(cacheDir(), `.${sourceFileId}.${token}.tmp.mkv`)
  const deadline = Date.now() + REMUX_TIMEOUT_MS

  try {
    await runFfmpegProcess({
      executable: runtime.path,
      args: [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-i',
        sourcePath,
        '-map',
        '0',
        '-c',
        'copy',
        '-f',
        'matroska',
        temporaryOutput
      ],
      timeoutMs: REMUX_TIMEOUT_MS,
      signal: controller.signal
    })
    const outputStat = await fs.stat(temporaryOutput)
    if (!outputStat.isFile() || outputStat.size <= 0) throw new Error('matroska-remux-failed')
    try {
      await runFfmpegProcess({
        executable: runtime.path,
        args: [
          '-hide_banner',
          '-nostdin',
          '-v',
          'error',
          '-xerror',
          '-i',
          temporaryOutput,
          '-map',
          '0',
          '-c',
          'copy',
          '-f',
          'null',
          '-'
        ],
        timeoutMs: Math.max(1, deadline - Date.now()),
        signal: controller.signal
      })
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof Error && error.message.includes('timed out'))
      ) {
        throw error
      }
      throw new Error('matroska-remux-failed')
    }
    const currentIdentity = await sourceIdentity(sourceFileId)
    if (
      state.generation !== generation ||
      currentIdentity.fingerprint !== identity.fingerprint ||
      currentIdentity.size !== identity.size ||
      currentIdentity.mtimeMs !== identity.mtimeMs
    ) {
      throw new Error('source-replaced')
    }
    const metadata: RemuxSidecar = {
      ...identity,
      outputSize: outputStat.size,
      createdAt: Date.now()
    }
    await fs.rename(temporaryOutput, output)
    await fs.writeFile(sidecar, JSON.stringify(metadata), 'utf8')
    return output
  } catch (error) {
    await Promise.all([
      fs.rm(temporaryOutput, { force: true }),
      fs.rm(output, { force: true }),
      fs.rm(sidecar, { force: true })
    ])
    throw error
  } finally {
    if (state.controller === controller) state.controller = null
  }
}

export function resolveVideoPlaybackPath(
  sourceFileId: string,
  variant: VideoPlaybackVariant,
  onPhase?: (phase: 'inspection' | 'remux') => void
): Promise<string> {
  if (!isValidNativeFileId(sourceFileId)) return Promise.reject(new Error('Invalid native file id'))
  if (variant === 'source') return Promise.resolve(getNativeFilePath(sourceFileId))
  const state = stateFor(sourceFileId)
  if (state.ensure) {
    onPhase?.('remux')
    return state.ensure
  }
  const task = serialize(state, () => ensureRemux(sourceFileId, state, onPhase))
  state.ensure = task
  void task.then(
    () => {
      if (state.ensure === task) state.ensure = null
    },
    () => {
      if (state.ensure === task) state.ensure = null
    }
  )
  return task
}

export function mutateVideoSource<T>(sourceFileId: string, mutation: () => Promise<T>): Promise<T> {
  if (!isValidNativeFileId(sourceFileId)) return Promise.reject(new Error('Invalid native file id'))
  const state = stateFor(sourceFileId)
  state.generation += 1
  state.controller?.abort()
  state.ensure = null
  return serialize(state, async () => {
    await removeCacheArtifacts(sourceFileId)
    return mutation()
  })
}

export async function cleanupStaleVideoRemuxTemps(now = Date.now()): Promise<number> {
  let names: string[]
  try {
    names = await fs.readdir(cacheDir())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith('.') || !name.endsWith('.tmp.mkv')) continue
    const path = join(cacheDir(), name)
    const stat = await fs.stat(path)
    if (now - stat.mtimeMs <= TEMP_MAX_AGE_MS) continue
    await fs.rm(path, { force: true })
    removed += 1
  }
  return removed
}
