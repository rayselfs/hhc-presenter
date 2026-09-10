import type { PersonalNativeApi } from '../shared/personal-cloud'
import type {
  ProjectionChannel,
  ProjectionLifecycleEvent,
  ProjectionPayload,
  ProjectionWindowState
} from '../shared/projection-messages'
import type {
  DisplayInfo,
  IpcMainToRendererMap,
  WhisperModel,
  WhisperDownloadProgress,
  WhisperDirInfo,
  VideoPosterInfo,
  VideoPosterRequest,
  VideoPosterResult,
  ProjectionVlcControlRequest,
  ProjectionVlcFailure,
  ProjectionVlcInfo,
  ProjectionVlcStartRequest,
  ProjectionVlcStopRequest,
  LocalSyncConnectionInfo,
  LocalSyncImportFileRequest,
  LocalSyncWatchStatus,
  LocalSyncRemoteItem,
  OneDriveAccessTokenRequest,
  OneDriveAccessTokenResult,
  OneDriveAuthCodeExchangeRequest,
  OneDriveCredentialStatus,
  OneDriveConnectedAccount,
  OneDriveNativeDownloadRequest,
  OneDriveNativeDownloadResult,
  OneDriveNativeDownloadProgress,
  LanRemotePairingInfo,
  LanRemoteStatus
} from '../shared/ipc-channels'
import type {
  HhcAssetCollectionChangePage,
  HhcAssetCollectionItem,
  HhcAssetCollectionPage,
  HhcAssetCollectionRequest,
  HhcAssetContentTicket,
  HhcAssetItemRequest,
  HhcAssetNativeDownloadRequest,
  HhcAssetNativeDownloadResult,
  HhcAssetNativeLease,
  HhcAssetSyncReceipt
} from '../shared/hhc-assets'
import type { LanRemoteAck, LanRemoteCommand, LanRemoteSnapshot } from '../shared/lan-remote'
import type {
  TimerCommand,
  TimerSettings,
  TimerState,
  StopwatchState,
  TimerTickPayload
} from '../shared/types/timer'
import type { BibleVersion, BibleBook } from '../shared/types/bible'
import type { HhcPendingSignIn, HhcSession, PresenterAccountLabel } from '../shared/hhc-auth'

interface ThemeAPI {
  get: () => Promise<{ source: string; shouldUseDarkColors: boolean }>
  set: (theme: 'light' | 'dark' | 'system') => Promise<void>
  onChanged: (callback: (data: { shouldUseDarkColors: boolean }) => void) => () => void
}

interface ProjectionAPI {
  check: () => Promise<ProjectionWindowState>
  ensure: (displayId?: string) => Promise<{ created: boolean; generation: number }>
  moveToDisplay: (displayId: string) => Promise<{ moved: boolean; generation: number }>
  retry: () => Promise<{ retried: boolean; generation: number }>
  getGeneration: () => Promise<{ generation: number }>
  close: () => Promise<{ closed: boolean }>
  send: <C extends ProjectionChannel>(
    generation: number,
    channel: C,
    data: ProjectionPayload<C>
  ) => void
  sendToMain: <C extends ProjectionChannel>(
    generation: number,
    channel: C,
    data: ProjectionPayload<C>
  ) => void
  getDisplays: () => Promise<DisplayInfo[]>
  onProjectionMessage: (
    callback: (
      generation: number,
      channel: ProjectionChannel,
      data: ProjectionPayload<ProjectionChannel>
    ) => void
  ) => () => void
  onProjectionLifecycle: (callback: (event: ProjectionLifecycleEvent) => void) => () => void
}

interface TimerAPI {
  timerCommand: (cmd: TimerCommand) => Promise<void>
  timerGetState: () => Promise<TimerState & { stopwatch: StopwatchState }>
  timerInitialize: (settings: TimerSettings) => Promise<void>
  onTimerTick: (callback: (payload: TimerTickPayload) => void) => () => void
}

interface BibleAPI {
  getVersions: () => Promise<BibleVersion[]>
  getContent: (versionId: number) => Promise<BibleBook[]>
}

interface AppAPI {
  relaunch: () => Promise<void>
  confirmClose: () => Promise<{ closing: boolean }>
  onCloseRequested: (callback: () => void) => () => void
  clearUserData: () => Promise<void>
  selectDirectory: () => Promise<string | null>
  setModelDir: (dir: string) => Promise<void>
  checkWhisperDir: (dir: string) => Promise<WhisperDirInfo>
  downloadWhisperModel: (model: WhisperModel, destDir: string) => Promise<void>
  onDownloadProgress: (callback: (data: WhisperDownloadProgress) => void) => () => void
}

interface UpdateAPI {
  installDownloaded: () => Promise<void>
  downloadMacInstaller: () => Promise<void>
  onStatusChanged: (
    callback: (...data: IpcMainToRendererMap['update:status-changed']) => void
  ) => () => void
}

interface SpeechAPI {
  saveKey: (provider: string, apiKey: string) => Promise<void>
  loadKey: (provider: string) => Promise<string>
  deleteKey: (provider: string) => Promise<void>
}

interface NativeFsAPI {
  importFile: (id: string, file: File) => Promise<{ size: number }>
  getUrl: (id: string, mimeType: string) => string
  exists: (id: string) => Promise<boolean>
  delete: (id: string) => Promise<void>
}

interface VideoPosterAPI {
  getInfo: () => Promise<VideoPosterInfo>
  generate: (request: VideoPosterRequest) => Promise<VideoPosterResult>
}

interface ProjectionVlcAPI {
  getInfo: () => Promise<ProjectionVlcInfo>
  start: (request: ProjectionVlcStartRequest) => Promise<void>
  control: (command: ProjectionVlcControlRequest) => Promise<void>
  stop: (request: ProjectionVlcStopRequest) => Promise<void>
  onFailure: (callback: (failure: ProjectionVlcFailure) => void) => () => void
  onStarted: (callback: (generation: number, itemId: string) => void) => () => void
}

interface LocalSyncAPI {
  selectFolder: () => Promise<LocalSyncConnectionInfo | null>
  listFolders: () => Promise<LocalSyncConnectionInfo[]>
  scanFolder: (connectionId: string) => Promise<LocalSyncRemoteItem[]>
  importFile: (request: LocalSyncImportFileRequest) => Promise<{ size: number }>
  startWatch: (connectionId: string) => Promise<LocalSyncWatchStatus>
  getWatchStatus: (connectionId: string) => Promise<LocalSyncWatchStatus>
  stopWatch: (connectionId: string) => Promise<LocalSyncWatchStatus>
  disconnectFolder: (connectionId: string) => Promise<void>
}

interface OneDriveAPI {
  getCredentialStatus: (connectionId: string) => Promise<OneDriveCredentialStatus>
  getAccessToken: (request: OneDriveAccessTokenRequest) => Promise<OneDriveAccessTokenResult>
  completeAuth: (request: OneDriveAuthCodeExchangeRequest) => Promise<OneDriveConnectedAccount>
  deleteCredentials: (connectionId: string) => Promise<void>
  getAuthRedirectUri: () => Promise<string>
  waitAuthCallback: (expectedState?: string) => Promise<string | null>
  downloadFile: (request: OneDriveNativeDownloadRequest) => Promise<OneDriveNativeDownloadResult>
  onDownloadProgress: (callback: (data: OneDriveNativeDownloadProgress) => void) => () => void
}

interface HhcAuthAPI {
  begin: () => Promise<HhcPendingSignIn>
  cancel: () => Promise<void>
  getAccessToken: () => Promise<string | null>
  refreshAccessToken: () => Promise<string | null>
  getSession: () => Promise<HhcSession | null>
  signOut: () => Promise<void>
  resolveShareTarget: (email: string) => Promise<PresenterAccountLabel>
  resolveAccountLabels: (userIds: string[]) => Promise<PresenterAccountLabel[]>
  onSessionChanged: (callback: (session: HhcSession | null) => void) => () => void
}

interface HhcAssetsAPI {
  listCollections: (cursor?: string) => Promise<HhcAssetCollectionPage>
  getCollectionChanges: (
    request: HhcAssetCollectionRequest
  ) => Promise<HhcAssetCollectionChangePage>
  getCollectionItem: (request: HhcAssetItemRequest) => Promise<HhcAssetCollectionItem>
  issueContentTicket: (request: HhcAssetItemRequest) => Promise<HhcAssetContentTicket>
  recordSyncReceipt: (receipt: HhcAssetSyncReceipt) => Promise<void>
  downloadFile: (request: HhcAssetNativeDownloadRequest) => Promise<HhcAssetNativeDownloadResult>
  cancelDownload: (targetFileId: string) => Promise<void>
  createContentLease: (request: HhcAssetItemRequest) => Promise<HhcAssetNativeLease>
  releaseContentLease: (leaseId: string) => Promise<void>
  clearContentLeases: () => Promise<void>
}

interface LanRemoteAPI {
  start: (options: { host: string; port: number }) => Promise<LanRemoteStatus>
  stop: () => Promise<LanRemoteStatus>
  getStatus: () => Promise<LanRemoteStatus>
  createPairing: (deviceName: string) => Promise<LanRemotePairingInfo>
  publishState: (snapshot: LanRemoteSnapshot) => Promise<void>
  publishAck: (ack: LanRemoteAck) => Promise<void>
  onCommand: (callback: (command: LanRemoteCommand) => void) => () => void
}

declare global {
  interface Window {
    api: {
      projection: ProjectionAPI
      theme: ThemeAPI
      timer: TimerAPI
      bible: BibleAPI
      app: AppAPI
      update: UpdateAPI
      speech: SpeechAPI
      nativeFs: NativeFsAPI
      videoPoster: VideoPosterAPI
      projectionVlc: ProjectionVlcAPI
      localSync: LocalSyncAPI
      oneDrive: OneDriveAPI
      hhcAuth: HhcAuthAPI
      hhcAssets: HhcAssetsAPI
      personalCloud: PersonalNativeApi
      lanRemote: LanRemoteAPI
    }
  }
}
