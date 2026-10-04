import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import { registerMediaProjectionPreflight } from '@renderer/lib/media-projection-preflight'
import {
  isMediaResourceLocked,
  resetMediaResourceLocksForTests
} from '@renderer/lib/media-resource-locks'
import type { FileItemRecord } from '@shared/types/folder'
import { usePersonalSyncStore } from '../personal-sync'

vi.mock('@renderer/lib/file-explorer-db', () => ({
  openFileExplorerDB: vi.fn(async () => ({}) as IDBDatabase),
  getFileBlob: vi.fn(async () => null),
  isFileBlobAvailable: vi.fn(async () => true)
}))

vi.mock('@renderer/lib/thumbnail-db', () => ({
  getThumbnail: vi.fn(async () => null),
  saveThumbnail: vi.fn(async () => undefined)
}))

vi.mock('@renderer/lib/thumbnail-generator', () => ({
  generateThumbnail: vi.fn(async () => null)
}))

function makeFile(id: string, name: string, mimeType = 'image/png'): FileItemRecord {
  return {
    id,
    name,
    mimeType,
    type: 'file',
    sortIndex: 0,
    parentId: 'root',
    size: 1024,
    url: `https://example.com/${id}`,
    createdAt: Date.now(),
    expiresAt: null
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => {
      resolve = done
    }),
    resolve
  }
}

const files = [makeFile('a', 'a.png'), makeFile('b', 'b.png'), makeFile('c', 'c.png')]

it('clears a departing personal playlist and rejects its stale item reference', () => {
  usePersonalSyncStore.getState().setAccount('authenticated', 'alice', true)
  const privateFile = { ...makeFile('private', 'private.png'), personalOwnerId: 'alice' }
  useMediaProjectionStore.getState().startPresentation([privateFile], 0)
  expect(useMediaProjectionStore.getState().playlist).toHaveLength(1)
  usePersonalSyncStore.getState().setAccount('anonymous')
  expect(useMediaProjectionStore.getState().playlist).toEqual([])
  expect(useMediaProjectionStore.getState().startPresentation([privateFile], 0)).toBe(false)
})
const pptxFile = makeFile(
  'deck',
  'deck.pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
)

beforeEach(() => {
  useMediaProjectionStore.getState().exit()
  resetMediaResourceLocksForTests()
  useMediaProjectionStore.setState({
    playlist: [],
    currentIndex: 0,
    isPresenting: false,
    isEnded: false,
    showGrid: false,
    lastReadinessReport: null,
    typeStates: { pdf: { viewMode: 'slide' } },
    zoomLevel: 1,
    snapshot: null
  })
})

describe('startPresentation', () => {
  it('sets playlist, currentIndex, and isPresenting', () => {
    useMediaProjectionStore.getState().startPresentation(files, 2)
    const s = useMediaProjectionStore.getState()
    expect(s.playlist).toEqual(files)
    expect(s.currentIndex).toBe(2)
    expect(s.isPresenting).toBe(true)
  })

  it('creates an immutable presentation snapshot', () => {
    const playlist = [makeFile('copy-id', 'Original.png')]
    playlist[0].url = 'blob:source-blob'

    useMediaProjectionStore.getState().startPresentation(playlist, 0)
    playlist[0].name = 'Renamed.png'
    playlist[0].url = 'blob:other-blob'

    expect(useMediaProjectionStore.getState().snapshot?.entries[0]).toMatchObject({
      itemId: 'copy-id',
      blobId: 'source-blob',
      name: 'Original.png',
      sourceUrl: 'blob:source-blob'
    })
  })

  it('increments the session revision for every explicit start', () => {
    useMediaProjectionStore.getState().startPresentation(files, 0)
    expect(useMediaProjectionStore.getState().sessionRevision).toBe(1)

    useMediaProjectionStore.getState().startPresentation(files, 1)
    expect(useMediaProjectionStore.getState().sessionRevision).toBe(2)
  })

  it('does not let an older editable start commit after a newer start or exit', async () => {
    const editable = makeFile('editable', 'editable.lpdeck', 'application/vnd.hhc.presenter+json')
    const pending = deferred<boolean>()
    const unregister = registerMediaProjectionPreflight(() => pending.promise)

    const staleStart = useMediaProjectionStore.getState().startPresentation([editable], 0)
    expect(staleStart).toBeInstanceOf(Promise)

    expect(useMediaProjectionStore.getState().startPresentation([files[1]], 0)).toBe(true)
    pending.resolve(true)
    expect(await staleStart).toEqual({ status: 'superseded' })
    expect(useMediaProjectionStore.getState().currentItem()?.id).toBe('b')

    const pendingExit = deferred<boolean>()
    unregister()
    const unregisterExit = registerMediaProjectionPreflight(() => pendingExit.promise)
    const staleExitStart = useMediaProjectionStore.getState().startPresentation([editable], 0)
    useMediaProjectionStore.getState().exit()
    pendingExit.resolve(true)
    expect(await staleExitStart).toEqual({ status: 'superseded' })
    expect(useMediaProjectionStore.getState().isPresenting).toBe(false)
    unregisterExit()
  })

  it('keeps only the newest pending navigation result', async () => {
    const editableFiles = ['one', 'two', 'three'].map((id) =>
      makeFile(id, `${id}.lpdeck`, 'application/vnd.hhc.presenter+json')
    )
    const first = deferred<boolean>()
    const second = deferred<boolean>()
    let calls = 0
    const restore = registerMediaProjectionPreflight(() => {
      calls += 1
      return calls === 1 ? first.promise : second.promise
    })
    useMediaProjectionStore.setState({
      playlist: editableFiles,
      currentIndex: 0,
      isPresenting: true,
      sessionRevision: 4,
      typeStates: { presentation: { slideIndex: 0, slideCount: 1 } }
    })

    const next = useMediaProjectionStore.getState().next()
    const jump = useMediaProjectionStore.getState().jumpTo(2)
    second.resolve(true)
    expect(await jump).toEqual({ status: 'success' })
    first.resolve(true)
    expect(await next).toEqual({ status: 'superseded' })
    expect(useMediaProjectionStore.getState().currentIndex).toBe(2)
    restore()
  })

  it('does not overwrite presentation runtime state published during a pending navigation', async () => {
    const presentation = makeFile('deck', 'deck.pptx', 'application/vnd.hhc.presenter+json')
    const pending = deferred<boolean>()
    const unregister = registerMediaProjectionPreflight(() => pending.promise)
    useMediaProjectionStore.setState({
      playlist: [presentation],
      currentIndex: 0,
      isPresenting: true,
      isEnded: false,
      typeStates: { presentation: { slideIndex: 0, slideCount: 5 } }
    })

    const next = useMediaProjectionStore.getState().next()
    useMediaProjectionStore.getState().setTypeState('presentation', {
      slideIndex: 3,
      slideCount: 5
    })
    pending.resolve(true)

    expect(await next).toEqual({ status: 'superseded' })
    expect(useMediaProjectionStore.getState().typeStates.presentation).toEqual({
      slideIndex: 3,
      slideCount: 5
    })
    expect(useMediaProjectionStore.getState().currentIndex).toBe(0)

    expect(await useMediaProjectionStore.getState().next()).toEqual({ status: 'success' })
    expect(useMediaProjectionStore.getState().typeStates.presentation).toEqual({
      slideIndex: 4,
      slideCount: 5
    })
    unregister()
  })

  it('does not revive a closed editable item after it reopens', async () => {
    const editable = makeFile('editable', 'editable.lpdeck', 'application/vnd.hhc.presenter+json')
    const first = deferred<boolean>()
    const second = deferred<boolean>()
    let calls = 0
    const unregister = registerMediaProjectionPreflight(() => {
      calls += 1
      return calls === 1 ? first.promise : second.promise
    })

    const staleStart = useMediaProjectionStore.getState().startPresentation([editable], 0)
    useMediaProjectionStore.getState().exit()
    const reopenedStart = useMediaProjectionStore.getState().startPresentation([editable], 0)
    second.resolve(true)
    expect(await reopenedStart).toEqual({ status: 'success' })
    first.resolve(true)
    expect(await staleStart).toEqual({ status: 'superseded' })
    expect(useMediaProjectionStore.getState().currentItem()?.id).toBe(editable.id)
    unregister()
  })
})

describe('startPresentationWithReadiness', () => {
  it('starts only ready items and returns the readiness report', async () => {
    const playlist = [
      makeFile('bad', 'bad.xyz', 'application/x-unsupported'),
      makeFile('ready-a', 'ready-a.png'),
      makeFile('ready-b', 'ready-b.png')
    ]

    const report = await useMediaProjectionStore
      .getState()
      .startPresentationWithReadiness(playlist, 0)
    const state = useMediaProjectionStore.getState()

    expect(report.summary).toMatchObject({ ready: 2, unsupported: 1 })
    expect(state.isPresenting).toBe(true)
    expect(state.playlist.map((item) => item.id)).toEqual(['ready-a', 'ready-b'])
    expect(state.currentIndex).toBe(0)
    expect(state.snapshot?.entries.map((entry) => entry.itemId)).toEqual(['ready-a', 'ready-b'])
    expect(state.lastReadinessReport).toBe(report)
  })

  it('does not start when no items are ready', async () => {
    const report = await useMediaProjectionStore
      .getState()
      .startPresentationWithReadiness([makeFile('bad', 'bad.xyz', 'application/x-unsupported')], 0)
    const state = useMediaProjectionStore.getState()

    expect(report.summary.ready).toBe(0)
    expect(state.isPresenting).toBe(false)
    expect(state.playlist).toEqual([])
    expect(state.lastReadinessReport).toBe(report)
    expect(state.sessionRevision).toBe(0)
  })

  it('starts a presentation with its requested slide state atomically', async () => {
    await useMediaProjectionStore.getState().startPresentationWithReadiness([pptxFile], 0, {
      presentationState: { slideIndex: 3, slideCount: 8 }
    })

    expect(useMediaProjectionStore.getState().typeStates.presentation).toEqual({
      slideIndex: 3,
      slideCount: 8
    })
  })
})

describe('exit', () => {
  it('resets all state', () => {
    useMediaProjectionStore.getState().startPresentation(files, 1)
    useMediaProjectionStore.getState().exit()
    const s = useMediaProjectionStore.getState()
    expect(s.isPresenting).toBe(false)
    expect(s.playlist).toEqual([])
    expect(s.currentIndex).toBe(0)
    expect(s.showGrid).toBe(false)
    expect(s.snapshot).toBeNull()
  })

  it('releases source blobs locked by the active playlist', () => {
    useMediaProjectionStore.getState().startPresentation(files, 0)
    expect(isMediaResourceLocked('a')).toBe(true)
    expect(isMediaResourceLocked('b')).toBe(true)

    useMediaProjectionStore.getState().exit()

    expect(isMediaResourceLocked('a')).toBe(false)
    expect(isMediaResourceLocked('b')).toBe(false)
  })
})

describe('live session lifecycle', () => {
  it.each(['endLiveSession', 'markProjectionClosed'] as const)(
    '%s clears live state and releases resource locks',
    (action) => {
      const state = useMediaProjectionStore.getState()
      expect(state).toHaveProperty(action)
      state.startPresentation(files, 1)

      useMediaProjectionStore.getState()[action]()

      const next = useMediaProjectionStore.getState()
      expect(next.isPresenting).toBe(false)
      expect(next.playlist).toEqual([])
      expect(next.snapshot).toBeNull()
      expect(isMediaResourceLocked('a')).toBe(false)
      expect(isMediaResourceLocked('b')).toBe(false)
    }
  )
})

describe('next / prev', () => {
  beforeEach(() => {
    useMediaProjectionStore.getState().startPresentation(files, 0)
  })

  it('next() increments index', () => {
    useMediaProjectionStore.getState().next()
    expect(useMediaProjectionStore.getState().currentIndex).toBe(1)
  })

  it('next() clears stale video runtime state while preserving pdf state', () => {
    useMediaProjectionStore.setState({
      typeStates: {
        pdf: { viewMode: 'scroll' },
        video: { hasStarted: true, isPlaying: true, isEnded: false }
      }
    })

    useMediaProjectionStore.getState().next()

    expect(useMediaProjectionStore.getState().typeStates).toEqual({
      pdf: { viewMode: 'scroll' }
    })
  })

  it('next() advances PPTX slides before moving to the next media item', () => {
    useMediaProjectionStore.getState().startPresentation([pptxFile, files[1]], 0)
    useMediaProjectionStore.getState().setTypeState('presentation', {
      slideIndex: 0,
      slideCount: 2
    })

    useMediaProjectionStore.getState().next()
    expect(useMediaProjectionStore.getState().currentIndex).toBe(0)
    expect(useMediaProjectionStore.getState().typeStates.presentation).toEqual({
      slideIndex: 1,
      slideCount: 2
    })

    useMediaProjectionStore.getState().next()
    expect(useMediaProjectionStore.getState().currentIndex).toBe(1)
    expect(useMediaProjectionStore.getState().typeStates.presentation).toBeUndefined()
  })

  it('next() stops at end', () => {
    useMediaProjectionStore.setState({ currentIndex: 2 })
    useMediaProjectionStore.getState().next()
    expect(useMediaProjectionStore.getState().currentIndex).toBe(2)
  })

  it('next() on the end screen keeps the live session for an explicit close', () => {
    useMediaProjectionStore.setState({ currentIndex: 2 })
    useMediaProjectionStore.getState().next()
    useMediaProjectionStore.getState().next()

    expect(useMediaProjectionStore.getState().isPresenting).toBe(true)
    expect(useMediaProjectionStore.getState().isEnded).toBe(true)
  })

  it('prev() decrements index', () => {
    useMediaProjectionStore.setState({ currentIndex: 2 })
    useMediaProjectionStore.getState().prev()
    expect(useMediaProjectionStore.getState().currentIndex).toBe(1)
  })

  it('prev() moves within PPTX slides before moving to the previous media item', () => {
    useMediaProjectionStore.getState().startPresentation([files[0], pptxFile], 1)
    useMediaProjectionStore.getState().setTypeState('presentation', {
      slideIndex: 1,
      slideCount: 2
    })

    useMediaProjectionStore.getState().prev()
    expect(useMediaProjectionStore.getState().currentIndex).toBe(1)
    expect(useMediaProjectionStore.getState().typeStates.presentation).toEqual({
      slideIndex: 0,
      slideCount: 2
    })

    useMediaProjectionStore.getState().prev()
    expect(useMediaProjectionStore.getState().currentIndex).toBe(0)
    expect(useMediaProjectionStore.getState().typeStates.presentation).toBeUndefined()
  })

  it('prev() stops at start', () => {
    useMediaProjectionStore.getState().prev()
    expect(useMediaProjectionStore.getState().currentIndex).toBe(0)
  })
})

describe('canNext / canPrev', () => {
  it('canNext reaches the end screen from the last item', () => {
    useMediaProjectionStore.getState().startPresentation(files, 2)
    expect(useMediaProjectionStore.getState().canNext()).toBe(true)

    useMediaProjectionStore.getState().next()
    expect(useMediaProjectionStore.getState().canNext()).toBe(false)
  })

  it('canPrev is false at first index', () => {
    useMediaProjectionStore.getState().startPresentation(files, 0)
    expect(useMediaProjectionStore.getState().canPrev()).toBe(false)
  })

  it('canNext is true when not at end', () => {
    useMediaProjectionStore.getState().startPresentation(files, 0)
    expect(useMediaProjectionStore.getState().canNext()).toBe(true)
  })

  it('canNext is true inside a PPTX deck even when it is the last media item', () => {
    useMediaProjectionStore.getState().startPresentation([pptxFile], 0)
    useMediaProjectionStore.getState().setTypeState('presentation', {
      slideIndex: 0,
      slideCount: 2
    })
    expect(useMediaProjectionStore.getState().canNext()).toBe(true)
  })

  it('canPrev is true when not at start', () => {
    useMediaProjectionStore.getState().startPresentation(files, 2)
    expect(useMediaProjectionStore.getState().canPrev()).toBe(true)
  })
})

describe('jumpTo', () => {
  it('sets currentIndex', () => {
    useMediaProjectionStore.getState().startPresentation(files, 0)
    useMediaProjectionStore.getState().jumpTo(2)
    expect(useMediaProjectionStore.getState().currentIndex).toBe(2)
  })

  it('jumpTo() clears stale video runtime state only when index changes', () => {
    useMediaProjectionStore.getState().startPresentation(files, 0)
    useMediaProjectionStore.setState({
      typeStates: {
        pdf: { viewMode: 'slide' },
        video: { hasStarted: true, isPlaying: false, isEnded: false }
      }
    })

    useMediaProjectionStore.getState().jumpTo(0)
    expect(useMediaProjectionStore.getState().typeStates.video).toBeDefined()

    useMediaProjectionStore.getState().jumpTo(1)
    expect(useMediaProjectionStore.getState().typeStates).toEqual({
      pdf: { viewMode: 'slide' }
    })
  })

  it('clamps to valid range', () => {
    useMediaProjectionStore.getState().startPresentation(files, 0)
    useMediaProjectionStore.getState().jumpTo(99)
    expect(useMediaProjectionStore.getState().currentIndex).toBe(2)
    useMediaProjectionStore.getState().jumpTo(-5)
    expect(useMediaProjectionStore.getState().currentIndex).toBe(0)
  })
})

describe('toggleGrid', () => {
  it('toggles showGrid', () => {
    expect(useMediaProjectionStore.getState().showGrid).toBe(false)
    useMediaProjectionStore.getState().toggleGrid()
    expect(useMediaProjectionStore.getState().showGrid).toBe(true)
    useMediaProjectionStore.getState().toggleGrid()
    expect(useMediaProjectionStore.getState().showGrid).toBe(false)
  })
})

describe('progress', () => {
  it('returns "0 / 0" for empty playlist', () => {
    expect(useMediaProjectionStore.getState().progress()).toBe('0 / 0')
  })

  it('returns "1 / 3" format', () => {
    useMediaProjectionStore.getState().startPresentation(files, 0)
    expect(useMediaProjectionStore.getState().progress()).toBe('1 / 3')
  })

  it('returns "3 / 3" at last item', () => {
    useMediaProjectionStore.getState().startPresentation(files, 2)
    expect(useMediaProjectionStore.getState().progress()).toBe('3 / 3')
  })

  it('returns PPTX slide progress while presenting a deck', () => {
    useMediaProjectionStore.getState().startPresentation([pptxFile], 0)
    useMediaProjectionStore.getState().setTypeState('presentation', {
      slideIndex: 1,
      slideCount: 4
    })
    expect(useMediaProjectionStore.getState().progress()).toBe('2 / 4')
  })
})

describe('currentItem / nextItem / prevItem', () => {
  it('currentItem returns correct file', () => {
    useMediaProjectionStore.getState().startPresentation(files, 1)
    expect(useMediaProjectionStore.getState().currentItem()).toEqual(files[1])
  })

  it('nextItem returns next file', () => {
    useMediaProjectionStore.getState().startPresentation(files, 1)
    expect(useMediaProjectionStore.getState().nextItem()).toEqual(files[2])
  })

  it('prevItem returns previous file', () => {
    useMediaProjectionStore.getState().startPresentation(files, 1)
    expect(useMediaProjectionStore.getState().prevItem()).toEqual(files[0])
  })

  it('currentItem returns null for empty playlist', () => {
    expect(useMediaProjectionStore.getState().currentItem()).toBeNull()
  })

  it('nextItem returns null at end', () => {
    useMediaProjectionStore.getState().startPresentation(files, 2)
    expect(useMediaProjectionStore.getState().nextItem()).toBeNull()
  })

  it('prevItem returns null at start', () => {
    useMediaProjectionStore.getState().startPresentation(files, 0)
    expect(useMediaProjectionStore.getState().prevItem()).toBeNull()
  })
})

describe('updateNotes', () => {
  it('calls useFileExplorerStore.updateItem', async () => {
    const { useFileExplorerStore } = await import('@renderer/stores/file-explorer')
    const mockUpdateItem = vi.fn()
    useFileExplorerStore.setState({ updateItem: mockUpdateItem } as Pick<
      ReturnType<typeof useFileExplorerStore.getState>,
      'updateItem'
    >)

    useMediaProjectionStore.getState().updateNotes('a', 'hello')
    expect(mockUpdateItem).toHaveBeenCalledWith('a', { notes: 'hello' })
  })

  it('preserves other item references when updating notes', async () => {
    const { useFileExplorerStore } = await import('@renderer/stores/file-explorer')
    useFileExplorerStore.setState({ updateItem: vi.fn() } as Pick<
      ReturnType<typeof useFileExplorerStore.getState>,
      'updateItem'
    >)

    useMediaProjectionStore.getState().startPresentation(files, 1)
    const before = useMediaProjectionStore.getState().playlist

    useMediaProjectionStore.getState().updateNotes('b', 'new notes')

    const after = useMediaProjectionStore.getState().playlist
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
    expect(after[1]).not.toBe(before[1])
    expect(after[1]).toMatchObject({ id: 'b', notes: 'new notes' })
  })
})

describe('presentation page navigation readiness', () => {
  it.each([undefined, 0, -1, NaN])(
    'does not end a deck with unknown/invalid count %s',
    (slideCount) => {
      useMediaProjectionStore.getState().startPresentation([pptxFile], 0)
      useMediaProjectionStore.getState().setTypeState('presentation', { slideIndex: 0, slideCount })
      expect(useMediaProjectionStore.getState().canNext()).toBe(false)
      expect(useMediaProjectionStore.getState().progress()).toBe('1 / …')
      expect(useMediaProjectionStore.getState().next()).toBe(false)
      expect(useMediaProjectionStore.getState().isEnded).toBe(false)
      useMediaProjectionStore
        .getState()
        .setTypeState('presentation', { slideIndex: 0, slideCount: 10 })
      useMediaProjectionStore.getState().next()
      expect(useMediaProjectionStore.getState().typeStates.presentation?.slideIndex).toBe(1)
    }
  )

  it('jumps to pages without replacing the file and rejects invalid page indices', () => {
    useMediaProjectionStore.getState().startPresentation([pptxFile], 0)
    useMediaProjectionStore
      .getState()
      .setTypeState('presentation', { slideIndex: 4, slideCount: 10 })
    expect(useMediaProjectionStore.getState().jumpToSlide(6)).toBe(true)
    expect(useMediaProjectionStore.getState().currentItem()?.id).toBe('deck')
    expect(useMediaProjectionStore.getState().typeStates.presentation?.slideIndex).toBe(6)
    expect(useMediaProjectionStore.getState().jumpToSlide(0)).toBe(true)
    expect(useMediaProjectionStore.getState().typeStates.presentation?.slideIndex).toBe(0)
    expect(useMediaProjectionStore.getState().jumpToSlide(9)).toBe(true)
    expect(useMediaProjectionStore.getState().typeStates.presentation?.slideIndex).toBe(9)
    for (const invalid of [-1, 10, NaN, 2.5]) {
      expect(useMediaProjectionStore.getState().jumpToSlide(invalid)).toBe(false)
    }
    useMediaProjectionStore.getState().next()
    expect(useMediaProjectionStore.getState().isEnded).toBe(true)
  })

  it('preserves current page when editable preflight blocks a jump', async () => {
    const editable = makeFile('editable', 'editable.lpdeck', 'application/vnd.hhc.presenter+json')
    useMediaProjectionStore.setState({
      playlist: [editable],
      currentIndex: 0,
      isPresenting: true,
      typeStates: { presentation: { slideIndex: 4, slideCount: 10 } }
    })
    const unregister = registerMediaProjectionPreflight(() => false)
    try {
      expect(await useMediaProjectionStore.getState().jumpToSlide(6)).toBe(false)
      expect(useMediaProjectionStore.getState().typeStates.presentation?.slideIndex).toBe(4)
    } finally {
      unregister()
    }
  })

  it('does not apply an older page jump after a newer jump', async () => {
    const editable = makeFile('editable', 'editable.lpdeck', 'application/vnd.hhc.presenter+json')
    useMediaProjectionStore.setState({
      playlist: [editable],
      currentIndex: 0,
      isPresenting: true,
      typeStates: { presentation: { slideIndex: 0, slideCount: 10 } }
    })
    const pending = deferred<boolean>()
    const unregister = registerMediaProjectionPreflight(
      vi.fn().mockReturnValueOnce(pending.promise).mockReturnValue(true)
    )
    try {
      const older = useMediaProjectionStore.getState().jumpToSlide(4)
      await useMediaProjectionStore.getState().jumpToSlide(6)
      pending.resolve(true)
      expect(await older).toEqual({ status: 'superseded' })
      expect(useMediaProjectionStore.getState().typeStates.presentation?.slideIndex).toBe(6)
    } finally {
      unregister()
    }
  })
})
