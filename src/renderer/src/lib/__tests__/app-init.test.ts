import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockToastSuccess = vi.fn()
const mockToastWarning = vi.fn()
const mockRetry = vi.fn()
const mockInitialize = vi.fn()
const mockFolderInitialize = vi.fn()
const mockFolderCleanupExpired = vi.fn().mockResolvedValue(undefined)
const mockFileExplorerInitialize = vi.fn().mockResolvedValue(undefined)
const mockFileExplorerCleanupExpired = vi.fn().mockResolvedValue(undefined)
const mockInitializeSearchIndexes = vi.fn()
const mockUnsubscribeBible = vi.fn()
const mockUnsubscribeBibleFolders = vi.fn()
const mockUnsubscribeFileExplorer = vi.fn()
const mockRecoverStaleJobs = vi.fn().mockResolvedValue(0)
const mockRemoveExpiredHistory = vi.fn().mockResolvedValue(0)
const mockRegisterExecutor = vi.fn()
const mockRecoverPendingSyncResourceCleanups = vi.fn().mockResolvedValue({
  folderIds: [],
  itemIds: [],
  tombstoneCount: 0
})
const mockRetryPendingResourceCleanups = vi.fn().mockResolvedValue({
  attempted: 0,
  failed: 0
})
const mockStopSyncRuntime = vi.fn()
const mockStartSyncRuntime = vi.fn(() => mockStopSyncRuntime)
const mockIsElectron = vi.fn(() => false)

const bibleState = {
  isInitialized: false,
  isOffline: false,
  versions: [],
  content: new Map(),
  isLoading: false,
  retry: mockRetry,
  initialize: mockInitialize
}

const folderState = {
  isLoading: false,
  initialize: mockFolderInitialize,
  cleanupExpired: mockFolderCleanupExpired
}

const fileExplorerState = {
  isLoading: false,
  initialize: mockFileExplorerInitialize,
  cleanupExpired: mockFileExplorerCleanupExpired
}

vi.mock('@heroui/react/toast', () => ({
  toast: { success: mockToastSuccess, warning: mockToastWarning }
}))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

vi.mock('@renderer/stores/bible', () => ({
  useBibleStore: Object.assign(
    (selector: (s: typeof bibleState) => unknown) => selector(bibleState),
    {
      getState: () => bibleState,
      subscribe: vi.fn(() => mockUnsubscribeBible),
      setState: vi.fn()
    }
  )
}))

vi.mock('@renderer/stores/folder', () => ({
  useBibleFolderStore: Object.assign(
    (selector: (s: typeof folderState) => unknown) => selector(folderState),
    {
      getState: () => folderState,
      subscribe: vi.fn(() => mockUnsubscribeBibleFolders)
    }
  )
}))

vi.mock('@renderer/stores/file-explorer', () => ({
  useFileExplorerStore: Object.assign(
    (selector: (s: typeof fileExplorerState) => unknown) => selector(fileExplorerState),
    {
      getState: () => fileExplorerState,
      subscribe: vi.fn(() => mockUnsubscribeFileExplorer)
    }
  )
}))

vi.mock('@renderer/stores/bible-settings', () => ({
  useBibleSettingsStore: Object.assign(vi.fn(), {
    getState: () => ({ selectedVersionId: 1 })
  })
}))

vi.mock('@renderer/lib/bible-search', () => ({
  initializeSearchIndexes: mockInitializeSearchIndexes
}))

vi.mock('@renderer/lib/env', () => ({
  isElectron: mockIsElectron
}))

vi.mock('@renderer/lib/media-job-queue', () => ({
  mediaJobQueue: {
    recoverStaleJobs: mockRecoverStaleJobs,
    removeExpiredHistory: mockRemoveExpiredHistory,
    registerExecutor: mockRegisterExecutor
  }
}))

vi.mock('@renderer/lib/sync-unlink', () => ({
  recoverPendingSyncResourceCleanups: mockRecoverPendingSyncResourceCleanups
}))

vi.mock('@renderer/lib/resource-cleanup-journal', () => ({
  retryPendingResourceCleanups: mockRetryPendingResourceCleanups
}))

vi.mock('@renderer/lib/sync-runtime', () => ({
  startSyncRuntime: mockStartSyncRuntime
}))

describe('startEarlyInit', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockIsElectron.mockReturnValue(false)
    window.location.hash = ''
  })

  it('recovers every persisted running job immediately in Electron', async () => {
    mockIsElectron.mockReturnValue(true)
    const { startEarlyInit } = await import('../app-init')

    startEarlyInit()
    await vi.waitFor(() => expect(mockRecoverStaleJobs).toHaveBeenCalledWith(expect.any(Number), 0))
  })

  it('replays sync cleanup before recovering stale jobs', async () => {
    let finishCleanup = (): void => undefined
    mockRecoverPendingSyncResourceCleanups.mockReturnValueOnce(
      new Promise((resolve) => {
        finishCleanup = () => resolve({ folderIds: [], itemIds: [], tombstoneCount: 1 })
      })
    )
    const { startEarlyInit } = await import('../app-init')

    startEarlyInit()
    await Promise.resolve()
    expect(mockRecoverStaleJobs).not.toHaveBeenCalled()

    finishCleanup()
    await vi.waitFor(() => expect(mockRecoverStaleJobs).toHaveBeenCalledOnce())
  })

  it('waits for File Explorer hydration before cleanup replay', async () => {
    let finishHydration = (): void => undefined
    mockFileExplorerInitialize.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishHydration = resolve
      })
    )
    const { startEarlyInit } = await import('../app-init')

    startEarlyInit()
    await Promise.resolve()
    expect(mockRecoverPendingSyncResourceCleanups).not.toHaveBeenCalled()

    finishHydration()
    await vi.waitFor(() => expect(mockRecoverPendingSyncResourceCleanups).toHaveBeenCalledOnce())
  })

  it('does not recover jobs or start sync when cleanup replay fails', async () => {
    mockRecoverPendingSyncResourceCleanups.mockRejectedValueOnce(new Error('cleanup failed'))
    const { initializeApp } = await import('../app-init')

    const cleanup = initializeApp()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockRecoverStaleJobs).not.toHaveBeenCalled()
    expect(mockStartSyncRuntime).not.toHaveBeenCalled()
    cleanup()
  })

  it('keeps the five-minute recovery lease in the browser', async () => {
    const { startEarlyInit } = await import('../app-init')

    startEarlyInit()
    await vi.waitFor(() =>
      expect(mockRecoverStaleJobs).toHaveBeenCalledWith(expect.any(Number), 5 * 60 * 1000)
    )
  })

  it('skips control-window initialization on the projection route', async () => {
    window.location.hash = '#/projection'
    const { startEarlyInit } = await import('../app-init')

    startEarlyInit()
    await Promise.resolve()

    expect(mockInitialize).not.toHaveBeenCalled()
    expect(mockFolderInitialize).not.toHaveBeenCalled()
    expect(mockFileExplorerInitialize).not.toHaveBeenCalled()
    expect(mockRecoverStaleJobs).not.toHaveBeenCalled()
  })

  it('replays pending resource cleanup after File Explorer initialization', async () => {
    const { initializeApp } = await import('../app-init')

    const cleanup = initializeApp()

    await vi.waitFor(() => {
      expect(mockRetryPendingResourceCleanups).toHaveBeenCalledTimes(1)
    })
    cleanup()
  })
})

describe('initializeApp — online handler', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    bibleState.isOffline = false
    bibleState.isInitialized = false
    const mod = await import('../app-init')
    const cleanup = mod.initializeApp()
    cleanup()
  })

  afterEach(async () => {
    const mod = await import('../app-init')
    mod.initializeApp()()
  })

  it('passes the single context-owned HHC auth facade to the sync runtime', async () => {
    const { initializeApp } = await import('../app-init')
    const options = {
      hhcAuth: {
        getSession: () => null,
        getAccessToken: vi.fn(async () => null),
        refreshAfterUnauthorized: vi.fn(async () => null),
        endSession: vi.fn(async () => undefined)
      },
      onHhcAccessRevoked: vi.fn()
    }

    const cleanup = initializeApp(options)

    await vi.waitFor(() => expect(mockStartSyncRuntime).toHaveBeenCalledWith(options))
    cleanup()
    expect(mockStopSyncRuntime).toHaveBeenCalled()
  })

  it('shows success toast when network comes back online', async () => {
    const { initializeApp } = await import('../app-init')
    const cleanup = initializeApp()

    window.dispatchEvent(new Event('online'))

    expect(mockToastSuccess).toHaveBeenCalledWith('toast.networkRestored')
    cleanup()
  })

  it('calls retry when isOffline is true on coming online', async () => {
    bibleState.isOffline = true
    const { initializeApp } = await import('../app-init')
    const cleanup = initializeApp()

    window.dispatchEvent(new Event('online'))

    expect(mockToastSuccess).toHaveBeenCalledWith('toast.networkRestored')
    expect(mockRetry).toHaveBeenCalled()
    cleanup()
  })

  it('does not call retry when isOffline is false on coming online', async () => {
    bibleState.isOffline = false
    const { initializeApp } = await import('../app-init')
    const cleanup = initializeApp()

    window.dispatchEvent(new Event('online'))

    expect(mockToastSuccess).toHaveBeenCalledWith('toast.networkRestored')
    expect(mockRetry).not.toHaveBeenCalled()
    cleanup()
  })

  it('removes online listener on cleanup', async () => {
    const { initializeApp } = await import('../app-init')
    const cleanup = initializeApp()
    cleanup()

    vi.clearAllMocks()
    window.dispatchEvent(new Event('online'))

    expect(mockToastSuccess).not.toHaveBeenCalled()
  })

  it('shows warning toast when network goes offline', async () => {
    const { initializeApp } = await import('../app-init')
    const cleanup = initializeApp()

    window.dispatchEvent(new Event('offline'))

    expect(mockToastWarning).toHaveBeenCalledWith('toast.networkLost')
    cleanup()
  })

  it('removes offline listener on cleanup', async () => {
    const { initializeApp } = await import('../app-init')
    const cleanup = initializeApp()
    cleanup()

    vi.clearAllMocks()
    window.dispatchEvent(new Event('offline'))

    expect(mockToastWarning).not.toHaveBeenCalled()
  })

  it('unsubscribes all app-level store subscriptions on cleanup', async () => {
    const { initializeApp } = await import('../app-init')
    const cleanup = initializeApp()
    const bibleCalls = mockUnsubscribeBible.mock.calls.length
    const folderCalls = mockUnsubscribeBibleFolders.mock.calls.length
    const fileExplorerCalls = mockUnsubscribeFileExplorer.mock.calls.length
    cleanup()

    expect(mockUnsubscribeBible).toHaveBeenCalledTimes(bibleCalls + 1)
    expect(mockUnsubscribeBibleFolders).toHaveBeenCalledTimes(folderCalls + 1)
    expect(mockUnsubscribeFileExplorer).toHaveBeenCalledTimes(fileExplorerCalls + 1)
  })
})
