import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HhcSession } from '@shared/hhc-auth'
import type { FolderRecord } from '@shared/types/folder'
import type { CloudRefreshSummary, HhcLineCloudAuth } from '../cloud-provider'
import type { ProviderConnectionRecord } from '../sync-db'
import { useSettingsStore } from '@renderer/stores/settings'
import type { MeetingWindowsApi } from '../meeting-windows-api'

vi.mock('../env', () => ({
  isElectron: vi.fn(() => false)
}))

vi.mock('../local-sync-import', () => ({
  refreshLocalSyncConnection: vi.fn()
}))

const { refreshAllOneDriveFoldersMock } = vi.hoisted(() => ({
  refreshAllOneDriveFoldersMock: vi.fn<
    () => Promise<import('../onedrive-connect').OneDriveRefreshSummary[]>
  >(async () => [])
}))

const hhcMocks = vi.hoisted(() => ({
  connections: [] as ProviderConnectionRecord[],
  folders: {} as Record<string, FolderRecord>,
  refreshFolder: vi.fn(),
  listConnections: vi.fn()
}))

vi.mock('../onedrive-connect', () => ({
  refreshAllOneDriveFolders: refreshAllOneDriveFoldersMock
}))

vi.mock('../sync-db', () => ({
  listProviderConnectionsByType: hhcMocks.listConnections
}))

vi.mock('@renderer/stores/file-explorer', () => ({
  useFileExplorerStore: {
    getState: () => ({ folders: hhcMocks.folders })
  }
}))

vi.mock('../cloud-provider', () => ({
  getCloudProviderAdapter: () => ({ refreshFolder: hhcMocks.refreshFolder })
}))

import { startSyncRuntime } from '../sync-runtime'
import { refreshAllOneDriveFolders } from '../onedrive-connect'

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function session(userId = 'user-1'): HhcSession {
  return { userId, displayName: userId, roles: ['media_sync_user'] }
}

function connection(id: string, accountUserId = 'user-1'): ProviderConnectionRecord {
  return {
    id,
    providerType: 'hhc-line',
    displayName: 'HHC LINE',
    accountUserId,
    createdAt: 1,
    updatedAt: 1
  }
}

function root(
  id: string,
  connectionId: string,
  status: 'active' | 'access-revoked' = 'active'
): FolderRecord {
  return {
    id,
    name: id,
    parentId: 'file-root',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    syncLink: {
      providerType: 'hhc-line',
      providerConnectionId: connectionId,
      remoteFolderId: id,
      offlinePolicy: 'online-only',
      status
    }
  }
}

function auth(sessionRef: { current: HhcSession | null }): HhcLineCloudAuth {
  return {
    getSession: () => sessionRef.current,
    getAccessToken: vi.fn(async () => 'token'),
    refreshAfterUnauthorized: vi.fn(async () => 'refreshed'),
    endSession: vi.fn(async () => undefined)
  }
}

function idleSummary(connectionId: string, rootFolderId: string): CloudRefreshSummary {
  return {
    connectionId,
    rootFolderId,
    updatedItemCount: 0,
    removedItemCount: 0,
    removedFolderCount: 0,
    downloadedCount: 0,
    failedFileCount: 0,
    disabledFileCount: 0,
    changedCount: 0,
    pendingFileCount: 0,
    retryableFileCount: 0,
    usedCursor: true,
    fullScanFallback: false
  }
}

function windows(values: { startsAt: string; endsAt: string }[] = []): MeetingWindowsApi {
  return { list: vi.fn(async () => values) }
}

describe('startSyncRuntime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useSettingsStore.setState({ defaultSyncOfflinePolicy: 'on-demand' })
    refreshAllOneDriveFoldersMock.mockReset()
    refreshAllOneDriveFoldersMock.mockResolvedValue([])
    hhcMocks.connections = []
    hhcMocks.folders = {}
    hhcMocks.refreshFolder.mockReset()
    hhcMocks.refreshFolder.mockImplementation(async (rootFolderId: string) =>
      idleSummary('hhc-line:user-1', rootFolderId)
    )
    hhcMocks.listConnections.mockReset()
    hhcMocks.listConnections.mockImplementation(async () => hhcMocks.connections)
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps OneDrive refresh active in Web mode without local sync', async () => {
    const stop = startSyncRuntime()
    await vi.runOnlyPendingTimersAsync()

    expect(refreshAllOneDriveFolders).toHaveBeenCalled()

    stop()
  })

  it('uses the 60 second idle delay when OneDrive has no work', async () => {
    const stop = startSyncRuntime()

    await flushMicrotasks()
    expect(refreshAllOneDriveFolders).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000 - 1)
    expect(refreshAllOneDriveFolders).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(refreshAllOneDriveFolders).toHaveBeenCalledTimes(2)

    stop()
  })

  it('polls only HHC every two seconds inside a meeting window and exits to cold cadence', async () => {
    const sessionRef = { current: session() }
    const targetConnection = connection('hhc-runtime-meeting')
    const target = root('root-meeting', targetConnection.id)
    hhcMocks.connections = [targetConnection]
    hhcMocks.folders = { [target.id]: target }
    const meetingWindows = windows([
      {
        startsAt: new Date(Date.now() - 1_000).toISOString(),
        endsAt: new Date(Date.now() + 4_500).toISOString()
      }
    ])

    const stop = startSyncRuntime({ hhcAuth: auth(sessionRef), meetingWindows })
    await flushMicrotasks()
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(1)
    expect(refreshAllOneDriveFolders).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4_000)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(3)
    expect(refreshAllOneDriveFolders).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(5)
    stop()
  })

  it('falls back to cold HHC cadence when meeting window lookup fails', async () => {
    const sessionRef = { current: session() }
    const targetConnection = connection('hhc-runtime-window-failure')
    const target = root('root-window-failure', targetConnection.id)
    hhcMocks.connections = [targetConnection]
    hhcMocks.folders = { [target.id]: target }
    const meetingWindows: MeetingWindowsApi = { list: vi.fn(async () => []) }

    const stop = startSyncRuntime({ hhcAuth: auth(sessionRef), meetingWindows })
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(2)
    stop()
  })

  it('continues ordinary refresh while meeting discovery never resolves', async () => {
    const targetConnection = connection('hhc-runtime-hanging')
    const target = root('root-hanging', targetConnection.id)
    hhcMocks.connections = [targetConnection]
    hhcMocks.folders = { [target.id]: target }
    const stop = startSyncRuntime({
      hhcAuth: auth({ current: session() }),
      meetingWindows: { list: () => new Promise(() => {}) }
    })
    try {
      await vi.advanceTimersByTimeAsync(60_000)
      expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(2)
    } finally {
      stop()
    }
  })

  it('wakes at a known meeting start instead of waiting for the idle interval', async () => {
    const targetConnection = connection('hhc-runtime-boundary')
    const target = root('root-boundary', targetConnection.id)
    hhcMocks.connections = [targetConnection]
    hhcMocks.folders = { [target.id]: target }
    const stop = startSyncRuntime({
      hhcAuth: auth({ current: session() }),
      meetingWindows: windows([
        {
          startsAt: new Date(Date.now() + 10_000).toISOString(),
          endsAt: new Date(Date.now() + 90_000).toISOString()
        }
      ])
    })
    try {
      await vi.advanceTimersByTimeAsync(9_999)
      expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(2)
    } finally {
      stop()
    }
  })

  it('discovers schedule edits during idle polling without overlapping collection refreshes', async () => {
    const targetConnection = connection('hhc-runtime-edited')
    const target = root('root-edited', targetConnection.id)
    hhcMocks.connections = [targetConnection]
    hhcMocks.folders = { [target.id]: target }
    const meetingWindows = windows()
    const stop = startSyncRuntime({ hhcAuth: auth({ current: session() }), meetingWindows })
    try {
      await vi.advanceTimersByTimeAsync(1_000)
      vi.mocked(meetingWindows.list).mockResolvedValue([
        {
          startsAt: new Date(Date.now() - 1).toISOString(),
          endsAt: new Date(Date.now() + 90_000).toISOString()
        }
      ])
      await vi.advanceTimersByTimeAsync(16_000)
      expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(2)
    } finally {
      stop()
    }
  })

  it('ignores a late meeting response after runtime stop', async () => {
    let resolve!: (value: { startsAt: string; endsAt: string }[]) => void
    const meetingWindows: MeetingWindowsApi = {
      list: () =>
        new Promise((done) => {
          resolve = done
        })
    }
    const stop = startSyncRuntime({ meetingWindows })
    await vi.advanceTimersByTimeAsync(0)
    stop()
    resolve([
      {
        startsAt: new Date(Date.now() - 1).toISOString(),
        endsAt: new Date(Date.now() + 90_000).toISOString()
      }
    ])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('wakes HHC on network recovery and removes the listener on stop', async () => {
    const targetConnection = connection('hhc-runtime-online')
    const target = root('root-online', targetConnection.id)
    hhcMocks.connections = [targetConnection]
    hhcMocks.folders = { [target.id]: target }
    const stop = startSyncRuntime({
      hhcAuth: auth({ current: session() }),
      meetingWindows: windows()
    })
    await vi.advanceTimersByTimeAsync(1_000)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(2)
    stop()
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(2)
  })

  it('refreshes after sign-in without waiting for the idle collection interval', async () => {
    const targetConnection = connection('hhc-runtime-signin')
    const target = root('root-signin', targetConnection.id)
    hhcMocks.connections = [targetConnection]
    hhcMocks.folders = { [target.id]: target }
    const sessionRef: { current: HhcSession | null } = { current: null }
    let generation = 0
    const stop = startSyncRuntime({
      hhcAuth: auth(sessionRef),
      meetingWindows: windows(),
      getHhcAuthGeneration: () => generation
    })
    try {
      await vi.advanceTimersByTimeAsync(1_000)
      sessionRef.current = session()
      generation++
      await vi.advanceTimersByTimeAsync(15_000)
      expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it('switches to the active delay when refresh reports pending work', async () => {
    refreshAllOneDriveFoldersMock
      .mockResolvedValueOnce([
        {
          connectionId: 'connection-1',
          rootFolderId: 'root-1',
          updatedItemCount: 1,
          removedItemCount: 0,
          removedFolderCount: 0,
          downloadedCount: 0,
          failedFileCount: 0,
          disabledFileCount: 0,
          changedCount: 1,
          pendingFileCount: 1,
          retryableFileCount: 0,
          usedCursor: true,
          fullScanFallback: false
        }
      ])
      .mockResolvedValue([])

    const stop = startSyncRuntime()

    await flushMicrotasks()
    expect(refreshAllOneDriveFolders).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(15_000 - 1)
    expect(refreshAllOneDriveFolders).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(refreshAllOneDriveFolders).toHaveBeenCalledTimes(2)

    stop()
  })

  it('refreshes existing cloud roots immediately when the offline policy changes', async () => {
    const sessionRef = { current: session() }
    const targetConnection = connection('hhc-runtime-policy')
    const target = root('root-policy', targetConnection.id)
    hhcMocks.connections = [targetConnection]
    hhcMocks.folders = { [target.id]: target }

    const stop = startSyncRuntime({ hhcAuth: auth(sessionRef) })
    await flushMicrotasks()
    expect(refreshAllOneDriveFolders).toHaveBeenCalledTimes(1)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(1)

    useSettingsStore.getState().setDefaultSyncOfflinePolicy('always-offline')
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshAllOneDriveFolders).toHaveBeenCalledTimes(2)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(2)

    useSettingsStore.getState().setDefaultSyncOfflinePolicy('always-offline')
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshAllOneDriveFolders).toHaveBeenCalledTimes(2)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(2)

    stop()
  })

  it('coalesces policy changes during a cloud refresh into one follow-up', async () => {
    let resolveRefresh!: () => void
    refreshAllOneDriveFoldersMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = () => resolve([])
          })
      )
      .mockResolvedValue([])

    const stop = startSyncRuntime()
    await vi.waitFor(() => expect(refreshAllOneDriveFolders).toHaveBeenCalledTimes(1))

    useSettingsStore.getState().setDefaultSyncOfflinePolicy('always-offline')
    useSettingsStore.getState().setDefaultSyncOfflinePolicy('online-only')
    useSettingsStore.getState().setDefaultSyncOfflinePolicy('always-offline')
    resolveRefresh()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(0)

    expect(refreshAllOneDriveFolders).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshAllOneDriveFolders).toHaveBeenCalledTimes(2)

    stop()
  })

  it('unsubscribes from offline policy changes when disposed', () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.spyOn(useSettingsStore, 'subscribe').mockReturnValue(unsubscribe)

    const stop = startSyncRuntime()
    stop()

    expect(subscribe).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    subscribe.mockRestore()
  })

  it.each([
    ['signed out', null, [connection('hhc-runtime-signed-out')]],
    ['without a connection', session(), []]
  ])('does no HHC work when %s', async (_name, currentSession, connections) => {
    const sessionRef = { current: currentSession }
    hhcMocks.connections = connections
    const target = root('root-no-work', connections[0]?.id ?? 'missing')
    hhcMocks.folders = { [target.id]: target }

    const stop = startSyncRuntime({ hhcAuth: auth(sessionRef) })
    await flushMicrotasks()

    expect(hhcMocks.refreshFolder).not.toHaveBeenCalled()
    stop()
  })

  it('runs roots serially per connection while independent connections proceed', async () => {
    const sessionRef = { current: session() }
    const firstConnection = connection('hhc-runtime-serial-1')
    const secondConnection = connection('hhc-runtime-serial-2')
    hhcMocks.connections = [firstConnection, secondConnection]
    const first = root('root-serial-1', firstConnection.id)
    const second = root('root-serial-2', firstConnection.id)
    const independent = root('root-independent', secondConnection.id)
    hhcMocks.folders = {
      [first.id]: first,
      [second.id]: second,
      [independent.id]: independent
    }
    let resolveFirst!: () => void
    hhcMocks.refreshFolder.mockImplementation(async (rootFolderId: string) => {
      if (rootFolderId === first.id) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve
        })
      }
      return idleSummary(
        rootFolderId === independent.id ? secondConnection.id : firstConnection.id,
        rootFolderId
      )
    })

    const stop = startSyncRuntime({ hhcAuth: auth(sessionRef) })
    await vi.waitFor(() => {
      expect(hhcMocks.refreshFolder).toHaveBeenCalledWith(first.id)
      expect(hhcMocks.refreshFolder).toHaveBeenCalledWith(independent.id)
    })
    expect(hhcMocks.refreshFolder).not.toHaveBeenCalledWith(second.id)

    resolveFirst()
    await vi.waitFor(() => expect(hhcMocks.refreshFolder).toHaveBeenCalledWith(second.id))
    stop()
  })

  it.each([
    ['retryable', { classification: 'retryable' }],
    ['offline', new TypeError('offline')]
  ])(
    'backs off and recovers from an HHC %s failure without removing the root',
    async (_name, error) => {
      const sessionRef = { current: session() }
      const targetConnection = connection(`hhc-runtime-${_name}`)
      const target = root(`root-${_name}`, targetConnection.id)
      hhcMocks.connections = [targetConnection]
      hhcMocks.folders = { [target.id]: target }
      hhcMocks.refreshFolder
        .mockRejectedValueOnce(error)
        .mockResolvedValue(idleSummary(targetConnection.id, target.id))

      const stop = startSyncRuntime({ hhcAuth: auth(sessionRef) })
      await flushMicrotasks()
      expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(1)
      expect(hhcMocks.folders[target.id]).toBe(target)

      await vi.advanceTimersByTimeAsync(15_000)
      expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(3)
      stop()
    }
  )

  it('keeps auth-required blocked across same-user updates until an explicit re-login', async () => {
    const firstSession = session()
    const sessionRef: { current: HhcSession | null } = { current: firstSession }
    const authGeneration = { current: 0 }
    const targetConnection = connection('hhc-runtime-auth')
    const target = root('root-auth', targetConnection.id)
    hhcMocks.connections = [targetConnection]
    hhcMocks.folders = { [target.id]: target }
    hhcMocks.refreshFolder
      .mockRejectedValueOnce({ classification: 'auth-required' })
      .mockResolvedValue(idleSummary(targetConnection.id, target.id))
    const hhcAuth = auth(sessionRef)

    const stop = startSyncRuntime({
      hhcAuth,
      getHhcAuthGeneration: () => authGeneration.current
    })
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(1)
    expect(hhcAuth.refreshAfterUnauthorized).not.toHaveBeenCalled()

    sessionRef.current = { ...firstSession, roles: ['media_sync_user', 'reader'] }
    await vi.advanceTimersByTimeAsync(120_000)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(1)

    sessionRef.current = null
    authGeneration.current += 1
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(1)

    sessionRef.current = { ...firstSession }
    authGeneration.current += 1
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(2)
    stop()
  })

  it.each(['same-user re-login', 'account switch round trip'])(
    'does not let a stale auth-required result block a %s',
    async (transition) => {
      const firstSession = session()
      const sessionRef: { current: HhcSession | null } = { current: firstSession }
      const authGeneration = { current: 0 }
      const targetConnection = connection(`hhc-runtime-stale-auth-${transition}`)
      const target = root(`root-stale-auth-${transition}`, targetConnection.id)
      hhcMocks.connections = [targetConnection]
      hhcMocks.folders = { [target.id]: target }
      let rejectRefresh!: (error: unknown) => void
      hhcMocks.refreshFolder
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              rejectRefresh = reject
            })
        )
        .mockResolvedValue(idleSummary(targetConnection.id, target.id))

      const stop = startSyncRuntime({
        hhcAuth: auth(sessionRef),
        getHhcAuthGeneration: () => authGeneration.current
      })
      await vi.waitFor(() => expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(1))

      sessionRef.current = transition === 'same-user re-login' ? null : session('user-2')
      authGeneration.current = 1
      sessionRef.current = { ...firstSession }
      authGeneration.current = 2
      rejectRefresh({ classification: 'auth-required' })
      await flushMicrotasks()

      await vi.advanceTimersByTimeAsync(60_000)
      expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(2)
      stop()
    }
  )

  it.each([403, 404] as const)(
    'triggers access-revoked once and continues an independent sibling root after %s',
    async (status) => {
      const sessionRef = { current: session() }
      const targetConnection = connection('hhc-runtime-revoked')
      const revoked = root('root-revoked', targetConnection.id)
      const sibling = root('root-revoked-sibling', targetConnection.id)
      hhcMocks.connections = [targetConnection]
      hhcMocks.folders = { [revoked.id]: revoked, [sibling.id]: sibling }
      hhcMocks.refreshFolder.mockImplementation(async (rootFolderId: string) => {
        if (rootFolderId === revoked.id) throw { classification: 'access-revoked', status }
        return idleSummary(targetConnection.id, rootFolderId)
      })
      const onHhcAccessRevoked = vi.fn(async () => {
        delete hhcMocks.folders[revoked.id]
      })

      const stop = startSyncRuntime({ hhcAuth: auth(sessionRef), onHhcAccessRevoked })
      await vi.waitFor(() => expect(hhcMocks.refreshFolder).toHaveBeenCalledWith(sibling.id))
      expect(onHhcAccessRevoked).toHaveBeenCalledTimes(1)
      expect(onHhcAccessRevoked).toHaveBeenCalledWith({
        connectionId: targetConnection.id,
        rootFolderId: revoked.id
      })

      await vi.advanceTimersByTimeAsync(60_000)
      expect(onHhcAccessRevoked).toHaveBeenCalledTimes(1)
      expect(hhcMocks.refreshFolder).toHaveBeenCalledWith(sibling.id)
      stop()
    }
  )

  it('does not purge a root for a forged access-revoked classification without HTTP 403', async () => {
    const sessionRef = { current: session() }
    const targetConnection = connection('hhc-runtime-forged-revoked')
    const target = root('root-forged-revoked', targetConnection.id)
    hhcMocks.connections = [targetConnection]
    hhcMocks.folders = { [target.id]: target }
    hhcMocks.refreshFolder.mockRejectedValueOnce({ classification: 'access-revoked' })
    const onHhcAccessRevoked = vi.fn()

    const stop = startSyncRuntime({ hhcAuth: auth(sessionRef), onHhcAccessRevoked })
    await vi.waitFor(() => expect(hhcMocks.refreshFolder).toHaveBeenCalledOnce())

    expect(onHhcAccessRevoked).not.toHaveBeenCalled()
    stop()
  })

  it('retries access-revoked cleanup after a callback rejection while siblings continue', async () => {
    const sessionRef = { current: session() }
    const targetConnection = connection('hhc-runtime-revoked-retry')
    const revoked = root('root-revoked-retry', targetConnection.id)
    const sibling = root('root-revoked-retry-sibling', targetConnection.id)
    hhcMocks.connections = [targetConnection]
    hhcMocks.folders = { [revoked.id]: revoked, [sibling.id]: sibling }
    hhcMocks.refreshFolder.mockImplementation(async (rootFolderId: string) => {
      if (rootFolderId === revoked.id) throw { classification: 'access-revoked', status: 403 }
      return idleSummary(targetConnection.id, rootFolderId)
    })
    const onHhcAccessRevoked = vi.fn().mockImplementationOnce(async () => {
      hhcMocks.folders[revoked.id] = root(revoked.id, targetConnection.id, 'access-revoked')
      throw new Error('cleanup unavailable')
    })
    onHhcAccessRevoked.mockImplementationOnce(async () => {
      delete hhcMocks.folders[revoked.id]
    })

    const stop = startSyncRuntime({ hhcAuth: auth(sessionRef), onHhcAccessRevoked })
    await vi.waitFor(() => {
      expect(onHhcAccessRevoked).toHaveBeenCalledTimes(1)
      expect(hhcMocks.refreshFolder).toHaveBeenCalledWith(sibling.id)
    })

    await vi.advanceTimersByTimeAsync(15_000)
    expect(onHhcAccessRevoked).toHaveBeenCalledTimes(2)
    expect(
      hhcMocks.refreshFolder.mock.calls.filter(([rootFolderId]) => rootFolderId === revoked.id)
    ).toHaveLength(1)
    expect(hhcMocks.refreshFolder).toHaveBeenCalledWith(sibling.id)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(onHhcAccessRevoked).toHaveBeenCalledTimes(2)
    stop()
  })

  it('discovers persisted revoked roots and retries cleanup without another Asset request', async () => {
    const sessionRef = { current: session() }
    const targetConnection = connection('hhc-runtime-persisted-revoked')
    const revoked = root('root-persisted-revoked', targetConnection.id, 'access-revoked')
    const sibling = root('root-persisted-revoked-sibling', targetConnection.id)
    hhcMocks.connections = [targetConnection]
    hhcMocks.folders = { [revoked.id]: revoked, [sibling.id]: sibling }
    const onHhcAccessRevoked = vi
      .fn()
      .mockRejectedValueOnce(new Error('unlink unavailable'))
      .mockImplementationOnce(async () => {
        delete hhcMocks.folders[revoked.id]
      })

    const stop = startSyncRuntime({ hhcAuth: auth(sessionRef), onHhcAccessRevoked })
    await vi.waitFor(() => {
      expect(onHhcAccessRevoked).toHaveBeenCalledOnce()
      expect(hhcMocks.refreshFolder).toHaveBeenCalledWith(sibling.id)
    })
    expect(hhcMocks.refreshFolder).not.toHaveBeenCalledWith(revoked.id)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(onHhcAccessRevoked).toHaveBeenCalledTimes(2)
    expect(hhcMocks.refreshFolder).not.toHaveBeenCalledWith(revoked.id)
    stop()
  })

  it('does not schedule new work when disposed while HHC refresh is resolving', async () => {
    const sessionRef = { current: session() }
    const targetConnection = connection('hhc-runtime-dispose')
    const target = root('root-dispose', targetConnection.id)
    hhcMocks.connections = [targetConnection]
    hhcMocks.folders = { [target.id]: target }
    let resolveRefresh!: () => void
    hhcMocks.refreshFolder.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => resolve(idleSummary(targetConnection.id, target.id))
        })
    )

    const stop = startSyncRuntime({ hhcAuth: auth(sessionRef) })
    await vi.waitFor(() => expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(1))
    stop()
    resolveRefresh()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(hhcMocks.refreshFolder).toHaveBeenCalledTimes(1)
  })
})
