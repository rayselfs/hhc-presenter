import { openFileExplorerDB } from './file-explorer-db'
import { getBlobId } from './blob-identity'
import { assertPersonalUploadPolicy, PersonalUploadPolicyError } from './personal-upload-policy'
import { toast } from '@heroui/react/toast'
import {
  addFileItemToStore,
  createExplorerFolder,
  useFileExplorerStore
} from '@renderer/stores/file-explorer'
import { generateThumbnail, yieldToMain } from '@renderer/lib/thumbnail-generator'
import { saveThumbnail } from '@renderer/lib/thumbnail-db'
import { isWeb } from '@renderer/lib/env'
import {
  canGenerateMediaThumbnail,
  resolveMediaCapability,
  type MediaKind,
  type MediaPlatform
} from '@renderer/lib/media-capabilities'
import { classifyMediaImport, type MediaImportDecision } from '@renderer/lib/media-import-policy'
import { resolveUniqueName } from '@renderer/lib/file-naming'
import { enqueueVideoPosterJob } from '@renderer/lib/video-poster-jobs'
import { MAX_FILE_SIZE_WEB } from '@renderer/lib/media-limits'
import { isIgnoredSystemFile } from '@shared/file-ignore-policy'
import i18n from '@renderer/i18n'
import { enqueueCoverThumbnailJob } from '@renderer/lib/cover-thumbnail-jobs'
import { ensurePdfPageJob } from '@renderer/lib/pdf-page-jobs'

export { MAX_FILE_SIZE_WEB }

export function reportUploadError(name: string, error: unknown): void {
  const reason =
    error instanceof PersonalUploadPolicyError
      ? i18n.t(`personalCloud.uploadErrors.${error.code}`)
      : error instanceof Error
        ? error.message
        : i18n.t('personalCloud.failed')
  toast.danger(i18n.t('fileExplorer.uploadFailed', { name, reason }))
}

export async function importFromFileInput(
  input: HTMLInputElement,
  readOnly: boolean,
  upload: (files: File[]) => Promise<number>
): Promise<void> {
  const files = Array.from(input.files ?? [])
  try {
    if (!readOnly && files.length) await upload(files)
  } catch (error) {
    reportUploadError(files.map((file) => file.name).join(', '), error)
  } finally {
    input.value = ''
  }
}

type AcceptedMediaImportDecision = Extract<MediaImportDecision, { action: 'accept' }>

export interface UploadCandidate {
  file: File
  classification: AcceptedMediaImportDecision
}

interface UploadDestination extends UploadCandidate {
  parentId: string
}

function createSemaphore(limit: number): { acquire(): Promise<() => void> } {
  let active = 0
  const queue: Array<() => void> = []
  return {
    acquire(): Promise<() => void> {
      return new Promise((resolve) => {
        const tryAcquire = (): void => {
          if (active < limit) {
            active++
            resolve(() => {
              active--
              queue.shift()?.()
            })
          } else {
            queue.push(tryAcquire)
          }
        }
        tryAcquire()
      })
    }
  }
}

const UPLOAD_CONCURRENCY = 3
const uploadSemaphore = createSemaphore(UPLOAD_CONCURRENCY)

function createRendererBudget(maxWorkMs = 8): { yieldIfNeeded(): Promise<void> } {
  let startedAt = performance.now()
  return {
    async yieldIfNeeded(): Promise<void> {
      if (performance.now() - startedAt < maxWorkMs) return
      await yieldToMain()
      startedAt = performance.now()
    }
  }
}

export function getUploadMediaPlatform(): MediaPlatform {
  return isWeb() ? 'web' : 'electron'
}

async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = []
  const readBatch = (): Promise<void> =>
    new Promise((resolve, reject) => {
      reader.readEntries((entries) => {
        if (entries.length === 0) {
          resolve()
        } else {
          all.push(...entries)
          readBatch().then(resolve, reject)
        }
      }, reject)
    })
  await readBatch()
  return all
}

async function collectFromEntry(
  entry: FileSystemEntry,
  prefix = '',
  budget = createRendererBudget()
): Promise<{ file: File; relativePath: string }[]> {
  await budget.yieldIfNeeded()
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      ;(entry as FileSystemFileEntry).file(resolve, reject)
    })
    return [{ file, relativePath: prefix ? `${prefix}/${entry.name}` : entry.name }]
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    const children = await readAllEntries(reader)
    const newPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
    const nested: { file: File; relativePath: string }[] = []
    for (const child of children) {
      nested.push(...(await collectFromEntry(child, newPrefix, budget)))
    }
    return nested
  }
  return []
}

export function isSupportedFile(file: File): boolean {
  return classifyMediaImport(file, getUploadMediaPlatform()).action === 'accept'
}

export function canGenerateThumbnail(mimeType: string, fileName?: string): boolean {
  return canGenerateMediaThumbnail(resolveMediaCapability({ mimeType, fileName }))
}

async function hasWebStorageCapacity(files: File[]): Promise<boolean> {
  if (!isWeb() || !navigator.storage?.estimate) return true

  try {
    const { quota, usage } = await navigator.storage.estimate()
    if (quota === undefined) return true
    const available = Math.max(0, quota - (usage ?? 0))
    return files.reduce((total, file) => total + file.size, 0) <= available
  } catch {
    return true
  }
}

async function prepareUploadCandidates(
  files: File[],
  parentId?: string
): Promise<UploadCandidate[]> {
  const personal = parentId
    ? (await (await openFileExplorerDB()).get('folder-records', parentId))?.personalOwnerId
    : undefined
  const candidates: UploadCandidate[] = []
  const platform = getUploadMediaPlatform()
  const budget = createRendererBudget()
  let unsupportedCount = 0
  for (const file of files) {
    await budget.yieldIfNeeded()
    if (isIgnoredSystemFile(file)) continue
    const classification = classifyMediaImport(file, platform)
    if (classification.action === 'skip') {
      if (classification.reason === 'app-unsupported') unsupportedCount++
      continue
    }
    if (classification.action === 'platform-unsupported') {
      unsupportedCount++
      continue
    }
    if (personal) {
      try {
        assertPersonalUploadPolicy(file.size, classification.mimeType)
      } catch (error) {
        reportUploadError(file.name, error)
        continue
      }
    }
    if (isWeb() && file.size > MAX_FILE_SIZE_WEB) {
      toast.danger(i18n.t('fileExplorer.uploadFileTooLarge', { name: file.name }))
      continue
    }
    candidates.push({ file, classification })
  }

  if (unsupportedCount > 0) {
    toast.warning(i18n.t('fileExplorer.uploadSkippedUnsupported', { count: unsupportedCount }))
  }

  if (!(await hasWebStorageCapacity(candidates.map((candidate) => candidate.file)))) {
    toast.danger(i18n.t('fileExplorer.uploadInsufficientBrowserStorage'))
    return []
  }
  return candidates
}

async function enrichUploadedFile(
  id: string,
  sourceBlobId: string,
  file: File,
  classification: AcceptedMediaImportDecision
): Promise<void> {
  try {
    if (canGenerateThumbnail(classification.mimeType, file.name)) {
      if (classification.kind === 'video' && isWeb()) {
        const dataUrl = await generateThumbnail(file, classification.mimeType)
        if (typeof dataUrl === 'string') await saveThumbnail(id, dataUrl)
        window.dispatchEvent(
          new CustomEvent('hhc:thumbnail-ready', {
            detail: { itemId: id, dataUrl: typeof dataUrl === 'string' ? dataUrl : null }
          })
        )
      } else if (classification.kind !== 'video') {
        await enqueueCoverThumbnailJob({
          sourceBlobId,
          itemId: id,
          mimeType: classification.mimeType
        })
      }
    }

    if (classification.kind === 'video' && !isWeb()) {
      await enqueueVideoPosterJob({ sourceBlobId, itemId: id })
    }

    if (classification.kind === 'pdf') {
      await ensurePdfPageJob({ sourceBlobId, itemId: id, priority: -1 })
    }
  } catch (error) {
    console.warn('[media-enrichment] Failed to enqueue upload enrichment', { blobId: id, error })
  }
}

async function uploadPreparedFiles(destinations: UploadDestination[]): Promise<number> {
  let uploadedCount = 0
  let nextIndex = 0
  const uploadNext = async (): Promise<void> => {
    while (nextIndex < destinations.length) {
      const { file, classification, parentId } = destinations[nextIndex++]
      const release = await uploadSemaphore.acquire()
      let id: string | undefined
      try {
        id = await addFileItemToStore(file, parentId, classification.mimeType)
        uploadedCount++
      } catch (error) {
        reportUploadError(file.name, error)
      } finally {
        release()
      }
      await yieldToMain()
      if (id) {
        try {
          const item = await (await openFileExplorerDB()).get('folder-items', id)
          if (item?.type === 'file')
            void enrichUploadedFile(id, getBlobId(item), file, classification)
        } catch (error) {
          console.warn('[media-enrichment] Failed to read persisted upload', { itemId: id, error })
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, destinations.length) }, uploadNext)
  )
  return uploadedCount
}

export async function uploadFiles(files: File[], parentId: string): Promise<number> {
  const candidates = await prepareUploadCandidates(files, parentId)
  const destinations: UploadDestination[] = []
  const budget = createRendererBudget()
  for (const candidate of candidates) {
    destinations.push({ ...candidate, parentId })
    await budget.yieldIfNeeded()
  }
  return uploadPreparedFiles(destinations)
}

export async function prepareUploadFilesForKind(
  files: File[],
  kind: Exclude<MediaKind, 'document'>
): Promise<UploadCandidate[]> {
  const candidates = await prepareUploadCandidates(files)
  return candidates.filter((candidate) => candidate.classification.kind === kind)
}

export async function uploadFilesForKind(
  files: File[],
  parentId: string,
  kind: Exclude<MediaKind, 'document'>
): Promise<number> {
  const candidates = (await prepareUploadCandidates(files, parentId)).filter(
    (candidate) => candidate.classification.kind === kind
  )
  const destinations: UploadDestination[] = []
  const budget = createRendererBudget()
  for (const candidate of candidates) {
    destinations.push({ ...candidate, parentId })
    await budget.yieldIfNeeded()
  }
  return uploadPreparedFiles(destinations)
}

export async function uploadFolderFiles(
  allFiles: File[],
  currentFolderId: string,
  addFolder: (name: string, parentId: string) => string | Promise<string>
): Promise<number> {
  const candidates = await prepareUploadCandidates(allFiles, currentFolderId)
  if (candidates.length === 0) return 0

  const pathToFolderId = new Map<string, string>()
  const usedNamesByParent = new Map<string, Set<string>>()
  const store = useFileExplorerStore.getState()

  function reserveFolderName(parentId: string, requestedName: string): string {
    const usedNames =
      usedNamesByParent.get(parentId) ??
      new Set(store.getChildFolders(parentId).map((folder) => folder.name))
    const uniqueName = resolveUniqueName(requestedName, usedNames)
    usedNames.add(uniqueName)
    usedNamesByParent.set(parentId, usedNames)
    return uniqueName
  }

  for (const { file } of candidates) {
    const parts = file.webkitRelativePath.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      const folderPath = parts.slice(0, depth).join('/')
      if (!pathToFolderId.has(folderPath)) {
        const parentPath = parts.slice(0, depth - 1).join('/')
        const parentId =
          depth === 1 ? currentFolderId : (pathToFolderId.get(parentPath) ?? currentFolderId)
        const id = await addFolder(reserveFolderName(parentId, parts[depth - 1]), parentId)
        if (!id) throw new Error('Folder creation failed')
        await yieldToMain()
        pathToFolderId.set(folderPath, id)
      }
    }
  }

  const destinations: UploadDestination[] = []
  const budget = createRendererBudget()
  for (const candidate of candidates) {
    const parts = candidate.file.webkitRelativePath.split('/')
    const folderPath = parts.slice(0, parts.length - 1).join('/')
    destinations.push({
      ...candidate,
      parentId: pathToFolderId.get(folderPath) ?? currentFolderId
    })
    await budget.yieldIfNeeded()
  }
  return uploadPreparedFiles(destinations)
}

export async function uploadFolderFilesFromStore(
  allFiles: File[],
  currentFolderId: string
): Promise<number> {
  return uploadFolderFiles(allFiles, currentFolderId, createExplorerFolder)
}

export async function uploadFromDataTransfer(
  items: DataTransferItemList,
  targetFolderId: string
): Promise<number> {
  const entries: FileSystemEntry[] = []
  for (let index = 0; index < items.length; index++) {
    const entry = items[index].webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }

  const filesWithPaths = (await Promise.all(entries.map((entry) => collectFromEntry(entry)))).flat()
  const candidates = await prepareUploadCandidates(
    filesWithPaths.map(({ file }) => file),
    targetFolderId
  )
  if (candidates.length === 0) return 0

  const relativePaths = new Map(
    filesWithPaths.map(({ file, relativePath }) => [file, relativePath])
  )
  const addFolder = createExplorerFolder
  const store = useFileExplorerStore.getState()
  const usedNamesByParent = new Map<string, Set<string>>()

  function reserveFolderName(parentId: string, requestedName: string): string {
    const usedNames =
      usedNamesByParent.get(parentId) ??
      new Set(store.getChildFolders(parentId).map((folder) => folder.name))
    const uniqueName = resolveUniqueName(requestedName, usedNames)
    usedNames.add(uniqueName)
    usedNamesByParent.set(parentId, usedNames)
    return uniqueName
  }

  const pathToFolderId = new Map<string, string>()

  for (const { file } of candidates) {
    const parts = (relativePaths.get(file) ?? file.name).split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      const folderPath = parts.slice(0, depth).join('/')
      if (!pathToFolderId.has(folderPath)) {
        const parentPath = parts.slice(0, depth - 1).join('/')
        const parentId =
          depth === 1 ? targetFolderId : (pathToFolderId.get(parentPath) ?? targetFolderId)
        const id = await addFolder(reserveFolderName(parentId, parts[depth - 1]), parentId)
        if (!id) throw new Error('Folder creation failed')
        await yieldToMain()
        pathToFolderId.set(folderPath, id)
      }
    }
  }

  const destinations: UploadDestination[] = []
  const budget = createRendererBudget()
  for (const candidate of candidates) {
    const parts = (relativePaths.get(candidate.file) ?? candidate.file.name).split('/')
    const folderPath = parts.slice(0, parts.length - 1).join('/')
    destinations.push({
      ...candidate,
      parentId: folderPath ? (pathToFolderId.get(folderPath) ?? targetFolderId) : targetFolderId
    })
    await budget.yieldIfNeeded()
  }
  return uploadPreparedFiles(destinations)
}
