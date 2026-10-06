import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  importFromFileInput,
  MAX_FILE_SIZE_WEB,
  prepareUploadFilesForKind,
  uploadFiles,
  uploadFolderFiles,
  uploadFromDataTransfer
} from '../upload-utils'

vi.mock('@heroui/react/toast', () => ({
  toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() }
}))

vi.mock('@renderer/stores/file-explorer', () => {
  const store = { getState: vi.fn() }
  return {
    addFileItemToStore: vi.fn(),
    useFileExplorerStore: store,
    createExplorerFolder: (name: string, parentId: string) =>
      store.getState().addFolder(name, parentId)
  }
})

vi.mock('@renderer/lib/thumbnail-generator', () => ({
  generateThumbnail: vi.fn().mockResolvedValue(null),
  yieldToMain: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@renderer/lib/thumbnail-db', () => ({
  getPdfPageThumbs: vi.fn(),
  saveThumbnail: vi.fn(),
  savePdfPageThumbs: vi.fn()
}))

vi.mock('@renderer/lib/file-explorer-db', () => ({
  openFileExplorerDB: async () => ({
    get: async (table: string, id: string) => {
      const state = useFileExplorerStore.getState()
      if (table === 'folder-records') return state.folders?.[id]
      return { ...(state.items?.[id] ?? { id, url: `blob:${id}` }), type: 'file' }
    }
  })
}))

vi.mock('@renderer/lib/env', () => ({
  isWeb: vi.fn()
}))

vi.mock('@renderer/lib/media-metadata', () => ({
  ensureSourceMediaMetadata: vi.fn().mockResolvedValue(null)
}))

vi.mock('@renderer/lib/media-job-queue', () => ({
  MediaJobBlockedError: class MediaJobBlockedError extends Error {},
  mediaJobQueue: {
    registerExecutor: vi.fn(),
    enqueue: vi.fn().mockResolvedValue({ id: 'job-id' })
  }
}))

import { toast } from '@heroui/react/toast'
import { addFileItemToStore } from '@renderer/stores/file-explorer'
import { generateThumbnail } from '@renderer/lib/thumbnail-generator'
import { yieldToMain } from '@renderer/lib/thumbnail-generator'
import { isWeb } from '@renderer/lib/env'
import { mediaJobQueue } from '@renderer/lib/media-job-queue'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { getPdfPageThumbs } from '@renderer/lib/thumbnail-db'
import { ensureSourceMediaMetadata } from '@renderer/lib/media-metadata'
import { ensurePdfPageJob } from '../pdf-page-jobs'
import i18n from '@renderer/i18n'

function makeFile(name: string, size: number, type = 'image/png'): File {
  const file = new File([], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function setRelativePath(file: File, relativePath: string): File {
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  return file
}

function setStorageEstimate(estimate?: StorageEstimate): void {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: estimate ? { estimate: vi.fn().mockResolvedValue(estimate) } : undefined
  })
}

function expectFolderYieldOrder(addFolder: { mock: { invocationCallOrder: number[] } }): void {
  const addFolderCalls = addFolder.mock.invocationCallOrder
  const yieldCalls = vi.mocked(yieldToMain).mock.invocationCallOrder

  expect(addFolderCalls).toHaveLength(3)
  for (let index = 0; index < 3; index++) {
    const nextAdd = addFolderCalls[index + 1] ?? Number.POSITIVE_INFINITY
    expect(yieldCalls.some((order) => order > addFolderCalls[index] && order < nextAdd)).toBe(true)
  }
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  vi.clearAllMocks()
  vi.mocked(addFileItemToStore).mockResolvedValue('mock-id')
  vi.mocked(useFileExplorerStore.getState).mockReturnValue({
    items: { 'mock-id': { id: 'mock-id', url: 'blob:mock-id' } },
    folders: {},
    addFolder: vi.fn(),
    getChildFolders: vi.fn(() => [])
  } as never)
  vi.mocked(mediaJobQueue.enqueue).mockResolvedValue({ id: 'job-id' } as never)
  vi.mocked(getPdfPageThumbs).mockResolvedValue([])
  setStorageEstimate()
})

describe('ensurePdfPageJob', () => {
  it('skips cached pages and enqueues cache misses with the durable dedupe key', async () => {
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.mocked(getPdfPageThumbs)
      .mockResolvedValueOnce(['blob:cached-page'])
      .mockResolvedValueOnce([])

    await ensurePdfPageJob({ sourceBlobId: 'cached-blob', itemId: 'cached-item' })
    await ensurePdfPageJob({ sourceBlobId: 'missing-blob', itemId: 'missing-item' })

    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:cached-page')
    expect(mediaJobQueue.enqueue).toHaveBeenCalledOnce()
    expect(mediaJobQueue.enqueue).toHaveBeenCalledWith({
      type: 'pdf-pages',
      sourceBlobId: 'missing-blob',
      itemId: 'missing-item',
      dedupeKey: 'pdf-pages:missing-blob'
    })
  })
})

describe('uploadFiles web preflight', () => {
  it('skips files over 2 GiB in Web mode', async () => {
    vi.mocked(isWeb).mockReturnValue(true)
    const bigFile = makeFile('big.png', MAX_FILE_SIZE_WEB + 1)

    await expect(uploadFiles([bigFile], 'parent-1')).resolves.toBe(0)

    expect(toast.danger).toHaveBeenCalledWith('File "big.png" exceeds 2GB limit')
    expect(addFileItemToStore).not.toHaveBeenCalled()
  })

  it('accepts files over 2 GiB in Electron mode', async () => {
    vi.mocked(isWeb).mockReturnValue(false)
    const bigFile = makeFile('big.png', MAX_FILE_SIZE_WEB + 1)

    await expect(uploadFiles([bigFile], 'parent-1')).resolves.toBe(1)

    expect(toast.danger).not.toHaveBeenCalled()
    expect(addFileItemToStore).toHaveBeenCalledWith(bigFile, 'parent-1', 'image/png')
  })

  it('rejects a Web batch that clearly exceeds available quota', async () => {
    vi.mocked(isWeb).mockReturnValue(true)
    setStorageEstimate({ quota: 1000, usage: 900 })
    const files = [makeFile('a.png', 60), makeFile('b.png', 60)]

    await expect(uploadFiles(files, 'parent-1')).resolves.toBe(0)

    expect(toast.danger).toHaveBeenCalledWith('The selected files exceed available browser storage')
    expect(addFileItemToStore).not.toHaveBeenCalled()
  })

  it('rejects folder input before creating folders when quota is insufficient', async () => {
    vi.mocked(isWeb).mockReturnValue(true)
    setStorageEstimate({ quota: 1000, usage: 950 })
    const file = setRelativePath(makeFile('slide.png', 100), 'Sunday/slide.png')
    const addFolder = vi.fn()

    await expect(uploadFolderFiles([file], 'root', addFolder)).resolves.toBe(0)

    expect(addFolder).not.toHaveBeenCalled()
    expect(addFileItemToStore).not.toHaveBeenCalled()
  })

  it('auto-renames existing and same-batch folder conflicts', async () => {
    vi.mocked(isWeb).mockReturnValue(false)
    const addFolder = vi.fn((name: string) => `id-${name}`)
    vi.mocked(useFileExplorerStore.getState).mockReturnValue({
      addFolder,
      getChildFolders: vi.fn((parentId: string) =>
        parentId === 'root' ? [{ id: 'existing', name: 'Sunday', parentId: 'root' }] : []
      )
    } as never)
    const files = [
      setRelativePath(makeFile('a.png', 100), 'Sunday/a.png'),
      setRelativePath(makeFile('b.png', 100), 'sunday/b.png')
    ]

    await uploadFolderFiles(files, 'root', addFolder)

    expect(addFolder).toHaveBeenNthCalledWith(1, 'Sunday 2', 'root')
    expect(addFolder).toHaveBeenNthCalledWith(2, 'sunday 3', 'root')
  })

  it('applies the Web size limit to drag-and-drop entries', async () => {
    vi.mocked(isWeb).mockReturnValue(true)
    const file = makeFile('big.png', MAX_FILE_SIZE_WEB + 1)
    const entry = {
      isFile: true,
      isDirectory: false,
      name: file.name,
      file: (resolve: (value: File) => void) => resolve(file)
    }
    const items = {
      0: { webkitGetAsEntry: () => entry },
      length: 1
    } as unknown as DataTransferItemList

    await expect(uploadFromDataTransfer(items, 'root')).resolves.toBe(0)

    expect(addFileItemToStore).not.toHaveBeenCalled()
  })

  it('accepts MKV as a Web video candidate', async () => {
    vi.mocked(isWeb).mockReturnValue(true)
    const file = makeFile('message.mkv', 100, '')

    await expect(uploadFiles([file], 'parent-1')).resolves.toBe(1)

    expect(addFileItemToStore).toHaveBeenCalledWith(file, 'parent-1', 'video/x-matroska')
    expect(generateThumbnail).toHaveBeenCalledWith(file, 'video/x-matroska')
    expect(mediaJobQueue.enqueue).not.toHaveBeenCalled()
  })

  it('warns when unsupported files are skipped', async () => {
    vi.mocked(isWeb).mockReturnValue(true)
    const supported = setRelativePath(makeFile('slide.png', 100), 'Sunday/slide.png')
    const unsupported = setRelativePath(makeFile('notes.txt', 100, ''), 'Sunday/notes.txt')

    await expect(
      uploadFolderFiles(
        [supported, unsupported],
        'root',
        vi.fn(() => 'folder')
      )
    ).resolves.toBe(1)

    expect(toast.warning).toHaveBeenCalledWith('Skipped 1 unsupported file(s)')
  })

  it('does not accept PSD files through generic image MIME fallback', async () => {
    vi.mocked(isWeb).mockReturnValue(true)
    const psd = makeFile('layout.psd', 100, 'image/vnd.adobe.photoshop')

    await expect(uploadFiles([psd], 'parent-1')).resolves.toBe(0)

    expect(addFileItemToStore).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith('Skipped 1 unsupported file(s)')
  })

  it('silently ignores folder system files', async () => {
    vi.mocked(isWeb).mockReturnValue(true)
    const supported = setRelativePath(makeFile('movie.mkv', 100, ''), 'Sunday/movie.mkv')
    const systemFile = setRelativePath(makeFile('.DS_Store', 100, ''), 'Sunday/.DS_Store')
    const addFolder = vi.fn((name: string) => `id-${name}`)

    await expect(uploadFolderFiles([supported, systemFile], 'root', addFolder)).resolves.toBe(1)

    expect(addFileItemToStore).toHaveBeenCalledWith(supported, 'id-Sunday', 'video/x-matroska')
    expect(toast.warning).not.toHaveBeenCalled()
  })
})

describe('folder upload yielding', () => {
  beforeEach(() => {
    vi.mocked(isWeb).mockReturnValue(false)
  })

  it('yields once for each newly created nested folder, not duplicate paths', async () => {
    const addFolder = vi.fn((name: string) => `id-${name}`)
    vi.mocked(useFileExplorerStore.getState).mockReturnValue({
      addFolder,
      getChildFolders: vi.fn(() => [])
    } as never)
    const files = [
      setRelativePath(makeFile('a.png', 100), 'Root/One/a.png'),
      setRelativePath(makeFile('b.png', 100), 'Root/One/b.png'),
      setRelativePath(makeFile('c.png', 100), 'Root/One/c.png'),
      setRelativePath(makeFile('d.png', 100), 'Root/Two/d.png')
    ]

    await uploadFolderFiles(files, 'root', addFolder)

    expect(addFolder).toHaveBeenCalledTimes(3)
    expect(vi.mocked(yieldToMain).mock.calls.length).toBeGreaterThanOrEqual(3)
    expectFolderYieldOrder(addFolder)
  })

  it('yields once for each newly created dragged nested folder, not duplicate paths', async () => {
    const addFolder = vi.fn((name: string) => `id-${name}`)
    vi.mocked(useFileExplorerStore.getState).mockReturnValue({
      addFolder,
      getChildFolders: vi.fn(() => [])
    } as never)
    const fileEntry = (file: File): object => ({
      isFile: true,
      isDirectory: false,
      name: file.name,
      file: (resolve: (value: File) => void) => resolve(file)
    })
    const directoryEntry = (name: string, entries: object[]): object => {
      let read = false
      return {
        isFile: false,
        isDirectory: true,
        name,
        createReader: () => ({
          readEntries: (resolve: (value: object[]) => void) => {
            const batch = read ? [] : entries
            read = true
            resolve(batch)
          }
        })
      }
    }
    const root = directoryEntry('Root', [
      directoryEntry('One', [
        fileEntry(makeFile('a.png', 100)),
        fileEntry(makeFile('b.png', 100)),
        fileEntry(makeFile('c.png', 100))
      ]),
      directoryEntry('Two', [fileEntry(makeFile('d.png', 100))])
    ])
    const items = {
      0: { webkitGetAsEntry: () => root },
      length: 1
    } as unknown as DataTransferItemList

    await uploadFromDataTransfer(items, 'root')

    expect(addFolder).toHaveBeenCalledTimes(3)
    expect(vi.mocked(yieldToMain).mock.calls.length).toBeGreaterThanOrEqual(3)
    expectFolderYieldOrder(addFolder)
  })
})

describe('uploadFiles classification', () => {
  beforeEach(() => {
    vi.mocked(isWeb).mockReturnValue(false)
  })

  it.each([
    ['slides.PDF', 'application/pdf'],
    ['photo.PNG', 'image/png']
  ])('persists canonical MIME for empty-MIME %s', async (name, canonicalMimeType) => {
    const file = makeFile(name, 100, '')

    await uploadFiles([file], 'parent-1')

    expect(addFileItemToStore).toHaveBeenCalledWith(file, 'parent-1', canonicalMimeType)
    expect(mediaJobQueue.enqueue).toHaveBeenCalledWith({
      type: 'cover-thumbnail',
      sourceBlobId: 'mock-id',
      itemId: 'mock-id',
      dedupeKey: 'cover-thumbnail:mock-id'
    })
  })

  it('skips unsupported files', async () => {
    const file = makeFile('notes.txt', 100, '')

    await expect(uploadFiles([file], 'parent-1')).resolves.toBe(0)

    expect(addFileItemToStore).not.toHaveBeenCalled()
  })

  it('prewarms PDF pages at low priority without probing metadata during upload', async () => {
    const file = makeFile('slides.PDF', 100, '')

    await uploadFiles([file], 'parent-1')

    expect(ensureSourceMediaMetadata).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(mediaJobQueue.enqueue).toHaveBeenCalledWith({
        type: 'pdf-pages',
        sourceBlobId: 'mock-id',
        itemId: 'mock-id',
        priority: -1,
        dedupeKey: 'pdf-pages:mock-id'
      })
    )
  })

  it('accepts Electron desktop-video candidates and enqueues one poster job', async () => {
    const file = makeFile('message.MKV', 100, '')

    await expect(uploadFiles([file], 'parent-1')).resolves.toBe(1)

    expect(addFileItemToStore).toHaveBeenCalledWith(file, 'parent-1', 'video/x-matroska')
    await vi.waitFor(() =>
      expect(mediaJobQueue.enqueue).toHaveBeenCalledWith({
        type: 'video-poster',
        sourceBlobId: 'mock-id',
        itemId: 'mock-id',
        dedupeKey: 'video-poster:mock-id'
      })
    )
  })

  it('uses poster jobs for Electron-native videos instead of browser thumbnails', async () => {
    const file = makeFile('movie.MP4', 100, '')

    await expect(uploadFiles([file], 'parent-1')).resolves.toBe(1)

    expect(addFileItemToStore).toHaveBeenCalledWith(file, 'parent-1', 'video/mp4')
    expect(generateThumbnail).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(mediaJobQueue.enqueue).toHaveBeenCalledWith({
        type: 'video-poster',
        sourceBlobId: 'mock-id',
        itemId: 'mock-id',
        dedupeKey: 'video-poster:mock-id'
      })
    )
  })

  it('queues Electron image thumbnails instead of blocking folder upload', async () => {
    const file = makeFile('photo.PNG', 100, '')

    await expect(uploadFiles([file], 'parent-1')).resolves.toBe(1)

    expect(generateThumbnail).not.toHaveBeenCalled()
    expect(mediaJobQueue.enqueue).toHaveBeenCalledWith({
      type: 'cover-thumbnail',
      sourceBlobId: 'mock-id',
      itemId: 'mock-id',
      dedupeKey: 'cover-thumbnail:mock-id'
    })
  })
})

describe('prepareUploadFilesForKind', () => {
  beforeEach(() => {
    vi.mocked(isWeb).mockReturnValue(false)
  })

  it('keeps only audio files when requested', async () => {
    const files = [
      new File(['x'], 'cue.mp3', { type: 'audio/mpeg' }),
      new File(['x'], 'slide.png', { type: 'image/png' })
    ]

    const candidates = await prepareUploadFilesForKind(files, 'audio')

    expect(candidates).toHaveLength(1)
    expect(candidates[0].file.name).toBe('cue.mp3')
    expect(candidates[0].classification.kind).toBe('audio')
  })
})

describe('uploadFiles web video thumbnails', () => {
  beforeEach(() => {
    vi.mocked(isWeb).mockReturnValue(true)
  })

  it('keeps browser-native video thumbnail generation in Web mode', async () => {
    const file = makeFile('movie.MP4', 100, '')

    await expect(uploadFiles([file], 'parent-1')).resolves.toBe(1)

    expect(addFileItemToStore).toHaveBeenCalledWith(file, 'parent-1', 'video/mp4')
    expect(generateThumbnail).toHaveBeenCalledWith(file, 'video/mp4')
    expect(mediaJobQueue.enqueue).not.toHaveBeenCalled()
  })
})

describe('uploadFiles concurrency', () => {
  it('resolves after persistence without waiting for Electron enrichment', async () => {
    vi.mocked(isWeb).mockReturnValue(false)
    vi.mocked(mediaJobQueue.enqueue).mockReturnValue(new Promise(() => undefined))

    const result = await Promise.race([
      uploadFiles([makeFile('photo.png', 100)], 'parent-1'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 0))
    ])

    expect(result).toBe(1)
  })

  it('yields after each persisted Electron file', async () => {
    vi.mocked(isWeb).mockReturnValue(false)

    await uploadFiles([makeFile('photo.png', 100)], 'parent-1')

    expect(yieldToMain).toHaveBeenCalled()
    expect(vi.mocked(addFileItemToStore).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(yieldToMain).mock.invocationCallOrder[0]
    )
  })

  it('time-slices candidate classification before persistence exceeds its budget', async () => {
    vi.mocked(isWeb).mockReturnValue(false)
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(9).mockReturnValue(9)

    await uploadFiles([makeFile('a.png', 100), makeFile('b.png', 100)], 'parent-1')

    expect(vi.mocked(yieldToMain).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(addFileItemToStore).mock.invocationCallOrder[0]
    )
  })

  it('keeps a 1000-file import time-sliced', async () => {
    vi.mocked(isWeb).mockReturnValue(false)
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now++)
    const files = Array.from({ length: 1000 }, (_, index) => makeFile(`${index}.png`, 100))

    await expect(uploadFiles(files, 'parent-1')).resolves.toBe(1000)

    expect(addFileItemToStore).toHaveBeenCalledTimes(1000)
    expect(yieldToMain).toHaveBeenCalled()
  })

  it('limits shared upload work to 3 files', async () => {
    vi.mocked(isWeb).mockReturnValue(false)
    let active = 0
    let maxActive = 0

    vi.mocked(addFileItemToStore).mockImplementation(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active--
      return crypto.randomUUID()
    })

    const filesA = Array.from({ length: 5 }, (_, index) => makeFile(`a${index}.png`, 100))
    const filesB = Array.from({ length: 5 }, (_, index) => makeFile(`b${index}.png`, 100))

    await Promise.all([uploadFiles(filesA, 'parent-1'), uploadFiles(filesB, 'parent-2')])

    expect(maxActive).toBeLessThanOrEqual(3)
    expect(addFileItemToStore).toHaveBeenCalledTimes(10)
  })
})

describe('upload identities and partial failures', () => {
  it.each([
    ['slide.png', 'image/png', 'cover-thumbnail'],
    ['slides.pdf', 'application/pdf', 'pdf-pages'],
    ['movie.mp4', 'video/mp4', 'video-poster']
  ])('uses the stored blob identity for %s enrichment', async (name, type, jobType) => {
    vi.mocked(isWeb).mockReturnValue(false)
    vi.mocked(useFileExplorerStore.getState).mockReturnValue({
      items: { 'mock-id': { id: 'mock-id', url: 'blob:immutable-source' } },
      folders: {},
      getChildFolders: () => []
    } as never)
    await uploadFiles([makeFile(name, 3, type)], 'parent-1')
    await vi.waitFor(() =>
      expect(mediaJobQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: jobType,
          itemId: 'mock-id',
          sourceBlobId: 'immutable-source'
        })
      )
    )
  })

  it('reports a failed file and continues importing the remaining batch', async () => {
    vi.mocked(isWeb).mockReturnValue(false)
    vi.mocked(addFileItemToStore).mockRejectedValueOnce(new Error('Disk full'))
    await expect(
      uploadFiles([makeFile('bad.png', 3), makeFile('good.png', 3)], 'parent-1')
    ).resolves.toBe(1)
    expect(toast.danger).toHaveBeenCalledWith(expect.stringContaining('bad.png'))
    expect(addFileItemToStore).toHaveBeenCalledTimes(2)
  })

  it('rejects personal SVG, oversized and empty files before persisting accepted entries', async () => {
    vi.mocked(isWeb).mockReturnValue(false)
    vi.mocked(useFileExplorerStore.getState).mockReturnValue({
      items: { 'mock-id': { id: 'mock-id', url: 'blob:mock-id' } },
      folders: { personal: { personalOwnerId: 'alice' } },
      getChildFolders: () => []
    } as never)
    const accepted = makeFile('good.png', 3)
    await expect(
      uploadFiles(
        [
          makeFile('vector.svg', 3, 'image/svg+xml'),
          makeFile('large.png', 200 * 1024 * 1024 + 1),
          makeFile('empty.png', 0),
          accepted
        ],
        'personal'
      )
    ).resolves.toBe(1)
    expect(addFileItemToStore).toHaveBeenCalledExactlyOnceWith(accepted, 'personal', 'image/png')
    expect(toast.danger).toHaveBeenCalledTimes(3)
  })

  it('continues supporting local SVG imports', async () => {
    vi.mocked(isWeb).mockReturnValue(false)
    await expect(
      uploadFiles([makeFile('vector.svg', 3, 'image/svg+xml')], 'parent-1')
    ).resolves.toBe(1)
  })
})

it.each(['file', 'folder'])(
  'resets the %s picker after failure and allows reselecting the same files',
  async () => {
    const input = document.createElement('input')
    const file = makeFile('same.png', 3)
    Object.defineProperty(input, 'files', { value: [file] })
    input.value = 'selected'
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('Storage unavailable'))
      .mockResolvedValueOnce(1)
    await expect(importFromFileInput(input, false, upload)).resolves.toBeUndefined()
    expect(input.value).toBe('')
    expect(toast.danger).toHaveBeenCalledWith(expect.stringContaining('Storage unavailable'))
    input.value = 'selected'
    await importFromFileInput(input, false, upload)
    expect(upload).toHaveBeenNthCalledWith(2, [file])
    expect(input.value).toBe('')
  }
)

it('resets a read-only picker without importing', async () => {
  const input = document.createElement('input')
  Object.defineProperty(input, 'files', { value: [makeFile('same.png', 3)] })
  input.value = 'selected'
  const upload = vi.fn()
  await importFromFileInput(input, true, upload)
  expect(upload).not.toHaveBeenCalled()
  expect(input.value).toBe('')
})
