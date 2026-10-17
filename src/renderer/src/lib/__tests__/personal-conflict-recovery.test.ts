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
  copyExplorerFile: mocks.copy,
  copyExplorerFolder: vi.fn(),
  refreshPersonalCatalog: mocks.refresh,
  useFileExplorerStore: { getState: () => ({ folders: {} }) }
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
  'finalizeAndFlush' | 'hasPendingEditorWork' | 'get' | 'close' | 'subscribe'
> = {
  finalizeAndFlush: vi.fn(),
  hasPendingEditorWork: vi.fn(),
  get: vi.fn(),
  close: vi.fn(),
  subscribe: vi.fn()
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
  usePersonalSyncStore.setState({ activeOwnerId: 'alice', accountStatus: 'authenticated' })
  mocks.scope.mockResolvedValue(scope)
  mocks.acquire.mockResolvedValue(true)
  mocks.release.mockResolvedValue(undefined)
  mocks.renew.mockResolvedValue(true)
  mocks.copy.mockResolvedValue('backup')
  mocks.refresh.mockResolvedValue(undefined)
  mocks.accept.mockResolvedValue(undefined)
  vi.mocked(sessions.hasPendingEditorWork!).mockReturnValue(false)
  vi.mocked(sessions.get).mockReturnValue(undefined)
  vi.mocked(sessions.close).mockResolvedValue(true)
  vi.mocked(sessions.subscribe).mockReturnValue(vi.fn())
  confirm.mockResolvedValue(true)
})
afterEach(() => vi.restoreAllMocks())

it('flushes and reviews before backing up, closes safely before accepting, and always releases the lease', async () => {
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
  expect(order).toEqual(['flush', 'confirm', 'backup', 'close', 'accept'])
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
  expect(sessions.close).toHaveBeenCalledWith('file')
})

it.each(['wrong-owner', 'unavailable'] as const)(
  'rejects an invalid initial account: %s',
  async (reason) => {
    usePersonalSyncStore.setState(
      reason === 'wrong-owner' ? { activeOwnerId: 'bob' } : { accountStatus: 'unavailable' }
    )
    await resolvePersonalCloudConflict(options)
    expect(mocks.scope).not.toHaveBeenCalled()
    expect(mocks.copy).not.toHaveBeenCalled()
    expect(mocks.accept).not.toHaveBeenCalled()
  }
)

it('does not commit after the same account becomes unavailable during confirmation', async () => {
  confirm.mockImplementation(async () => {
    usePersonalSyncStore.setState({ accountStatus: 'unavailable' })
    return true
  })
  await resolvePersonalCloudConflict(options)
  expect(mocks.acquire).not.toHaveBeenCalled()
  expect(mocks.accept).not.toHaveBeenCalled()
})

it('retains the reviewed data when a normal editor close is refused', async () => {
  vi.mocked(sessions.close).mockResolvedValue(false)
  await expect(resolvePersonalCloudConflict(options)).rejects.toThrow('Changed')
  expect(mocks.accept).not.toHaveBeenCalled()
  expect(mocks.refresh).not.toHaveBeenCalled()
  expect(mocks.release).toHaveBeenCalledOnce()
})

it('aborts the pending accept transaction when reopened editor work changes', async () => {
  let changed!: () => void
  const unsubscribe = vi.fn()
  vi.mocked(sessions.subscribe).mockImplementation((listener) => {
    changed = listener
    return unsubscribe
  })
  mocks.accept.mockImplementation(async (_owner, _worker, _scope, signal: AbortSignal) => {
    vi.mocked(sessions.hasPendingEditorWork!).mockReturnValue(true)
    changed()
    expect(signal.aborted).toBe(true)
    signal.throwIfAborted()
  })
  await resolvePersonalCloudConflict(options)
  expect(sessions.close).toHaveBeenCalledWith('file')
  expect(mocks.request).not.toHaveBeenCalled()
  expect(mocks.refresh).not.toHaveBeenCalled()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(mocks.release).toHaveBeenCalledOnce()
})

it('aborts when lease renewal fails during a pending backup', async () => {
  vi.useFakeTimers()
  let finishBackup!: (id: string) => void
  mocks.copy.mockReturnValue(
    new Promise<string>((resolve) => {
      finishBackup = resolve
    })
  )
  mocks.renew.mockResolvedValue(false)
  try {
    const pending = resolvePersonalCloudConflict(options)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.renew).toHaveBeenCalledOnce()
    finishBackup('backup')
    await pending
    expect(mocks.accept).not.toHaveBeenCalled()
    expect(sessions.close).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})
