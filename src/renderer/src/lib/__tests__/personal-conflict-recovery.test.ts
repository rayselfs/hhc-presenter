import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolvePersonalCloudConflict } from '../personal-conflict-recovery'
import type { PersonalConflictScope } from '../personal-sync-conflicts'
import type { PresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  accept: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  renew: vi.fn(),
  copy: vi.fn(),
  refresh: vi.fn(),
  request: vi.fn()
}))
vi.mock('../personal-sync-conflicts', () => ({
  getPersonalConflictScope: mocks.scope,
  acceptPersonalCloudVersion: mocks.accept
}))
vi.mock('../personal-sync-db', () => ({
  acquirePersonalSyncLease: mocks.acquire,
  releasePersonalSyncLease: mocks.release,
  renewPersonalSyncLease: mocks.renew
}))
vi.mock('../personal-sync-runtime', () => ({ requestPersonalSync: mocks.request }))
vi.mock('@renderer/stores/file-explorer', () => ({
  FILE_EXPLORER_ROOT_ID: 'file-root',
  copyExplorerFolder: vi.fn(),
  refreshPersonalCatalog: mocks.refresh,
  useFileExplorerStore: { getState: () => ({ folders: {}, copyItem: mocks.copy }) }
}))

const scope: PersonalConflictScope = {
  operationId: 'operation',
  rootIds: ['file'],
  nodes: [
    {
      id: 'file',
      ownerId: 'alice',
      remoteId: 'remote',
      kind: 'file',
      localRevision: 2,
      syncedLocalRevision: 1,
      remoteRevision: 1
    }
  ]
}
const sessions: Pick<
  PresentationSessionRegistry,
  'finalizeAndFlush' | 'hasPendingEditorWork' | 'get' | 'close'
> = {
  finalizeAndFlush: vi.fn(),
  hasPendingEditorWork: vi.fn(),
  get: vi.fn(),
  close: vi.fn()
}
const confirm = vi.fn()
const options = {
  ownerId: 'alice',
  backup: true,
  sessions,
  confirm,
  errors: { busy: 'Busy', backupFailed: 'Backup failed', changed: 'Changed' }
}

beforeEach(() => {
  vi.resetAllMocks()
  usePersonalSyncStore.setState({ activeOwnerId: 'alice' })
  mocks.scope.mockResolvedValue(scope)
  mocks.acquire.mockResolvedValue(true)
  mocks.release.mockResolvedValue(undefined)
  mocks.renew.mockResolvedValue(true)
  mocks.copy.mockResolvedValue('backup')
  mocks.refresh.mockResolvedValue(undefined)
  mocks.accept.mockResolvedValue(undefined)
  vi.mocked(sessions.hasPendingEditorWork!).mockReturnValue(false)
  vi.mocked(sessions.get).mockReturnValue(undefined)
  confirm.mockResolvedValue(true)
})
afterEach(() => vi.restoreAllMocks())

it('flushes and reviews before backing up, accepts before closing, and always releases the lease', async () => {
  const order: string[] = []
  vi.mocked(sessions.finalizeAndFlush).mockImplementation(async () => {
    order.push('flush')
    return null
  })
  confirm.mockImplementation(async (count) => {
    expect(count).toBe(1)
    order.push('confirm')
    return true
  })
  mocks.copy.mockImplementation(async () => {
    order.push('backup')
    return 'backup'
  })
  mocks.accept.mockImplementation(async () => {
    order.push('accept')
  })
  vi.mocked(sessions.close).mockImplementation(async () => {
    order.push('close')
    return true
  })
  await resolvePersonalCloudConflict(options)
  expect(order).toEqual(['flush', 'confirm', 'backup', 'accept', 'close'])
  expect(mocks.scope).toHaveBeenCalledTimes(2)
  expect(mocks.accept.mock.calls[0][2]).toBe(scope)
  expect(mocks.request).toHaveBeenCalledWith('alice')
  expect(mocks.release).toHaveBeenCalledOnce()
})

it('does not accept or close when backup fails', async () => {
  mocks.copy.mockResolvedValue(null)
  await expect(resolvePersonalCloudConflict(options)).rejects.toThrow('Backup failed')
  expect(mocks.accept).not.toHaveBeenCalled()
  expect(sessions.close).not.toHaveBeenCalled()
  expect(mocks.release).toHaveBeenCalledOnce()
})

it('does not accept when editor work becomes pending after backup', async () => {
  mocks.copy.mockImplementation(async () => {
    vi.mocked(sessions.hasPendingEditorWork!).mockReturnValue(true)
    return 'backup'
  })
  await expect(resolvePersonalCloudConflict(options)).rejects.toThrow('Changed')
  expect(mocks.accept).not.toHaveBeenCalled()
  expect(sessions.close).not.toHaveBeenCalled()
  expect(mocks.release).toHaveBeenCalledOnce()
})

it('silently cancels an account switch during confirmation before acquiring a lease', async () => {
  confirm.mockImplementation(async () => {
    usePersonalSyncStore.setState({ activeOwnerId: 'bob' })
    return true
  })
  await resolvePersonalCloudConflict(options)
  expect(mocks.acquire).not.toHaveBeenCalled()
  expect(mocks.accept).not.toHaveBeenCalled()
  expect(mocks.release).toHaveBeenCalledOnce()
})

it('retains the separate keep-cloud action without creating a backup', async () => {
  await resolvePersonalCloudConflict({ ...options, backup: false })
  expect(mocks.copy).not.toHaveBeenCalled()
  expect(mocks.accept).toHaveBeenCalledOnce()
  expect(sessions.close).toHaveBeenCalledWith('file', 'discard')
})
