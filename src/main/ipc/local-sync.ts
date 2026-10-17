import { app, dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs, watch as watchFs, type FSWatcher } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import type {
  LocalSyncConnectionInfo,
  LocalSyncImportFileRequest,
  LocalSyncRemoteItem,
  LocalSyncWatchStatus
} from '../../shared/ipc-channels'
import { isValidNativeFileId } from '../../shared/native-media'
import type { WindowManager } from '../windowManager'
import { getNativeFilePath } from '../lib/native-storage'
import { isMainWindow } from './validate'
import { isIgnoredSystemPath } from '../../shared/file-ignore-policy'
import { mutateVideoSource } from './video-remux'

interface StoredLocalSyncConnection extends LocalSyncConnectionInfo {
  rootPath: string
}

interface LocalSyncDirent {
  name: string
  isDirectory: () => boolean
  isFile: () => boolean
  isSymbolicLink: () => boolean
}

interface LocalSyncWatchRecord {
  watcher: FSWatcher | null
  status: LocalSyncWatchStatus
  debounceTimer: NodeJS.Timeout | null
}

const CONFIG_FILE_NAME = 'local-sync-connections.json'
const MAX_SCAN_ITEMS = 10_000
const WATCH_DEBOUNCE_MS = 500
const CONNECTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const watchRecords = new Map<string, LocalSyncWatchRecord>()

function getConfigPath(): string {
  return join(app.getPath('userData'), CONFIG_FILE_NAME)
}

function toInfo(connection: StoredLocalSyncConnection): LocalSyncConnectionInfo {
  return {
    id: connection.id,
    displayName: connection.displayName,
    rootName: connection.rootName,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt
  }
}

async function readConnections(): Promise<StoredLocalSyncConnection[]> {
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf8')
    const parsed = JSON.parse(raw) as StoredLocalSyncConnection[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (connection) =>
        typeof connection.id === 'string' &&
        isValidConnectionId(connection.id) &&
        typeof connection.rootPath === 'string' &&
        typeof connection.displayName === 'string'
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    return []
  }
}

async function writeConnections(connections: StoredLocalSyncConnection[]): Promise<void> {
  const configPath = getConfigPath()
  const temporaryPath = `${configPath}.${process.pid}.tmp`
  await fs.mkdir(dirname(configPath), { recursive: true })
  await fs.writeFile(temporaryPath, JSON.stringify(connections, null, 2), 'utf8')
  await fs.rename(temporaryPath, configPath)
}

function isValidConnectionId(value: string): boolean {
  return CONNECTION_ID_PATTERN.test(value)
}

function isSameOrNested(candidate: string, existing: string): boolean {
  const rel = relative(existing, candidate)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function isSensitiveDirectory(candidate: string): boolean {
  const root = resolve('/')
  const home = resolve(app.getPath('home'))
  const sensitiveSubtrees = [resolve(app.getPath('userData')), resolve(app.getPath('temp'))]
  return (
    candidate === root ||
    candidate === home ||
    sensitiveSubtrees.some((dir) => candidate === dir || isSameOrNested(candidate, dir))
  )
}

async function validateSelectedDirectory(
  selectedPath: string,
  existing: StoredLocalSyncConnection[]
): Promise<string> {
  if (!isAbsolute(selectedPath)) throw new Error('Local sync directory must be absolute')
  const rootPath = await fs.realpath(selectedPath)
  const stat = await fs.stat(rootPath)
  if (!stat.isDirectory()) throw new Error('Local sync selection is not a directory')
  if (isSensitiveDirectory(rootPath)) throw new Error('Local sync directory is not allowed')

  for (const connection of existing) {
    if (
      isSameOrNested(rootPath, connection.rootPath) ||
      isSameOrNested(connection.rootPath, rootPath)
    ) {
      throw new Error('Local sync directory overlaps an existing connection')
    }
  }
  return rootPath
}

async function validateConnectedDirectory(rootPath: string): Promise<void> {
  const stat = await fs.stat(rootPath)
  if (!stat.isDirectory()) throw new Error('Local sync directory is unavailable')
}

function remoteIdForRelativePath(relativePath: string): string {
  return Buffer.from(relativePath || '.').toString('base64url')
}

function relativePathForRemoteId(remoteItemId: string): string {
  let decoded = ''
  try {
    decoded = Buffer.from(remoteItemId, 'base64url').toString('utf8')
  } catch {
    throw new Error('Invalid local sync remote item id')
  }
  if (!decoded || decoded === '.' || isAbsolute(decoded)) {
    throw new Error('Invalid local sync remote item id')
  }
  const parts = decoded.split(/[\\/]/)
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid local sync remote item id')
  }
  return decoded
}

function isRecoverableScanError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM' || code === 'ENOENT' || code === 'ENOTDIR'
}

function sourceCreatedAtFromStat(stat: {
  birthtimeMs?: number
  mtimeMs?: number
}): number | undefined {
  if (
    typeof stat.birthtimeMs === 'number' &&
    Number.isFinite(stat.birthtimeMs) &&
    stat.birthtimeMs > 0
  ) {
    return stat.birthtimeMs
  }
  if (typeof stat.mtimeMs === 'number' && Number.isFinite(stat.mtimeMs) && stat.mtimeMs > 0) {
    return stat.mtimeMs
  }
  return undefined
}

function createWatchStatus(
  connectionId: string,
  state: LocalSyncWatchStatus['state'],
  reason?: LocalSyncWatchStatus['reason']
): LocalSyncWatchStatus {
  return {
    connectionId,
    state,
    ...(reason && { reason }),
    updatedAt: Date.now()
  }
}

function closeWatchRecord(connectionId: string): void {
  const record = watchRecords.get(connectionId)
  if (!record) return
  if (record.debounceTimer) clearTimeout(record.debounceTimer)
  record.watcher?.close()
  watchRecords.delete(connectionId)
}

function getWatchStatus(connectionId: string): LocalSyncWatchStatus {
  return watchRecords.get(connectionId)?.status ?? createWatchStatus(connectionId, 'idle')
}

function scheduleWatchRescan(
  connectionId: string,
  reason: Extract<LocalSyncWatchStatus['reason'], 'change' | 'rename'>
): void {
  const record = watchRecords.get(connectionId)
  if (!record) return
  if (record.debounceTimer) clearTimeout(record.debounceTimer)
  record.debounceTimer = setTimeout(() => {
    const latest = watchRecords.get(connectionId)
    if (!latest) return
    latest.debounceTimer = null
    latest.status = createWatchStatus(connectionId, 'rescan-needed', reason)
  }, WATCH_DEBOUNCE_MS)
}

function markWatchRescanOverflow(connectionId: string): void {
  const record = watchRecords.get(connectionId)
  if (!record) return
  if (record.debounceTimer) {
    clearTimeout(record.debounceTimer)
    record.debounceTimer = null
  }
  record.status = createWatchStatus(connectionId, 'overflow-rescan', 'overflow')
}

function markWatchUnavailable(connectionId: string): void {
  const record = watchRecords.get(connectionId)
  if (!record) return
  if (record.debounceTimer) {
    clearTimeout(record.debounceTimer)
    record.debounceTimer = null
  }
  record.status = createWatchStatus(connectionId, 'unavailable', 'unavailable')
}

function clearWatchRescanStatus(connectionId: string): void {
  const record = watchRecords.get(connectionId)
  if (!record) return
  if (record.status.state === 'rescan-needed' || record.status.state === 'overflow-rescan') {
    record.status = createWatchStatus(connectionId, record.watcher ? 'watching' : 'idle')
  }
}

async function findConnection(connectionId: string): Promise<StoredLocalSyncConnection> {
  const connection = (await readConnections()).find((candidate) => candidate.id === connectionId)
  if (!connection) throw new Error('Local sync connection not found')
  return connection
}

function resolveConnectedFilePath(rootPath: string, remoteItemId: string): string {
  const relativePath = relativePathForRemoteId(remoteItemId)
  const filePath = resolve(rootPath, relativePath)
  if (!isSameOrNested(filePath, rootPath)) {
    throw new Error('Local sync file path escapes connected directory')
  }
  return filePath
}

function isLocalSyncImportRequest(value: unknown): value is LocalSyncImportFileRequest {
  if (typeof value !== 'object' || value === null) return false
  const request = value as Partial<LocalSyncImportFileRequest>
  return (
    typeof request.connectionId === 'string' &&
    isValidConnectionId(request.connectionId) &&
    typeof request.remoteItemId === 'string' &&
    typeof request.targetFileId === 'string' &&
    isValidNativeFileId(request.targetFileId)
  )
}

async function scanDirectory(
  rootPath: string,
  currentPath = rootPath,
  parentRemoteItemId: string | null = null,
  items: LocalSyncRemoteItem[] = []
): Promise<LocalSyncRemoteItem[]> {
  if (items.length >= MAX_SCAN_ITEMS) return items
  let entries: LocalSyncDirent[]
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true })
  } catch (error) {
    if (currentPath !== rootPath && isRecoverableScanError(error)) return items
    throw error
  }
  for (const entry of entries) {
    if (items.length >= MAX_SCAN_ITEMS) break
    if (entry.isSymbolicLink()) continue
    const fullPath = join(currentPath, entry.name)
    const relativePath = relative(rootPath, fullPath)
    if (isIgnoredSystemPath(relativePath)) continue
    const remoteItemId = remoteIdForRelativePath(relativePath)
    if (entry.isDirectory()) {
      let sourceCreatedAt: number | undefined
      try {
        sourceCreatedAt = sourceCreatedAtFromStat(await fs.stat(fullPath))
      } catch (error) {
        if (!isRecoverableScanError(error)) throw error
      }
      items.push({
        remoteItemId,
        parentRemoteItemId,
        kind: 'folder',
        name: entry.name,
        ...(sourceCreatedAt === undefined ? {} : { sourceCreatedAt })
      })
      await scanDirectory(rootPath, fullPath, remoteItemId, items)
    } else if (entry.isFile()) {
      let stat: Awaited<ReturnType<typeof fs.stat>>
      try {
        stat = await fs.stat(fullPath)
      } catch (error) {
        if (isRecoverableScanError(error)) continue
        throw error
      }
      const sourceCreatedAt = sourceCreatedAtFromStat(stat)
      items.push({
        remoteItemId,
        parentRemoteItemId,
        kind: 'file',
        name: entry.name,
        size: stat.size,
        etag: `${stat.mtimeMs}:${stat.size}`,
        ...(sourceCreatedAt === undefined ? {} : { sourceCreatedAt })
      })
    }
  }
  return items
}

export function registerLocalSyncHandlers(wm: WindowManager): void {
  ipcMain.handle(
    'local-sync:select-folder',
    async (event): Promise<LocalSyncConnectionInfo | null> => {
      if (!isMainWindow(wm, event)) throw new Error('Unauthorized local sync access')
      const result = await dialog.showOpenDialog({
        title: 'Select local folder to sync',
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null

      const connections = await readConnections()
      const rootPath = await validateSelectedDirectory(result.filePaths[0], connections)
      const now = Date.now()
      const connection: StoredLocalSyncConnection = {
        id: randomUUID(),
        rootPath,
        rootName: basename(rootPath),
        displayName: basename(rootPath),
        createdAt: now,
        updatedAt: now
      }
      await writeConnections([...connections, connection])
      return toInfo(connection)
    }
  )

  ipcMain.handle('local-sync:list-folders', async (event): Promise<LocalSyncConnectionInfo[]> => {
    if (!isMainWindow(wm, event)) throw new Error('Unauthorized local sync access')
    return (await readConnections()).map(toInfo)
  })

  ipcMain.handle(
    'local-sync:scan-folder',
    async (event, connectionId: unknown): Promise<LocalSyncRemoteItem[]> => {
      if (!isMainWindow(wm, event)) throw new Error('Unauthorized local sync access')
      if (typeof connectionId !== 'string' || !isValidConnectionId(connectionId)) {
        throw new Error('Invalid local sync connection id')
      }
      const connection = await findConnection(connectionId)
      await validateConnectedDirectory(connection.rootPath)
      const items = await scanDirectory(connection.rootPath)
      clearWatchRescanStatus(connectionId)
      return items
    }
  )

  ipcMain.handle(
    'local-sync:import-file',
    async (event, request: unknown): Promise<{ size: number }> => {
      if (!isMainWindow(wm, event)) throw new Error('Unauthorized local sync access')
      if (!isLocalSyncImportRequest(request)) throw new Error('Invalid local sync import request')

      const connection = await findConnection(request.connectionId)
      await validateConnectedDirectory(connection.rootPath)
      const sourcePath = resolveConnectedFilePath(connection.rootPath, request.remoteItemId)
      const sourceStat = await fs.stat(sourcePath)
      if (!sourceStat.isFile()) throw new Error('Local sync source is not a file')

      const destinationPath = getNativeFilePath(request.targetFileId)
      const destinationDir = dirname(destinationPath)
      await fs.mkdir(destinationDir, { recursive: true })
      const temporaryPath = join(destinationDir, `.${request.targetFileId}.${process.pid}.tmp`)
      return mutateVideoSource(request.targetFileId, async () => {
        try {
          await fs.copyFile(sourcePath, temporaryPath)
          const copiedStat = await fs.stat(temporaryPath)
          if (!copiedStat.isFile() || copiedStat.size !== sourceStat.size) {
            throw new Error('Local sync file copy verification failed')
          }
          await fs.rename(temporaryPath, destinationPath)
          return { size: copiedStat.size }
        } catch (error) {
          await fs.unlink(temporaryPath).catch(() => undefined)
          throw error
        }
      })
    }
  )

  ipcMain.handle(
    'local-sync:start-watch',
    async (event, connectionId: unknown): Promise<LocalSyncWatchStatus> => {
      if (!isMainWindow(wm, event)) throw new Error('Unauthorized local sync access')
      if (typeof connectionId !== 'string' || !isValidConnectionId(connectionId)) {
        throw new Error('Invalid local sync connection id')
      }
      const connection = await findConnection(connectionId)
      await validateConnectedDirectory(connection.rootPath)
      closeWatchRecord(connectionId)
      const status = createWatchStatus(connectionId, 'watching')
      const record: LocalSyncWatchRecord = {
        watcher: null,
        status,
        debounceTimer: null
      }
      watchRecords.set(connectionId, record)
      let watcher: FSWatcher
      try {
        watcher = watchFs(connection.rootPath, { recursive: true }, (eventType: string) => {
          scheduleWatchRescan(connectionId, eventType === 'rename' ? 'rename' : 'change')
        })
      } catch {
        watchRecords.set(connectionId, {
          watcher: null,
          status: createWatchStatus(connectionId, 'unavailable', 'unavailable'),
          debounceTimer: null
        })
        return getWatchStatus(connectionId)
      }
      watcher.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOSPC' || error.code === 'ERR_FS_WATCHER_LIMIT') {
          markWatchRescanOverflow(connectionId)
          return
        }
        markWatchUnavailable(connectionId)
      })
      record.watcher = watcher
      return record.status
    }
  )

  ipcMain.handle(
    'local-sync:get-watch-status',
    async (event, connectionId: unknown): Promise<LocalSyncWatchStatus> => {
      if (!isMainWindow(wm, event)) throw new Error('Unauthorized local sync access')
      if (typeof connectionId !== 'string' || !isValidConnectionId(connectionId)) {
        throw new Error('Invalid local sync connection id')
      }
      return getWatchStatus(connectionId)
    }
  )

  ipcMain.handle(
    'local-sync:stop-watch',
    async (event, connectionId: unknown): Promise<LocalSyncWatchStatus> => {
      if (!isMainWindow(wm, event)) throw new Error('Unauthorized local sync access')
      if (typeof connectionId !== 'string' || !isValidConnectionId(connectionId)) {
        throw new Error('Invalid local sync connection id')
      }
      closeWatchRecord(connectionId)
      return createWatchStatus(connectionId, 'idle')
    }
  )

  ipcMain.handle(
    'local-sync:disconnect-folder',
    async (event, connectionId: unknown): Promise<void> => {
      if (!isMainWindow(wm, event)) throw new Error('Unauthorized local sync access')
      if (typeof connectionId !== 'string' || !isValidConnectionId(connectionId)) {
        throw new Error('Invalid local sync connection id')
      }
      const connections = await readConnections()
      closeWatchRecord(connectionId)
      await writeConnections(connections.filter((connection) => connection.id !== connectionId))
    }
  )
}
