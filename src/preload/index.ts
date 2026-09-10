import type { PersonalNativeApi } from '../shared/personal-cloud'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  IpcInvokeChannel,
  IpcInvokeMap,
  IpcMainToRendererChannel,
  IpcMainToRendererMap,
  WhisperModel,
  WhisperDownloadProgress,
  WhisperDirInfo
} from '../shared/ipc-channels'
import type {
  ProjectionChannel,
  ProjectionLifecycleEvent,
  ProjectionPayload
} from '../shared/projection-messages'
import type { TimerTickPayload } from '../shared/types/timer'

function typedInvoke<C extends IpcInvokeChannel>(
  channel: C,
  ...args: IpcInvokeMap[C]['args']
): Promise<IpcInvokeMap[C]['result']> {
  return ipcRenderer.invoke(channel, ...args)
}

function typedOn<C extends IpcMainToRendererChannel>(
  channel: C,
  handler: (...args: IpcMainToRendererMap[C]) => void
): () => void {
  const wrappedHandler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
    handler(...(args as IpcMainToRendererMap[C]))
  }
  ipcRenderer.on(channel, wrappedHandler)
  return () => ipcRenderer.removeListener(channel, wrappedHandler)
}

const themeApi = {
  get: () => typedInvoke('theme:get'),
  set: (theme: 'light' | 'dark' | 'system') => typedInvoke('theme:set', theme),
  onChanged: (callback: (data: { shouldUseDarkColors: boolean }) => void) =>
    typedOn('theme:changed', callback)
}

const projectionApi = {
  check: () => typedInvoke('projection:check'),
  ensure: (displayId?: string) => typedInvoke('projection:ensure', displayId),
  moveToDisplay: (displayId: string) => typedInvoke('projection:move-to-display', displayId),
  retry: () => typedInvoke('projection:retry'),
  getGeneration: () => typedInvoke('projection:get-generation'),
  close: () => typedInvoke('projection:close'),
  send: <C extends ProjectionChannel>(generation: number, channel: C, data: ProjectionPayload<C>) =>
    ipcRenderer.send('projection:send', generation, channel, data),
  sendToMain: <C extends ProjectionChannel>(
    generation: number,
    channel: C,
    data: ProjectionPayload<C>
  ) => ipcRenderer.send('projection:send-to-main', generation, channel, data),
  getDisplays: () => typedInvoke('projection:get-displays'),
  onProjectionMessage: (
    callback: (
      generation: number,
      channel: ProjectionChannel,
      data: ProjectionPayload<ProjectionChannel>
    ) => void
  ) => typedOn('projection:message', callback),
  onProjectionLifecycle: (callback: (event: ProjectionLifecycleEvent) => void) =>
    typedOn('projection:lifecycle', callback)
}

const timerApi = {
  timerCommand: (cmd: IpcInvokeMap['timer:command']['args'][0]) =>
    typedInvoke('timer:command', cmd),
  timerGetState: () => typedInvoke('timer:get-state'),
  timerInitialize: (settings: IpcInvokeMap['timer:initialize']['args'][0]) =>
    typedInvoke('timer:initialize', settings),
  onTimerTick: (callback: (payload: TimerTickPayload) => void) => typedOn('timer-tick', callback)
}

const bibleApi = {
  getVersions: () => typedInvoke('bible:get-versions'),
  getContent: (versionId: number) => typedInvoke('bible:get-content', versionId)
}

const appApi = {
  relaunch: () => typedInvoke('app:relaunch'),
  confirmClose: () => typedInvoke('app:confirm-close'),
  onCloseRequested: (callback: () => void) => typedOn('app:close-requested', callback),
  clearUserData: () => typedInvoke('app:clear-user-data'),
  selectDirectory: () => typedInvoke('app:select-directory'),
  setModelDir: (dir: string) => typedInvoke('app:set-model-dir', dir),
  checkWhisperDir: (dir: string): Promise<WhisperDirInfo> =>
    typedInvoke('app:check-whisper-dir', dir),
  downloadWhisperModel: (model: WhisperModel, destDir: string) =>
    typedInvoke('app:download-whisper-model', model, destDir),
  onDownloadProgress: (callback: (data: WhisperDownloadProgress) => void) =>
    typedOn('app:download-progress', callback)
}

const updateApi = {
  installDownloaded: () => typedInvoke('update:install-downloaded'),
  downloadMacInstaller: () => typedInvoke('update:download-mac-installer'),
  onStatusChanged: (callback: (...data: IpcMainToRendererMap['update:status-changed']) => void) =>
    typedOn('update:status-changed', callback)
}

const speechApi = {
  saveKey: (provider: string, apiKey: string) => typedInvoke('speech:saveKey', provider, apiKey),
  loadKey: (provider: string) => typedInvoke('speech:loadKey', provider),
  deleteKey: (provider: string) => typedInvoke('speech:deleteKey', provider)
}

const nativeFsApi = {
  importFile: async (id: string, file: File) => {
    const sourcePath = webUtils.getPathForFile(file)
    if (sourcePath) return typedInvoke('native-fs:import-file', id, sourcePath)
    if (file.size > 200 * 1024 * 1024) throw new Error('Generated file exceeds 200 MiB')
    return typedInvoke('native-fs:import-file', id, new Uint8Array(await file.arrayBuffer()))
  },
  getUrl: (id: string, mimeType: string) =>
    `hhc-media://file/${encodeURIComponent(id)}?type=${encodeURIComponent(mimeType)}`,
  exists: (id: string) => typedInvoke('native-fs:file-exists', id),
  delete: (id: string) => typedInvoke('native-fs:delete-file', id)
}

const videoPosterApi = {
  getInfo: () => typedInvoke('video-poster:get-info'),
  generate: (request: IpcInvokeMap['video-poster:generate']['args'][0]) =>
    typedInvoke('video-poster:generate', request)
}

const projectionVlcApi = {
  getInfo: () => typedInvoke('projection-vlc:get-info'),
  start: (request: IpcInvokeMap['projection-vlc:start']['args'][0]) =>
    typedInvoke('projection-vlc:start', request),
  control: (command: IpcInvokeMap['projection-vlc:control']['args'][0]) =>
    typedInvoke('projection-vlc:control', command),
  stop: (request: IpcInvokeMap['projection-vlc:stop']['args'][0]) =>
    typedInvoke('projection-vlc:stop', request),
  onFailure: (callback: (failure: IpcMainToRendererMap['projection-vlc:failure'][0]) => void) =>
    typedOn('projection-vlc:failure', callback),
  onStarted: (callback: (generation: number, itemId: string) => void) =>
    typedOn('projection-vlc:started', callback)
}

const localSyncApi = {
  selectFolder: () => typedInvoke('local-sync:select-folder'),
  listFolders: () => typedInvoke('local-sync:list-folders'),
  scanFolder: (connectionId: string) => typedInvoke('local-sync:scan-folder', connectionId),
  importFile: (request: IpcInvokeMap['local-sync:import-file']['args'][0]) =>
    typedInvoke('local-sync:import-file', request),
  startWatch: (connectionId: string) => typedInvoke('local-sync:start-watch', connectionId),
  getWatchStatus: (connectionId: string) =>
    typedInvoke('local-sync:get-watch-status', connectionId),
  stopWatch: (connectionId: string) => typedInvoke('local-sync:stop-watch', connectionId),
  disconnectFolder: (connectionId: string) =>
    typedInvoke('local-sync:disconnect-folder', connectionId)
}

const oneDriveApi = {
  getCredentialStatus: (connectionId: string) =>
    typedInvoke('onedrive:get-credential-status', connectionId),
  getAccessToken: (request: IpcInvokeMap['onedrive:get-access-token']['args'][0]) =>
    typedInvoke('onedrive:get-access-token', request),
  completeAuth: (request: IpcInvokeMap['onedrive:complete-auth']['args'][0]) =>
    typedInvoke('onedrive:complete-auth', request),
  deleteCredentials: (connectionId: string) =>
    typedInvoke('onedrive:delete-credentials', connectionId),
  getAuthRedirectUri: () => typedInvoke('onedrive:get-auth-redirect-uri'),
  waitAuthCallback: (expectedState?: string) =>
    typedInvoke('onedrive:wait-auth-callback', expectedState),
  downloadFile: (request: IpcInvokeMap['onedrive:download-file']['args'][0]) =>
    typedInvoke('onedrive:download-file', request),
  onDownloadProgress: (
    callback: (data: IpcMainToRendererMap['onedrive:download-progress'][0]) => void
  ) => typedOn('onedrive:download-progress', callback)
}

const hhcAuthApi = {
  begin: () => typedInvoke('hhc-auth:begin'),
  cancel: () => typedInvoke('hhc-auth:cancel'),
  getAccessToken: () => typedInvoke('hhc-auth:get-access-token'),
  refreshAccessToken: () => typedInvoke('hhc-auth:refresh-access-token'),
  getSession: () => typedInvoke('hhc-auth:get-session'),
  signOut: () => typedInvoke('hhc-auth:sign-out'),
  onSessionChanged: (
    callback: (session: IpcMainToRendererMap['hhc-auth:session-changed'][0]) => void
  ) => typedOn('hhc-auth:session-changed', callback)
}

const personalCloudApi: PersonalNativeApi = {
  ensureSpace: (input) => typedInvoke('personal-cloud:ensureSpace', input),
  getUsage: (input) => typedInvoke('personal-cloud:getUsage', input),
  getChanges: (input) => typedInvoke('personal-cloud:getChanges', input),
  createUpload: (input) => typedInvoke('personal-cloud:createUpload', input),
  getUpload: (input) => typedInvoke('personal-cloud:getUpload', input),
  uploadSnapshot: (input) => typedInvoke('personal-cloud:uploadSnapshot', input),
  completeUpload: (input) => typedInvoke('personal-cloud:completeUpload', input),
  mutate: (input) => typedInvoke('personal-cloud:mutate', input),
  purgeTrash: (input) => typedInvoke('personal-cloud:purgeTrash', input),
  downloadSnapshot: (input) => typedInvoke('personal-cloud:downloadSnapshot', input),
  cancel: (input) => typedInvoke('personal-cloud:cancel', input)
}

const hhcAssetsApi = {
  listCollections: (cursor?: string) => typedInvoke('hhc-assets:list-collections', cursor),
  getCollectionChanges: (request: IpcInvokeMap['hhc-assets:get-collection-changes']['args'][0]) =>
    typedInvoke('hhc-assets:get-collection-changes', request),
  getCollectionItem: (request: IpcInvokeMap['hhc-assets:get-collection-item']['args'][0]) =>
    typedInvoke('hhc-assets:get-collection-item', request),
  issueContentTicket: (request: IpcInvokeMap['hhc-assets:issue-content-ticket']['args'][0]) =>
    typedInvoke('hhc-assets:issue-content-ticket', request),
  recordSyncReceipt: (receipt: IpcInvokeMap['hhc-assets:record-sync-receipt']['args'][0]) =>
    typedInvoke('hhc-assets:record-sync-receipt', receipt),
  downloadFile: (request: IpcInvokeMap['hhc-assets:download-file']['args'][0]) =>
    typedInvoke('hhc-assets:download-file', request),
  cancelDownload: (targetFileId: string) => typedInvoke('hhc-assets:cancel-download', targetFileId),
  createContentLease: (request: IpcInvokeMap['hhc-assets:create-content-lease']['args'][0]) =>
    typedInvoke('hhc-assets:create-content-lease', request),
  releaseContentLease: (leaseId: string) =>
    typedInvoke('hhc-assets:release-content-lease', leaseId),
  clearContentLeases: () => typedInvoke('hhc-assets:clear-content-leases')
}

const lanRemoteApi = {
  start: (options: IpcInvokeMap['lan-remote:start']['args'][0]) =>
    typedInvoke('lan-remote:start', options),
  stop: () => typedInvoke('lan-remote:stop'),
  getStatus: () => typedInvoke('lan-remote:get-status'),
  createPairing: (deviceName: string) => typedInvoke('lan-remote:create-pairing', deviceName),
  publishState: (snapshot: IpcInvokeMap['lan-remote:publish-state']['args'][0]) =>
    typedInvoke('lan-remote:publish-state', snapshot),
  publishAck: (ack: IpcInvokeMap['lan-remote:publish-ack']['args'][0]) =>
    typedInvoke('lan-remote:publish-ack', ack),
  onCommand: (callback: (command: IpcMainToRendererMap['lan-remote:command'][0]) => void) =>
    typedOn('lan-remote:command', callback)
}

const api = {
  projection: projectionApi,
  theme: themeApi,
  timer: timerApi,
  bible: bibleApi,
  app: appApi,
  update: updateApi,
  speech: speechApi,
  nativeFs: nativeFsApi,
  videoPoster: videoPosterApi,
  projectionVlc: projectionVlcApi,
  localSync: localSyncApi,
  oneDrive: oneDriveApi,
  hhcAuth: hhcAuthApi,
  hhcAssets: hhcAssetsApi,
  personalCloud: personalCloudApi,
  lanRemote: lanRemoteApi
}

try {
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error('Failed to expose API via contextBridge:', error)
}
