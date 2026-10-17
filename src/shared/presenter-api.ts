import type { IpcInvokeChannel, IpcInvokeMap } from './ipc-channels'
import type { PersonalNativeApi } from './personal-cloud'
import type {
  ProjectionChannel,
  ProjectionLifecycleEvent,
  ProjectionPayload
} from './projection-messages'
import type {
  IpcMainToRendererMap,
  WhisperDownloadProgress,
  ProjectionVlcFailure,
  OneDriveNativeDownloadProgress
} from './ipc-channels'
import type { LanRemoteCommand } from './lan-remote'
import type { TimerTickPayload } from './types/timer'
import type { HhcSession } from './hhc-auth'

type Invoke<C extends IpcInvokeChannel> = (
  ...args: IpcInvokeMap[C]['args']
) => Promise<IpcInvokeMap[C]['result']>

interface ThemeAPI {
  get: Invoke<'theme:get'>
  set: Invoke<'theme:set'>
  onChanged: (callback: (data: { shouldUseDarkColors: boolean }) => void) => () => void
}

interface ProjectionAPI {
  check: Invoke<'projection:check'>
  ensure: Invoke<'projection:ensure'>
  moveToDisplay: Invoke<'projection:move-to-display'>
  retry: Invoke<'projection:retry'>
  getGeneration: Invoke<'projection:get-generation'>
  close: Invoke<'projection:close'>
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
  getDisplays: Invoke<'projection:get-displays'>
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
  timerCommand: Invoke<'timer:command'>
  timerGetState: Invoke<'timer:get-state'>
  timerInitialize: Invoke<'timer:initialize'>
  runtimeInitialize: Invoke<'timer:runtime-initialize'>
  runtimeCommand: Invoke<'timer:runtime-command'>
  onTimerTick: (callback: (payload: TimerTickPayload) => void) => () => void
}

interface BibleAPI {
  getVersions: Invoke<'bible:get-versions'>
  getContent: Invoke<'bible:get-content'>
}

interface AppAPI {
  relaunch: Invoke<'app:relaunch'>
  confirmClose: Invoke<'app:confirm-close'>
  onCloseRequested: (callback: () => void) => () => void
  clearUserData: Invoke<'app:clear-user-data'>
  selectDirectory: Invoke<'app:select-directory'>
  setModelDir: Invoke<'app:set-model-dir'>
  checkWhisperDir: Invoke<'app:check-whisper-dir'>
  downloadWhisperModel: Invoke<'app:download-whisper-model'>
  onDownloadProgress: (callback: (data: WhisperDownloadProgress) => void) => () => void
}

interface UpdateAPI {
  installDownloaded: Invoke<'update:install-downloaded'>
  downloadMacInstaller: Invoke<'update:download-mac-installer'>
  onStatusChanged: (
    callback: (...data: IpcMainToRendererMap['update:status-changed']) => void
  ) => () => void
}

interface SpeechAPI {
  saveKey: Invoke<'speech:saveKey'>
  loadKey: Invoke<'speech:loadKey'>
  deleteKey: Invoke<'speech:deleteKey'>
}

interface NativeFsAPI {
  importFile: (id: string, file: File) => Promise<{ size: number }>
  getUrl: (id: string, mimeType: string) => string
  exists: Invoke<'native-fs:file-exists'>
  delete: Invoke<'native-fs:delete-file'>
  getVideoCacheUsage: Invoke<'native-fs:video-cache-usage'>
  clearVideoCache: Invoke<'native-fs:clear-video-cache'>
}

interface VideoPosterAPI {
  getInfo: Invoke<'video-poster:get-info'>
  generate: Invoke<'video-poster:generate'>
}

interface ProjectionVlcAPI {
  getPreviewFrame: Invoke<'projection-vlc:preview'>
  getInfo: Invoke<'projection-vlc:get-info'>
  start: Invoke<'projection-vlc:start'>
  control: Invoke<'projection-vlc:control'>
  stop: Invoke<'projection-vlc:stop'>
  onFailure: (callback: (failure: ProjectionVlcFailure) => void) => () => void
  onStarted: (callback: (generation: number, itemId: string) => void) => () => void
}

interface LocalSyncAPI {
  selectFolder: Invoke<'local-sync:select-folder'>
  listFolders: Invoke<'local-sync:list-folders'>
  scanFolder: Invoke<'local-sync:scan-folder'>
  importFile: Invoke<'local-sync:import-file'>
  startWatch: Invoke<'local-sync:start-watch'>
  getWatchStatus: Invoke<'local-sync:get-watch-status'>
  stopWatch: Invoke<'local-sync:stop-watch'>
  disconnectFolder: Invoke<'local-sync:disconnect-folder'>
}

interface OneDriveAPI {
  getCredentialStatus: Invoke<'onedrive:get-credential-status'>
  getAccessToken: Invoke<'onedrive:get-access-token'>
  completeAuth: Invoke<'onedrive:complete-auth'>
  deleteCredentials: Invoke<'onedrive:delete-credentials'>
  getAuthRedirectUri: Invoke<'onedrive:get-auth-redirect-uri'>
  waitAuthCallback: Invoke<'onedrive:wait-auth-callback'>
  downloadFile: Invoke<'onedrive:download-file'>
  onDownloadProgress: (callback: (data: OneDriveNativeDownloadProgress) => void) => () => void
}

interface HhcAuthAPI {
  begin: Invoke<'hhc-auth:begin'>
  cancel: Invoke<'hhc-auth:cancel'>
  getAccessToken: Invoke<'hhc-auth:get-access-token'>
  refreshAfterUnauthorized: Invoke<'hhc-auth:refresh-after-unauthorized'>
  getSession: Invoke<'hhc-auth:get-session'>
  signOut: Invoke<'hhc-auth:sign-out'>
  resolveShareTarget: Invoke<'hhc-auth:resolve-share-target'>
  resolveAccountLabels: Invoke<'hhc-auth:resolve-account-labels'>
  onSessionChanged: (callback: (session: HhcSession | null) => void) => () => void
}

interface HhcAssetsAPI {
  listCollections: Invoke<'hhc-assets:list-collections'>
  getCollectionChanges: Invoke<'hhc-assets:get-collection-changes'>
  getCollectionItem: Invoke<'hhc-assets:get-collection-item'>
  issueContentTicket: Invoke<'hhc-assets:issue-content-ticket'>
  recordSyncReceipt: Invoke<'hhc-assets:record-sync-receipt'>
  downloadFile: Invoke<'hhc-assets:download-file'>
  cancelDownload: Invoke<'hhc-assets:cancel-download'>
  createContentLease: Invoke<'hhc-assets:create-content-lease'>
  releaseContentLease: Invoke<'hhc-assets:release-content-lease'>
  clearContentLeases: Invoke<'hhc-assets:clear-content-leases'>
}

interface LanRemoteAPI {
  start: Invoke<'lan-remote:start'>
  stop: Invoke<'lan-remote:stop'>
  getStatus: Invoke<'lan-remote:get-status'>
  createPairing: Invoke<'lan-remote:create-pairing'>
  publishState: Invoke<'lan-remote:publish-state'>
  publishAck: Invoke<'lan-remote:publish-ack'>
  onCommand: (callback: (command: LanRemoteCommand) => void) => () => void
}

export interface PresenterApi {
  capture: {
    getSources: Invoke<'capture:get-sources'>
    selectSource: Invoke<'capture:select-source'>
  }
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
