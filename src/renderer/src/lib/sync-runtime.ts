import type { HhcSession } from '@shared/hhc-auth'
import type { FolderRecord } from '@shared/types/folder'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { useSettingsStore } from '@renderer/stores/settings'
import { isElectron } from './env'
import { refreshLocalSyncConnection } from './local-sync-import'
import { refreshAllOneDriveFolders, type OneDriveRefreshSummary } from './onedrive-connect'
import {
  getCloudProviderAdapter,
  type CloudRefreshSummary,
  type HhcLineCloudAuth
} from './cloud-provider'
import { listProviderConnectionsByType, type ProviderConnectionRecord } from './sync-db'
import type { MeetingWindowsApi, MediaSyncWindow } from './meeting-windows-api'
import { startPersonalSync } from './personal-sync-runtime'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { getCurrentHhcSession } from './hhc-auth'

const LOCAL_SYNC_POLL_MS = 3_000
const ONEDRIVE_IDLE_REFRESH_MS = 60_000
const ONEDRIVE_ACTIVE_REFRESH_MS = 15_000
const HHC_IDLE_REFRESH_MS = 60_000
const HHC_ACTIVE_REFRESH_MS = 15_000
const HHC_MEETING_REFRESH_MS = 2_000

const localRefreshInFlight = new Set<string>()
let oneDriveRefreshInFlight = false
const hhcRefreshInFlight = new Set<string>()
const hhcAuthBlockedAtGeneration = new Map<string, number>()
const hhcRevokedRoots = new Map<string, FolderRecord>()

export interface SyncRuntimeOptions {
  hhcAuth?: HhcLineCloudAuth
  getHhcAuthGeneration?: () => number
  onHhcAccessRevoked?: (input: {
    connectionId: string
    rootFolderId: string
  }) => void | Promise<void>
  meetingWindows?: MeetingWindowsApi
}

interface RefreshTimingSummary {
  changedCount?: number
  pendingFileCount?: number
  retryableFileCount?: number
  nextRetryAt?: number
}

interface HhcRefreshResult {
  summaries: CloudRefreshSummary[]
  retrySoon: boolean
}

async function refreshLocalConnection(connectionId: string): Promise<void> {
  if (localRefreshInFlight.has(connectionId)) return
  localRefreshInFlight.add(connectionId)
  try {
    await refreshLocalSyncConnection(connectionId)
  } finally {
    localRefreshInFlight.delete(connectionId)
  }
}

async function refreshAllLocalSyncFolders(): Promise<void> {
  if (!isElectron() || !window.api?.localSync) return
  const connections = await window.api.localSync.listFolders()
  for (const connection of connections) {
    await refreshLocalConnection(connection.id)
    await window.api.localSync.startWatch(connection.id).catch(() => undefined)
  }
}

async function refreshLocalSyncIfDirty(): Promise<void> {
  if (!isElectron() || !window.api?.localSync) return
  const connections = await window.api.localSync.listFolders()
  for (const connection of connections) {
    const status = await window.api.localSync.getWatchStatus(connection.id).catch(() => null)
    if (!status || status.state === 'idle') {
      await window.api.localSync.startWatch(connection.id).catch(() => undefined)
      continue
    }
    if (status.state === 'rescan-needed' || status.state === 'overflow-rescan') {
      await refreshLocalConnection(connection.id)
      await window.api.localSync.startWatch(connection.id).catch(() => undefined)
    }
  }
}

function getNextCloudDelay(summaries: RefreshTimingSummary[], now = Date.now()): number {
  const nextRetryAt = summaries
    .map((summary) => summary.nextRetryAt)
    .filter((value): value is number => typeof value === 'number')
    .sort((a, b) => a - b)[0]
  if (nextRetryAt !== undefined) {
    return Math.max(
      ONEDRIVE_ACTIVE_REFRESH_MS,
      Math.min(ONEDRIVE_IDLE_REFRESH_MS, nextRetryAt - now)
    )
  }
  const hasActiveWork = summaries.some(
    (summary) =>
      (summary.changedCount ?? 0) > 0 ||
      (summary.pendingFileCount ?? 0) > 0 ||
      (summary.retryableFileCount ?? 0) > 0
  )
  return hasActiveWork ? ONEDRIVE_ACTIVE_REFRESH_MS : ONEDRIVE_IDLE_REFRESH_MS
}

async function refreshOneDrive(): Promise<OneDriveRefreshSummary[]> {
  if (oneDriveRefreshInFlight) return []
  oneDriveRefreshInFlight = true
  try {
    return await refreshAllOneDriveFolders()
  } finally {
    oneDriveRefreshInFlight = false
  }
}

function classifyHhcError(
  error: unknown
): 'retryable' | 'offline' | 'auth-required' | 'access-revoked' | 'fatal' {
  if (error instanceof TypeError) return 'offline'
  if (error && typeof error === 'object' && 'classification' in error) {
    const classification = error.classification
    if (
      classification === 'retryable' ||
      classification === 'auth-required' ||
      classification === 'fatal'
    ) {
      return classification
    }
    if (
      classification === 'access-revoked' &&
      'status' in error &&
      (error.status === 403 || error.status === 404)
    ) {
      return classification
    }
  }
  return 'fatal'
}

function activeHhcRoots(connectionId: string): FolderRecord[] {
  return Object.values(useFileExplorerStore.getState().folders).filter(
    (folder) =>
      !folder.deletedAt &&
      folder.syncLink?.providerType === 'hhc-line' &&
      folder.syncLink.providerConnectionId === connectionId &&
      folder.syncLink.status === 'active'
  )
}

function revokedHhcRoots(connectionId: string): FolderRecord[] {
  return Object.values(useFileExplorerStore.getState().folders).filter(
    (folder) =>
      !folder.deletedAt &&
      folder.syncLink?.providerType === 'hhc-line' &&
      folder.syncLink.providerConnectionId === connectionId &&
      folder.syncLink.status === 'access-revoked'
  )
}

function revokedRootKey(connectionId: string, rootFolderId: string): string {
  return `${connectionId}\0${rootFolderId}`
}

async function refreshHhcConnection(
  connection: ProviderConnectionRecord,
  roots: FolderRecord[],
  session: HhcSession,
  options: SyncRuntimeOptions
): Promise<HhcRefreshResult> {
  const auth = options.hhcAuth
  if (!auth || hhcRefreshInFlight.has(connection.id)) return { summaries: [], retrySoon: false }

  const authGeneration = options.getHhcAuthGeneration?.() ?? 0
  const blockedGeneration = hhcAuthBlockedAtGeneration.get(connection.id)
  if (blockedGeneration === authGeneration) return { summaries: [], retrySoon: false }
  if (blockedGeneration !== undefined) hhcAuthBlockedAtGeneration.delete(connection.id)

  hhcRefreshInFlight.add(connection.id)
  const summaries: CloudRefreshSummary[] = []
  let retrySoon = false
  try {
    const adapter = getCloudProviderAdapter('hhc-line', auth)
    for (const root of roots) {
      if (auth.getSession()?.userId !== session.userId) break
      const key = revokedRootKey(connection.id, root.id)
      if (hhcRevokedRoots.has(key)) continue
      try {
        summaries.push(await adapter.refreshFolder(root.id))
      } catch (error) {
        const classification = classifyHhcError(error)
        if (classification === 'auth-required') {
          hhcAuthBlockedAtGeneration.set(connection.id, authGeneration)
          break
        }
        if (classification === 'access-revoked') {
          hhcRevokedRoots.set(key, root)
          try {
            await options.onHhcAccessRevoked?.({
              connectionId: connection.id,
              rootFolderId: root.id
            })
            hhcRevokedRoots.delete(key)
          } catch {
            retrySoon = true
            console.warn('[sync] Failed to handle revoked HHC LINE root')
          }
          continue
        }
        if (classification === 'retryable' || classification === 'offline') {
          retrySoon = true
          continue
        }
        console.warn('[sync] Failed to refresh HHC LINE root')
      }
    }
  } finally {
    hhcRefreshInFlight.delete(connection.id)
  }
  return { summaries, retrySoon }
}

async function refreshAllHhcFolders(options: SyncRuntimeOptions): Promise<HhcRefreshResult> {
  const auth = options.hhcAuth
  const session = auth?.getSession()
  if (!auth || !session) return { summaries: [], retrySoon: false }

  const connections = (await listProviderConnectionsByType('hhc-line')).filter(
    (connection) => connection.accountUserId === session.userId
  )
  if (auth.getSession()?.userId !== session.userId) return { summaries: [], retrySoon: false }

  const folders = useFileExplorerStore.getState().folders
  const connectionIds = new Set(connections.map((connection) => connection.id))
  let retrySoon = false
  for (const connection of connections) {
    for (const root of revokedHhcRoots(connection.id)) {
      const key = revokedRootKey(connection.id, root.id)
      if (!hhcRevokedRoots.has(key)) hhcRevokedRoots.set(key, root)
    }
  }
  for (const [key, revokedRoot] of hhcRevokedRoots) {
    const current = folders[revokedRoot.id]
    if (
      !current ||
      !connectionIds.has(revokedRoot.syncLink?.providerConnectionId ?? '') ||
      current.syncLink?.providerType !== 'hhc-line' ||
      current.syncLink.providerConnectionId !== revokedRoot.syncLink?.providerConnectionId
    ) {
      hhcRevokedRoots.delete(key)
      continue
    }
    try {
      await options.onHhcAccessRevoked?.({
        connectionId: current.syncLink.providerConnectionId,
        rootFolderId: current.id
      })
      hhcRevokedRoots.delete(key)
    } catch {
      retrySoon = true
      console.warn('[sync] Failed to retry revoked HHC LINE root cleanup')
    }
  }

  const results = await Promise.all(
    connections.map((connection) =>
      refreshHhcConnection(connection, activeHhcRoots(connection.id), session, options)
    )
  )
  return {
    summaries: results.flatMap((result) => result.summaries),
    retrySoon: retrySoon || results.some((result) => result.retrySoon)
  }
}

export function startSyncRuntime(options: SyncRuntimeOptions = {}): () => void {
  let personalOwner: string | null = null
  let stopPersonal: (() => void) | undefined
  const reconcilePersonal = (): void => {
    const account = usePersonalSyncStore.getState()
    const owner = account.accountStatus === 'authenticated' ? account.activeOwnerId : null
    if (owner === personalOwner) return
    stopPersonal?.()
    stopPersonal = undefined
    personalOwner = owner
    const auth = options.hhcAuth
    if (owner && auth)
      stopPersonal = startPersonalSync(owner, {
        getSession: async () => getCurrentHhcSession(),
        getAccessToken: auth.getAccessToken,
        refreshAccessToken: auth.refreshAccessToken
      })
  }
  const unsubscribePersonal = usePersonalSyncStore.subscribe(reconcilePersonal)
  reconcilePersonal()
  let localInterval: number | undefined
  if (isElectron()) {
    void refreshAllLocalSyncFolders().catch((error) => {
      console.warn('[sync] Failed to start local sync runtime', error)
    })
    localInterval = window.setInterval(() => {
      void refreshLocalSyncIfDirty().catch((error) => {
        console.warn('[sync] Failed to refresh local sync folders', error)
      })
    }, LOCAL_SYNC_POLL_MS)
  }

  let stopped = false
  let oneDriveTimeout: number | undefined
  let oneDriveRunning = false
  let oneDrivePending = false
  let hhcTimeout: number | undefined
  let hhcRunning = false
  let hhcPending = false
  const meetingWindows = options.meetingWindows
  let knownWindows: MediaSyncWindow[] = []
  let meetingLookupRunning = false
  let meetingInterval: number | undefined
  let hhcDueAt = Number.POSITIVE_INFINITY
  let hhcAuthGeneration = options.getHhcAuthGeneration?.() ?? 0

  const meetingDelay = (normalDelay: number): number => {
    const now = Date.now()
    if (
      knownWindows.some(
        (value) => Date.parse(value.startsAt) <= now && now < Date.parse(value.endsAt)
      )
    ) {
      return Math.min(normalDelay, HHC_MEETING_REFRESH_MS)
    }
    const nextStart = Math.min(
      ...knownWindows.map((value) => Date.parse(value.startsAt)).filter((start) => start > now)
    )
    return Math.min(normalDelay, nextStart - now)
  }

  const discoverMeetings = async (): Promise<void> => {
    if (stopped) return
    const generation = options.getHhcAuthGeneration?.() ?? 0
    if (generation !== hhcAuthGeneration) {
      hhcAuthGeneration = generation
      knownWindows = []
      if (hhcRunning) hhcPending = true
      else scheduleHhc(0)
    }
    if (!meetingWindows || meetingLookupRunning) return
    meetingLookupRunning = true
    try {
      const windows = await meetingWindows.list()
      if (!stopped) knownWindows = windows
    } catch {
      if (!stopped) knownWindows = []
    } finally {
      meetingLookupRunning = false
    }
    if (!stopped && !hhcRunning) {
      const delay = meetingDelay(HHC_IDLE_REFRESH_MS)
      if (Date.now() + delay < hhcDueAt) scheduleHhc(delay)
    }
  }

  const scheduleOneDrive = (delay: number): void => {
    if (stopped) return
    oneDriveTimeout = window.setTimeout(() => {
      oneDriveTimeout = undefined
      void runOneDrive()
    }, delay)
  }

  const runOneDrive = async (): Promise<void> => {
    oneDriveRunning = true
    let delay = ONEDRIVE_ACTIVE_REFRESH_MS
    try {
      delay = getNextCloudDelay(await refreshOneDrive())
    } catch (error) {
      console.warn('[sync] Failed to refresh OneDrive folders', error)
    } finally {
      oneDriveRunning = false
    }
    if (oneDrivePending) {
      oneDrivePending = false
      scheduleOneDrive(0)
    } else {
      scheduleOneDrive(delay)
    }
  }

  const scheduleHhc = (delay: number): void => {
    if (stopped) return
    if (hhcTimeout !== undefined) window.clearTimeout(hhcTimeout)
    hhcDueAt = Date.now() + delay
    hhcTimeout = window.setTimeout(() => {
      hhcDueAt = Number.POSITIVE_INFINITY
      hhcTimeout = undefined
      void runHhc()
    }, delay)
  }

  const runHhc = async (): Promise<void> => {
    const generation = options.getHhcAuthGeneration?.() ?? 0
    if (generation !== hhcAuthGeneration) {
      hhcAuthGeneration = generation
      knownWindows = []
    }
    hhcRunning = true
    void discoverMeetings()
    const result = await refreshAllHhcFolders(options).catch(() => {
      console.warn('[sync] Failed to enumerate HHC LINE roots')
      return { summaries: [] as CloudRefreshSummary[], retrySoon: true }
    })
    const hasPersonalShareState = Object.values(useFileExplorerStore.getState().folders).some(
      (folder) => Boolean(folder.sharedRecipientId)
    )
    if (options.hhcAuth?.getSession() && hasPersonalShareState) {
      try {
        await (await import('./personal-share-sync')).reconcilePersonalShares(options.hhcAuth)
      } catch (error) {
        const classification = classifyHhcError(error)
        result.retrySoon ||= classification === 'offline' || classification === 'retryable'
        if (classification === 'fatal') console.warn('[sync] Failed to refresh shared folders')
      }
    }
    hhcRunning = false
    if (hhcPending) {
      hhcPending = false
      scheduleHhc(0)
    } else {
      scheduleHhc(
        meetingDelay(
          result.retrySoon
            ? HHC_ACTIVE_REFRESH_MS
            : Math.min(HHC_IDLE_REFRESH_MS, getNextCloudDelay(result.summaries))
        )
      )
    }
  }

  const unsubscribeOfflinePolicy = useSettingsStore.subscribe((state, previousState) => {
    if (state.defaultSyncOfflinePolicy === previousState.defaultSyncOfflinePolicy) return
    if (oneDriveTimeout !== undefined) {
      window.clearTimeout(oneDriveTimeout)
      oneDriveTimeout = undefined
    }
    if (hhcTimeout !== undefined) {
      window.clearTimeout(hhcTimeout)
      hhcTimeout = undefined
    }
    if (oneDriveRunning) oneDrivePending = true
    else scheduleOneDrive(0)
    if (hhcRunning) hhcPending = true
    else scheduleHhc(0)
  })

  const resumeHhc = (): void => {
    if (stopped) return
    void discoverMeetings()
    if (hhcRunning) hhcPending = true
    else scheduleHhc(0)
  }
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') resumeHhc()
  }
  window.addEventListener('online', resumeHhc)
  window.addEventListener('focus', resumeHhc)
  document.addEventListener('visibilitychange', onVisibilityChange)

  if (meetingWindows) {
    meetingInterval = window.setInterval(() => {
      void discoverMeetings()
    }, HHC_ACTIVE_REFRESH_MS)
  }
  void runOneDrive()
  void runHhc()

  return () => {
    stopped = true
    unsubscribePersonal()
    stopPersonal?.()
    unsubscribeOfflinePolicy()
    window.removeEventListener('online', resumeHhc)
    window.removeEventListener('focus', resumeHhc)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (meetingInterval !== undefined) window.clearInterval(meetingInterval)
    if (localInterval !== undefined) window.clearInterval(localInterval)
    if (oneDriveTimeout !== undefined) window.clearTimeout(oneDriveTimeout)
    if (hhcTimeout !== undefined) window.clearTimeout(hhcTimeout)
  }
}
