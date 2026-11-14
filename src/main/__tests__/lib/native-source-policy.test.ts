import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }))
import {
  persistNativeSourceDeadline,
  persistNativeSourceControl,
  readNativeSourceDeadline
} from '../../lib/native-source-policy'
const id = '123e4567-e89b-12d3-a456-426614174000'
beforeEach(async () => {
  state.directory = await mkdtemp(join(tmpdir(), 'hhc-source-policy-'))
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(state.directory, { recursive: true, force: true })
})
it('retains immutable deadline across reads and denies it offline after expiry', async () => {
  vi.useFakeTimers()
  const deadline = Date.now() + 1000
  await persistNativeSourceDeadline(id, deadline)
  await expect(readNativeSourceDeadline(id)).resolves.toBe(deadline)
  await expect(persistNativeSourceDeadline(id, deadline + 1000)).rejects.toThrow('Immutable')
  await vi.advanceTimersByTimeAsync(1000)
  await expect(readNativeSourceDeadline(id)).rejects.toThrow('item-expired')
})
it('leaves legacy files alone and fails closed on malformed persisted policy', async () => {
  await expect(readNativeSourceDeadline(id)).resolves.toBeUndefined()
  await mkdir(join(state.directory, 'hhc-source-policies'))
  await writeFile(join(state.directory, 'hhc-source-policies', `${id}.json`), '{}')
  await expect(readNativeSourceDeadline(id)).rejects.toThrow('Invalid native source policy')
})

it('retains paused bytes but denies reads until an authoritative newer active control', async () => {
  const control = {
    version: 1 as const,
    collectionId: 'c',
    state: 'paused' as const,
    policyRevision: 2,
    aclRevision: 1,
    bindingGeneration: 1
  }
  const deadline = Date.now() + 60000
  await persistNativeSourceDeadline(id, deadline, 'c')
  await persistNativeSourceControl(control)
  await expect(readNativeSourceDeadline(id)).rejects.toThrow('collection-paused')
  await expect(
    persistNativeSourceControl({ ...control, state: 'active', policyRevision: 1 })
  ).rejects.toThrow('dependency-unavailable')
  await persistNativeSourceControl({ ...control, state: 'active', policyRevision: 3 })
  await expect(readNativeSourceDeadline(id)).resolves.toBe(deadline)
})
