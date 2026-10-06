import { listenForCatalogDeletions } from './file-catalog-events'
import { useBibleStore } from '@renderer/stores/bible'
import { useBibleFolderStore } from '@renderer/stores/folder'
import { useBibleSettingsStore } from '@renderer/stores/bible-settings'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  purgeExpiredTrashFromStore,
  removeCleanedEntriesFromStore,
  useFileExplorerStore
} from '@renderer/stores/file-explorer'
import { initializeSearchIndexes } from '@renderer/lib/bible-search'
import { isElectron } from '@renderer/lib/env'
import { toast } from '@heroui/react/toast'
import i18n from '@renderer/i18n'
import { mediaJobQueue } from '@renderer/lib/media-job-queue'
import { recoverPendingSyncResourceCleanups } from '@renderer/lib/sync-unlink'
import { startSyncRuntime, type SyncRuntimeOptions } from '@renderer/lib/sync-runtime'
import { retryPendingResourceCleanups } from '@renderer/lib/resource-cleanup-journal'

let earlyInitStarted = false
let subscriptionsInitialized = false
let resourceCleanupReplayStarted = false
let earlyRecoveryPromise: Promise<void> | null = null
let chunksReadyPromise: Promise<void> | null = null
let routePrefetchScheduled = false

function isProjectionRoute(): boolean {
  return window.location.hash.startsWith('#/projection')
}

/**
 * Kick off async store initializations as early as possible (called from main.tsx
 * before React renders). Idempotent — safe to call multiple times.
 */
export function startEarlyInit(): void {
  if (isProjectionRoute()) return
  if (earlyInitStarted) return
  earlyInitStarted = true

  useBibleStore.getState().initialize()
  useBibleFolderStore.getState().initialize()
  const fileExplorerInitialization = useFileExplorerStore.getState().initialize()
  earlyRecoveryPromise = Promise.resolve(fileExplorerInitialization)
    .then(() => recoverPendingSyncResourceCleanups())
    .then(() => mediaJobQueue.recoverStaleJobs(Date.now(), isElectron() ? 0 : 5 * 60 * 1000))
    .then(() => mediaJobQueue.removeExpiredHistory())
    .then(() => undefined)
  void earlyRecoveryPromise.catch(() => undefined)
}

function loadRouteChunks(): Promise<void> {
  if (!chunksReadyPromise) {
    chunksReadyPromise = Promise.all([
      import('@renderer/pages/TimerPage'),
      import('@renderer/pages/BiblePage'),
      import('@renderer/pages/FilesPage'),
      import('@renderer/pages/FavoritesPage'),
      import('@renderer/pages/TrashPage')
    ])
      .then(() => undefined)
      .catch(() => undefined)
  }
  return chunksReadyPromise
}

export function prefetchRouteChunks(): void {
  if (routePrefetchScheduled) return
  routePrefetchScheduled = true

  const run = (): void => {
    void loadRouteChunks()
  }
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 5000 })
  } else {
    setTimeout(run, 2000)
  }
}

async function initWhisperModelDir(): Promise<void> {
  if (!isElectron()) return
  const { speech, setSpeech } = useSettingsStore.getState()
  const modelDir = speech.whisper.modelDir
  if (!modelDir) return

  const info = await window.api.app.checkWhisperDir(modelDir)
  if (!info.hasFiles) {
    setSpeech({ ...speech, whisper: { ...speech.whisper, modelDir: '', installedModel: null } })
    toast.warning(i18n.t('toast.whisperDirReset' as never))
  } else {
    await window.api.app.setModelDir(modelDir)
  }
}

/**
 * Set up app-level subscriptions and side-effects. Called from Layout.useEffect.
 * Calls startEarlyInit() internally as a fallback so this function remains safe
 * to call without a prior startEarlyInit() call.
 */
export function initializeApp(options: SyncRuntimeOptions = {}): () => void {
  startEarlyInit()

  if (subscriptionsInitialized) return () => {}
  subscriptionsInitialized = true
  const stopCatalogEvents = listenForCatalogDeletions(removeCleanedEntriesFromStore)

  void initWhisperModelDir()
  let disposed = false
  let stopSyncRuntime = (): void => undefined
  void (earlyRecoveryPromise ?? Promise.resolve())
    .then(() => {
      if (!disposed) stopSyncRuntime = startSyncRuntime(options)
    })
    .catch(() => undefined)

  let prevModelDir = useSettingsStore.getState().speech.whisper.modelDir
  const unsubWhisper = useSettingsStore.subscribe((state) => {
    const modelDir = state.speech.whisper.modelDir
    if (modelDir !== prevModelDir) {
      prevModelDir = modelDir
      if (isElectron() && modelDir) {
        window.api.app.setModelDir(modelDir).catch(() => {})
      }
    }
  })

  const tryInitSearch = (state: ReturnType<typeof useBibleStore.getState>): void => {
    if (!state.isInitialized || state.versions.length === 0) return
    const selectedVersionId =
      useBibleSettingsStore.getState().selectedVersionId || state.versions[0].id
    initializeSearchIndexes(state.content, state.versions, selectedVersionId)
  }

  const unsubscribe = useBibleStore.subscribe((state, prev) => {
    if (!prev.isInitialized && state.isInitialized) {
      tryInitSearch(state)
    }
  })

  const current = useBibleStore.getState()
  if (current.isInitialized) {
    tryInitSearch(current)
  }

  const unsubBibleFolders = useBibleFolderStore.subscribe((state, prev) => {
    if (prev.isLoading && !state.isLoading) {
      void useBibleFolderStore.getState().cleanupExpired()
    }
  })

  const unsubFileExplorer = useFileExplorerStore.subscribe((state, prev) => {
    if (prev.isLoading && !state.isLoading) {
      useFileExplorerStore.getState().softDeleteExpired()
      const retentionDays = useSettingsStore.getState().trashRetentionDays
      if (retentionDays > 0) {
        void purgeExpiredTrashFromStore(retentionDays * 86_400_000)
      }
      void recoverPendingSyncResourceCleanups().catch(() => undefined)
      if (!resourceCleanupReplayStarted) {
        resourceCleanupReplayStarted = true
        void retryPendingResourceCleanups().catch(() => undefined)
      }
    }
  })
  if (!useFileExplorerStore.getState().isLoading && !resourceCleanupReplayStarted) {
    resourceCleanupReplayStarted = true
    void retryPendingResourceCleanups().catch(() => undefined)
  }

  const handleOnline = (): void => {
    toast.success(i18n.t('toast.networkRestored'))
    if (useBibleStore.getState().isOffline) {
      void useBibleStore.getState().retry()
    }
  }

  const handleOffline = (): void => {
    toast.warning(i18n.t('toast.networkLost'))
  }

  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)

  return () => {
    unsubscribe()
    unsubWhisper()
    unsubBibleFolders()
    unsubFileExplorer()
    stopCatalogEvents()
    disposed = true
    stopSyncRuntime()
    window.removeEventListener('online', handleOnline)
    window.removeEventListener('offline', handleOffline)
    subscriptionsInitialized = false
    const s = useBibleStore.getState()
    if (s.isLoading && !s.isInitialized) {
      useBibleStore.setState({ isLoading: false })
    }
  }
}
