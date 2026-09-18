import { cleanup, renderHook, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addElementToSlide,
  createBlankEditablePresentationDocument,
  createTextElement
} from '@renderer/lib/editable-presentation'
import { EDITABLE_PRESENTATION_MIME_TYPE } from '@renderer/lib/presentation-media'
import type { PresentationEditorSession } from '@renderer/lib/presentation-editor-session'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import type { ProjectionPayload } from '@shared/projection-messages'
import type { FileItemRecord, FolderRecord } from '@shared/types/folder'
import { HhcAssetApiError } from '../hhc-asset-api'
import { resetMediaProjectionPreflightForTests } from '../media-projection-preflight'

const registryMocks = vi.hoisted(() => ({
  get: vi.fn(),
  finalizeAndFlush: vi.fn()
}))
const mockProject = vi.fn()
const mockStartProjection = vi.fn<
  (owner: string, messages: Array<['file:show', ProjectionPayload<'file:show'>]>) => Promise<void>
>(() => Promise.resolve())
const mockStopProjection = vi.fn(() => Promise.resolve())
const remoteMocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  ensurePersistent: vi.fn()
}))
const payloadMocks = vi.hoisted(() => ({ fallback: vi.fn() }))
const projectionState = { activeOwner: 'media' as 'media' | 'timer' | 'bible' }

vi.mock('@renderer/contexts/ProjectionContext', () => ({
  useProjection: () => ({
    project: mockProject,
    startProjection: mockStartProjection,
    stopProjection: mockStopProjection,
    activeOwner: projectionState.activeOwner
  })
}))

vi.mock('@renderer/contexts/PresentationSessionRegistryContext', () => ({
  usePresentationSessionRegistry: () => registryMocks
}))

vi.mock('../hhc-line-connect', () => ({
  prepareHhcLinePresentationSource: remoteMocks.prepare,
  ensureHhcLineDesktopItemAvailableForPresentation: remoteMocks.ensurePersistent
}))

vi.mock('../media-projection-payload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../media-projection-payload')>()
  payloadMocks.fallback.mockImplementation(actual.buildFileProjectionPayloadWithEditableSlide)
  return { ...actual, buildFileProjectionPayloadWithEditableSlide: payloadMocks.fallback }
})

import { useMediaProjectionSync } from '../media-projection-sync'

function renderSync(
  options?: Parameters<typeof useMediaProjectionSync>[0]
): ReturnType<typeof renderHook> {
  return renderHook(() => useMediaProjectionSync(options))
}

function makeFile(id: string, name: string, mimeType = 'image/png', blobId = id): FileItemRecord {
  return {
    id,
    name,
    mimeType,
    type: 'file',
    sortIndex: 0,
    parentId: 'root',
    size: 1,
    url: `blob:${blobId}`,
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

function setRemotePresentationItem(name = 'remote.png', mimeType = 'image/png'): FileItemRecord {
  const item = makeFile('remote', name, mimeType)
  useMediaProjectionStore.setState({
    playlist: [item],
    currentIndex: 0,
    isPresenting: true,
    snapshot: {
      id: 'snapshot',
      createdAt: 1,
      entries: [
        {
          index: 0,
          itemId: item.id,
          blobId: item.id,
          name: item.name,
          mimeType: item.mimeType,
          sourceUrl: item.url,
          remoteItem: {
            providerConnectionId: 'hhc-line:user-1',
            remoteItemId: 'asset-1',
            rootRemoteFolderId: 'collection-1'
          }
        }
      ]
    }
  })
  return item
}

function setRemoteDesktopEngineItem(): FileItemRecord {
  const item = makeFile('vlc-item', 'vlc.mkv', 'video/x-matroska', 'source-blob')
  useMediaProjectionStore.setState({
    playlist: [item],
    currentIndex: 0,
    isPresenting: true,
    snapshot: {
      id: 'snapshot',
      createdAt: 1,
      entries: [
        {
          index: 0,
          itemId: item.id,
          blobId: 'source-blob',
          name: item.name,
          mimeType: item.mimeType,
          sourceUrl: item.url,
          playbackMode: 'vlc-embedded',
          playbackVariant: 'matroska-remux',
          seekable: true,
          remoteItem: {
            providerConnectionId: 'hhc-line:user-1',
            remoteItemId: 'asset-1',
            rootRemoteFolderId: 'collection-1'
          }
        }
      ]
    }
  })
  return item
}

beforeEach(() => {
  resetMediaProjectionPreflightForTests()
  vi.clearAllMocks()
  registryMocks.get.mockReset()
  registryMocks.finalizeAndFlush.mockReset()
  Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  projectionState.activeOwner = 'media'
  registryMocks.get.mockReturnValue(undefined)
  registryMocks.finalizeAndFlush.mockResolvedValue(null)
  remoteMocks.prepare.mockResolvedValue(null)
  remoteMocks.ensurePersistent.mockResolvedValue(false)
  usePresentationWorkspaceStore.setState({ activeSlideIdByItemId: {} })
  useMediaProjectionStore.setState({
    playlist: [makeFile('a', 'a.png'), makeFile('b', 'b.png')],
    currentIndex: 0,
    isPresenting: true,
    isEnded: false,
    lastReadinessReport: null,
    showGrid: false,
    snapshot: null,
    typeStates: { pdf: { viewMode: 'slide' } },
    zoomLevel: 1,
    pan: { x: 0, y: 0 }
  })
  useFileExplorerStore.setState({ folders: {} })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetMediaProjectionPreflightForTests()
})

describe('media projection sync', () => {
  it.each([
    ['image/png', 'photo.png'],
    ['audio/mpeg', 'sermon.mp3'],
    ['video/mp4', 'clip.mp4'],
    ['application/pdf', 'bulletin.pdf'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'slides.pptx']
  ])('projects HHC %s through both ticket and native-lease payloads', async (mimeType, name) => {
    const auth = {
      getSession: () => ({ userId: 'user-1', displayName: 'Ada', roles: [] }),
      getAccessToken: vi.fn(),
      refreshAfterUnauthorized: vi.fn(),
      endSession: vi.fn()
    }
    const item = setRemotePresentationItem(name, mimeType)
    remoteMocks.prepare.mockResolvedValueOnce({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'asset-1',
      rootRemoteFolderId: 'collection-1',
      source: {
        kind: 'ticket',
        url: 'https://www.alive.org.tw/api/assets/content?ticket=matrix-secret',
        expiresAt: Date.now() + 60_000,
        etag: 'etag-1'
      }
    })

    const rendered = renderHook(() => useMediaProjectionSync({ auth }))
    await waitFor(() => {
      expect(mockStartProjection).toHaveBeenCalledWith('media', [
        [
          'file:show',
          expect.objectContaining({
            mimeType,
            streamUrl: 'https://www.alive.org.tw/api/assets/content?ticket=matrix-secret'
          })
        ]
      ])
    })
    rendered.unmount()
    mockStartProjection.mockClear()
    useMediaProjectionStore.setState({ isPresenting: false })
    setRemotePresentationItem(name, mimeType)
    remoteMocks.prepare.mockResolvedValueOnce({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'asset-1',
      rootRemoteFolderId: 'collection-1',
      source: {
        kind: 'native-lease',
        url: 'hhc-media://lease/123e4567-e89b-12d3-a456-426614174000?type=application%2Foctet-stream',
        leaseId: '123e4567-e89b-12d3-a456-426614174000',
        etag: 'etag-1'
      }
    })

    const nativeRendered = renderHook(() => useMediaProjectionSync({ auth }))
    await waitFor(() => {
      expect(mockStartProjection).toHaveBeenCalledWith('media', [
        [
          'file:show',
          expect.objectContaining({
            mimeType,
            streamUrl: expect.stringMatching(/^hhc-media:\/\/lease\//)
          })
        ]
      ])
    })
    expect(item.url).toBe('blob:remote')
    nativeRendered.unmount()
  })

  it('renews an expiring browser source authoritatively without persisting its ticket', async () => {
    vi.useFakeTimers()
    const item = makeFile('remote', 'remote.mp4', 'video/mp4')
    useMediaProjectionStore.setState({
      playlist: [item],
      currentIndex: 0,
      isPresenting: true,
      snapshot: {
        id: 'snapshot',
        createdAt: 1,
        entries: [
          {
            index: 0,
            itemId: item.id,
            blobId: item.id,
            name: item.name,
            mimeType: item.mimeType,
            sourceUrl: item.url,
            remoteItem: {
              providerConnectionId: 'hhc-line:user-1',
              remoteItemId: 'asset-1',
              rootRemoteFolderId: 'collection-1'
            }
          }
        ]
      }
    })
    remoteMocks.prepare
      .mockResolvedValueOnce({
        providerConnectionId: 'hhc-line:user-1',
        remoteItemId: 'asset-1',
        rootRemoteFolderId: 'collection-1',
        source: {
          kind: 'ticket',
          url: 'https://www.alive.org.tw/api/assets/content?ticket=first',
          expiresAt: Date.now() + 60_000,
          etag: 'etag-1'
        }
      })
      .mockResolvedValueOnce({
        providerConnectionId: 'hhc-line:user-1',
        remoteItemId: 'asset-1',
        rootRemoteFolderId: 'collection-1',
        source: {
          kind: 'ticket',
          url: 'https://www.alive.org.tw/api/assets/content?ticket=second',
          expiresAt: Date.now() + 60_000,
          etag: 'etag-1'
        }
      })

    renderSync({
      auth: {
        getSession: () => ({ userId: 'user-1', displayName: 'Ada', roles: [] }),
        getAccessToken: vi.fn(),
        refreshAfterUnauthorized: vi.fn(),
        endSession: vi.fn()
      }
    })
    await act(async () => Promise.resolve())
    expect(mockStartProjection).toHaveBeenCalledWith('media', [
      ['file:show', expect.objectContaining({ streamUrl: expect.stringContaining('ticket=first') })]
    ])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(mockProject).toHaveBeenCalledWith(
      'file:show',
      expect.objectContaining({ streamUrl: expect.stringContaining('ticket=second') })
    )
    expect(item.url).toBe('blob:remote')
    vi.useRealTimers()
  })

  it('keeps the current source on retryable renewal failure and emits access-revoked only for 403', async () => {
    vi.useFakeTimers()
    const onAccessRevoked = vi.fn()
    const error = Object.assign(new Error('retry'), { classification: 'retryable' })
    remoteMocks.prepare
      .mockResolvedValueOnce({
        providerConnectionId: 'hhc-line:user-1',
        remoteItemId: 'asset-1',
        rootRemoteFolderId: 'collection-1',
        source: {
          kind: 'ticket',
          url: 'https://www.alive.org.tw/api/assets/content?ticket=current',
          expiresAt: Date.now() + 60_000,
          etag: 'etag-1'
        }
      })
      .mockRejectedValueOnce(error)
    useMediaProjectionStore.setState({
      snapshot: {
        id: 'snapshot',
        createdAt: 1,
        entries: [
          {
            index: 0,
            itemId: 'a',
            blobId: 'a',
            name: 'a.png',
            mimeType: 'image/png',
            sourceUrl: 'blob:a',
            remoteItem: {
              providerConnectionId: 'hhc-line:user-1',
              remoteItemId: 'asset-1',
              rootRemoteFolderId: 'collection-1'
            }
          },
          {
            index: 1,
            itemId: 'b',
            blobId: 'b',
            name: 'b.png',
            mimeType: 'image/png',
            sourceUrl: 'blob:b',
            remoteItem: {
              providerConnectionId: 'hhc-line:user-1',
              remoteItemId: 'asset-2',
              rootRemoteFolderId: 'collection-1'
            }
          }
        ]
      }
    })

    renderSync({
      auth: {
        getSession: () => ({ userId: 'user-1', displayName: 'Ada', roles: [] }),
        getAccessToken: vi.fn(),
        refreshAfterUnauthorized: vi.fn(),
        endSession: vi.fn()
      },
      onAccessRevoked
    })
    await act(async () => Promise.resolve())
    expect(onAccessRevoked).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(useMediaProjectionStore.getState().snapshot?.entries[0].sourceUrl).toContain(
      'ticket=current'
    )

    remoteMocks.prepare.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), {
        classification: 'access-revoked',
        providerConnectionId: 'hhc-line:user-1',
        remoteItemId: 'asset-1'
      })
    )
    act(() => {
      void useMediaProjectionStore.getState().jumpTo(1)
    })
    await act(async () => Promise.resolve())
    expect(onAccessRevoked).not.toHaveBeenCalled()

    remoteMocks.prepare.mockRejectedValueOnce(
      Object.assign(new HhcAssetApiError('access-revoked', 403), {
        providerConnectionId: 'hhc-line:user-1',
        remoteItemId: 'asset-1'
      })
    )
    act(() => {
      void useMediaProjectionStore.getState().jumpTo(0)
    })
    await act(async () => Promise.resolve())
    expect(onAccessRevoked).toHaveBeenCalledWith({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'asset-1'
    })
    expect(onAccessRevoked).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it.each([403, 404] as const)(
    'stops projection and clears current remote sources and leases after an exact %s',
    async (status) => {
      vi.useFakeTimers()
      const clearContentLeases = vi.fn(async () => undefined)
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { hhcAssets: { clearContentLeases } }
      })
      const onAccessRevoked = vi.fn(async () => undefined)
      const item = setRemotePresentationItem('remote.mp4', 'video/mp4')
      remoteMocks.prepare
        .mockResolvedValueOnce({
          providerConnectionId: 'hhc-line:user-1',
          remoteItemId: 'asset-1',
          rootRemoteFolderId: 'collection-1',
          source: {
            kind: 'ticket',
            url: 'https://www.alive.org.tw/api/assets/content?ticket=current',
            expiresAt: Date.now() + 60_000,
            etag: 'etag-1'
          }
        })
        .mockRejectedValueOnce(
          Object.assign(new HhcAssetApiError('access-revoked', status), {
            providerConnectionId: 'hhc-line:user-1',
            remoteItemId: 'asset-1'
          })
        )

      renderSync({
        auth: {
          getSession: () => ({ userId: 'user-1', displayName: 'Ada', roles: [] }),
          getAccessToken: vi.fn(),
          refreshAfterUnauthorized: vi.fn(),
          endSession: vi.fn()
        },
        onAccessRevoked
      })
      await act(async () => Promise.resolve())

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })

      expect(useMediaProjectionStore.getState().snapshot?.entries[0].sourceUrl).toBe(item.url)
      expect(clearContentLeases).not.toHaveBeenCalled()
      expect(mockStopProjection).toHaveBeenCalledOnce()
      expect(onAccessRevoked).toHaveBeenCalledOnce()
    }
  )

  it('keeps a sibling root source active and releases only the revoked root source', async () => {
    const releaseContentLease = vi.fn(async () => undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { hhcAssets: { releaseContentLease, clearContentLeases: vi.fn() } }
    })
    const makeRoot = (id: string, status: 'active' | 'access-revoked'): FolderRecord => ({
      id,
      name: id,
      parentId: 'file-root',
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerType: 'hhc-line' as const,
        providerConnectionId: 'hhc-line:user-1',
        remoteFolderId: id,
        offlinePolicy: 'online-only' as const,
        status
      }
    })
    useFileExplorerStore.setState({
      folders: {
        'collection-1': makeRoot('collection-1', 'active'),
        'collection-2': makeRoot('collection-2', 'active')
      }
    })
    setRemotePresentationItem()
    remoteMocks.prepare.mockResolvedValueOnce({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'asset-1',
      rootRemoteFolderId: 'collection-1',
      source: {
        kind: 'native-lease',
        url: 'hhc-media://lease/123e4567-e89b-12d3-a456-426614174000?type=image%2Fpng',
        leaseId: '123e4567-e89b-12d3-a456-426614174000',
        etag: 'etag-1'
      }
    })
    renderSync({
      auth: {
        getSession: () => ({ userId: 'user-1', displayName: 'Ada', roles: [] }),
        getAccessToken: vi.fn(),
        refreshAfterUnauthorized: vi.fn(),
        endSession: vi.fn()
      }
    })
    await waitFor(() => expect(remoteMocks.prepare).toHaveBeenCalledOnce())

    act(() => {
      useFileExplorerStore.setState((state) => ({
        folders: { ...state.folders, 'collection-2': makeRoot('collection-2', 'access-revoked') }
      }))
    })
    expect(releaseContentLease).not.toHaveBeenCalled()
    expect(mockStopProjection).not.toHaveBeenCalled()

    act(() => {
      useFileExplorerStore.setState((state) => ({
        folders: { ...state.folders, 'collection-1': makeRoot('collection-1', 'access-revoked') }
      }))
    })
    await waitFor(() => expect(releaseContentLease).toHaveBeenCalledOnce())
    expect(mockStopProjection).toHaveBeenCalledOnce()
  })

  it('does not emit access-revoked for an auth-required account mismatch', async () => {
    const onAccessRevoked = vi.fn()
    setRemotePresentationItem()
    remoteMocks.prepare.mockRejectedValueOnce(
      Object.assign(new Error('HHC account changed'), {
        classification: 'auth-required',
        providerConnectionId: 'hhc-line:user-1',
        remoteItemId: 'asset-1'
      })
    )

    renderSync({
      auth: {
        getSession: () => ({ userId: 'user-2', displayName: 'Grace', roles: [] }),
        getAccessToken: vi.fn(),
        refreshAfterUnauthorized: vi.fn(),
        endSession: vi.fn()
      },
      onAccessRevoked
    })

    await waitFor(() => expect(remoteMocks.prepare).toHaveBeenCalledOnce())
    expect(onAccessRevoked).not.toHaveBeenCalled()
  })

  it.each(['stop', 'account-switch', 'item-change', 'unmount'] as const)(
    'releases a native lease that resolves after %s without projecting it',
    async (transition) => {
      const pending = deferred<{
        providerConnectionId: string
        remoteItemId: string
        rootRemoteFolderId: string
        source: {
          kind: 'native-lease'
          url: string
          leaseId: string
          etag: string
        }
      }>()
      const releaseContentLease = vi.fn(async () => undefined)
      const clearContentLeases = vi.fn(async () => undefined)
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { hhcAssets: { releaseContentLease, clearContentLeases } }
      })
      const sessionRef: {
        current: { userId: string; displayName: string; roles: string[] }
      } = {
        current: { userId: 'user-1', displayName: 'Ada', roles: [] }
      }
      const auth = {
        getSession: () => sessionRef.current,
        getAccessToken: vi.fn(),
        refreshAfterUnauthorized: vi.fn(),
        endSession: vi.fn()
      }
      setRemotePresentationItem()
      remoteMocks.prepare.mockReturnValueOnce(pending.promise)

      const rendered = renderHook(() => useMediaProjectionSync({ auth }))
      await waitFor(() => expect(remoteMocks.prepare).toHaveBeenCalledOnce())
      if (transition === 'stop') {
        act(() => useMediaProjectionStore.setState({ isPresenting: false }))
      } else if (transition === 'account-switch') {
        sessionRef.current = { userId: 'user-2', displayName: 'Grace', roles: [] }
        rendered.rerender()
      } else if (transition === 'item-change') {
        const other = makeFile('other', 'other.png')
        act(() => {
          useMediaProjectionStore.setState((state) => ({
            playlist: [state.playlist[0], other],
            currentIndex: 1,
            snapshot: state.snapshot
              ? {
                  ...state.snapshot,
                  entries: [
                    ...state.snapshot.entries,
                    {
                      index: 1,
                      itemId: other.id,
                      blobId: other.id,
                      name: other.name,
                      mimeType: other.mimeType,
                      sourceUrl: other.url
                    }
                  ]
                }
              : null
          }))
        })
      } else {
        rendered.unmount()
      }

      await act(async () => {
        pending.resolve({
          providerConnectionId: 'hhc-line:user-1',
          remoteItemId: 'asset-1',
          rootRemoteFolderId: 'collection-1',
          source: {
            kind: 'native-lease',
            url: 'hhc-media://lease/123e4567-e89b-12d3-a456-426614174000?type=image%2Fpng',
            leaseId: '123e4567-e89b-12d3-a456-426614174000',
            etag: 'etag-1'
          }
        })
        await pending.promise
      })

      await waitFor(() => {
        expect(releaseContentLease).toHaveBeenCalledOnce()
      })
      expect(mockStartProjection).not.toHaveBeenCalled()
      expect(useMediaProjectionStore.getState().snapshot?.entries[0].sourceUrl).toBe('blob:remote')
      expect(clearContentLeases).not.toHaveBeenCalled()
    }
  )

  it('retries a rejected late native lease release', async () => {
    const pending = deferred<{
      providerConnectionId: string
      remoteItemId: string
      rootRemoteFolderId: string
      source: {
        kind: 'native-lease'
        url: string
        leaseId: string
        etag: string
      }
    }>()
    const releaseContentLease = vi
      .fn()
      .mockRejectedValueOnce(new Error('file busy'))
      .mockResolvedValueOnce(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { hhcAssets: { releaseContentLease, clearContentLeases: vi.fn() } }
    })
    setRemotePresentationItem()
    remoteMocks.prepare.mockReturnValueOnce(pending.promise)
    renderSync({
      auth: {
        getSession: () => ({ userId: 'user-1', displayName: 'Ada', roles: [] }),
        getAccessToken: vi.fn(),
        refreshAfterUnauthorized: vi.fn(),
        endSession: vi.fn()
      }
    })
    await waitFor(() => expect(remoteMocks.prepare).toHaveBeenCalledOnce())
    act(() => useMediaProjectionStore.setState({ isPresenting: false }))

    await act(async () => {
      pending.resolve({
        providerConnectionId: 'hhc-line:user-1',
        remoteItemId: 'asset-1',
        rootRemoteFolderId: 'collection-1',
        source: {
          kind: 'native-lease',
          url: 'hhc-media://lease/123e4567-e89b-12d3-a456-426614174000?type=image%2Fpng',
          leaseId: '123e4567-e89b-12d3-a456-426614174000',
          etag: 'etag-1'
        }
      })
      await pending.promise
    })

    await waitFor(() => expect(releaseContentLease).toHaveBeenCalledTimes(2))
  })

  it('releases an Electron lease and stops presentation when the HHC session ends', async () => {
    const releaseContentLease = vi.fn(async () => undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { hhcAssets: { releaseContentLease } }
    })
    const sessionRef = {
      current: { userId: 'user-1', displayName: 'Ada', roles: [] } as {
        userId: string
        displayName: string
        roles: string[]
      } | null
    }
    const auth = {
      getSession: () => sessionRef.current,
      getAccessToken: vi.fn(),
      refreshAfterUnauthorized: vi.fn(),
      endSession: vi.fn()
    }
    useMediaProjectionStore.setState({
      snapshot: {
        id: 'snapshot',
        createdAt: 1,
        entries: [
          {
            index: 0,
            itemId: 'a',
            blobId: 'a',
            name: 'a.png',
            mimeType: 'image/png',
            sourceUrl: 'blob:a',
            remoteItem: {
              providerConnectionId: 'hhc-line:user-1',
              remoteItemId: 'asset-1',
              rootRemoteFolderId: 'collection-1'
            }
          }
        ]
      }
    })
    remoteMocks.prepare.mockResolvedValueOnce({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'asset-1',
      rootRemoteFolderId: 'collection-1',
      source: {
        kind: 'native-lease',
        url: 'hhc-media://lease/123e4567-e89b-12d3-a456-426614174000?type=image%2Fpng',
        leaseId: '123e4567-e89b-12d3-a456-426614174000',
        etag: 'etag-1'
      }
    })

    const { rerender } = renderHook(() => useMediaProjectionSync({ auth }))
    await act(async () => Promise.resolve())
    sessionRef.current = null
    rerender()

    await waitFor(() => {
      expect(releaseContentLease).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174000')
      expect(mockStopProjection).toHaveBeenCalled()
    })
  })
  it('does not send file:show for notes-only updates', () => {
    renderSync()
    mockProject.mockClear()

    act(() => {
      useMediaProjectionStore.getState().updateNotes('b', 'new notes')
    })

    expect(mockProject).not.toHaveBeenCalledWith('file:show', expect.anything())
  })

  it('sends file:show when jumpTo changes currentIndex', () => {
    renderSync()
    mockProject.mockClear()

    act(() => {
      useMediaProjectionStore.getState().jumpTo(1)
    })

    expect(mockProject).toHaveBeenCalledWith(
      'file:show',
      expect.objectContaining({ currentIndex: 1, itemId: 'b', blobId: 'b' })
    )
  })

  it('sends separate item and blob identities for copied media', () => {
    useMediaProjectionStore.setState({
      playlist: [makeFile('copy-id', 'copy.png', 'image/png', 'original-id')],
      currentIndex: 0,
      isPresenting: true
    })

    renderSync()

    expect(mockStartProjection).toHaveBeenCalledWith('media', [
      ['file:show', expect.objectContaining({ itemId: 'copy-id', blobId: 'original-id' })]
    ])
  })

  it('projects embedded VLC video through the desktop engine', async () => {
    useMediaProjectionStore.setState({
      playlist: [makeFile('vlc-item', 'vlc.mkv', 'video/x-matroska', 'source-blob')],
      currentIndex: 0,
      isPresenting: true,
      snapshot: {
        id: 'snapshot',
        createdAt: 1,
        entries: [
          {
            index: 0,
            itemId: 'vlc-item',
            blobId: 'source-blob',
            name: 'vlc.mkv',
            mimeType: 'video/x-matroska',
            sourceUrl: 'blob:source-blob',
            playbackMode: 'vlc-embedded',
            playbackVariant: 'matroska-remux',
            seekable: true,
            durationMs: 15000
          }
        ]
      }
    })

    renderSync()

    expect(mockStartProjection).toHaveBeenCalledWith('media', [
      [
        'file:show',
        expect.objectContaining({
          itemId: 'vlc-item',
          blobId: 'source-blob',
          playbackMode: 'vlc-embedded',
          playbackVariant: 'matroska-remux',
          seekable: true,
          durationMs: 15000
        })
      ]
    ])
  })

  it('promotes a downloaded remote VLC item to its persistent local snapshot source', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: {} })
    setRemoteDesktopEngineItem()
    remoteMocks.ensurePersistent.mockResolvedValueOnce(true)

    renderSync({
      auth: {
        getSession: () => ({ userId: 'user-1', displayName: 'Ada', roles: [] }),
        getAccessToken: vi.fn(),
        refreshAfterUnauthorized: vi.fn(),
        endSession: vi.fn()
      }
    })

    await waitFor(() => expect(remoteMocks.ensurePersistent).toHaveBeenCalledOnce())
    await waitFor(() => {
      const entry = useMediaProjectionStore.getState().snapshot?.entries[0]
      expect(entry?.remoteItem).toBeUndefined()
      expect(entry?.remoteSource).toBeUndefined()
      expect(entry?.sourceUrl).toBe('blob:source-blob')
    })
    expect(mockStartProjection).toHaveBeenCalledWith('media', [
      [
        'file:show',
        expect.objectContaining({
          itemId: 'vlc-item',
          blobId: 'source-blob',
          playbackMode: 'vlc-embedded'
        })
      ]
    ])
  })

  it.each([
    ['download failure', false, undefined],
    ['access revocation', undefined, new HhcAssetApiError('access-revoked', 403)]
  ] as const)('keeps the remote VLC fence after %s', async (_name, result, error) => {
    Object.defineProperty(window, 'api', { configurable: true, value: {} })
    setRemoteDesktopEngineItem()
    const onAccessRevoked = vi.fn()
    if (error) {
      remoteMocks.ensurePersistent.mockRejectedValueOnce(
        Object.assign(error, {
          providerConnectionId: 'hhc-line:user-1',
          remoteItemId: 'asset-1'
        })
      )
    } else {
      remoteMocks.ensurePersistent.mockResolvedValueOnce(result)
    }

    renderSync({
      auth: {
        getSession: () => ({ userId: 'user-1', displayName: 'Ada', roles: [] }),
        getAccessToken: vi.fn(),
        refreshAfterUnauthorized: vi.fn(),
        endSession: vi.fn()
      },
      onAccessRevoked
    })

    await waitFor(() => expect(remoteMocks.ensurePersistent).toHaveBeenCalledOnce())
    await act(async () => Promise.resolve())
    const entry = useMediaProjectionStore.getState().snapshot?.entries[0]
    expect(entry?.remoteItem).toBeDefined()
    expect(entry?.sourceUrl).toBe('blob:source-blob')
    expect(mockStartProjection).not.toHaveBeenCalled()
    expect(onAccessRevoked).toHaveBeenCalledTimes(error ? 1 : 0)
  })

  it('does not promote a stale remote VLC download after the current item changes', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: {} })
    setRemoteDesktopEngineItem()
    const pending = deferred<boolean>()
    remoteMocks.ensurePersistent.mockReturnValueOnce(pending.promise)
    renderSync({
      auth: {
        getSession: () => ({ userId: 'user-1', displayName: 'Ada', roles: [] }),
        getAccessToken: vi.fn(),
        refreshAfterUnauthorized: vi.fn(),
        endSession: vi.fn()
      }
    })
    await waitFor(() => expect(remoteMocks.ensurePersistent).toHaveBeenCalledOnce())

    const other = makeFile('other', 'other.png')
    act(() => {
      useMediaProjectionStore.setState((state) => ({
        playlist: [...state.playlist, other],
        currentIndex: 1,
        snapshot: state.snapshot
          ? {
              ...state.snapshot,
              entries: [
                ...state.snapshot.entries,
                {
                  index: 1,
                  itemId: other.id,
                  blobId: other.id,
                  name: other.name,
                  mimeType: other.mimeType,
                  sourceUrl: other.url
                }
              ]
            }
          : null
      }))
    })
    await act(async () => {
      pending.resolve(true)
      await pending.promise
    })

    expect(useMediaProjectionStore.getState().snapshot?.entries[0].remoteItem).toBeDefined()
  })

  it('sends file:show when a PPTX slide changes', () => {
    useMediaProjectionStore.setState({
      playlist: [
        makeFile(
          'deck',
          'deck.pptx',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        )
      ],
      currentIndex: 0,
      isPresenting: true,
      typeStates: { pdf: { viewMode: 'slide' }, presentation: { slideIndex: 0, slideCount: 5 } }
    })
    renderSync()
    mockProject.mockClear()

    act(() => {
      useMediaProjectionStore.getState().setTypeState('presentation', {
        slideIndex: 1,
        slideCount: 5
      })
    })

    expect(mockProject).toHaveBeenCalledWith(
      'file:show',
      expect.objectContaining({
        itemId: 'deck',
        presentation: { slideIndex: 1, slideCount: 5 }
      })
    )
  })

  it('starts a newly presented media session without window policy options', () => {
    useMediaProjectionStore.setState({ isPresenting: false })
    renderSync()
    mockStartProjection.mockClear()

    act(() => {
      useMediaProjectionStore.setState({ isPresenting: true })
    })

    expect(mockStartProjection).toHaveBeenCalledWith('media', expect.any(Array))
  })

  it('reclaims Media ownership when an explicit start replaces retained Media controls', () => {
    projectionState.activeOwner = 'timer'
    renderSync()
    mockStartProjection.mockClear()

    act(() => {
      useMediaProjectionStore
        .getState()
        .startPresentation([makeFile('replacement', 'replacement.png')], 0)
    })

    expect(mockStartProjection).toHaveBeenCalledWith('media', expect.any(Array))
  })

  it('does not close projection after the Media close transaction already ended the session', () => {
    renderSync()
    mockStopProjection.mockClear()

    act(() => {
      useMediaProjectionStore.setState({ isPresenting: false })
    })

    expect(mockStopProjection).not.toHaveBeenCalled()
  })

  it('does not synchronize retained Media controls after another owner replaces it', () => {
    projectionState.activeOwner = 'timer'
    renderSync()
    mockProject.mockClear()
    mockStartProjection.mockClear()

    act(() => {
      useMediaProjectionStore.getState().jumpTo(1)
      useMediaProjectionStore.getState().setZoomLevel(1.5)
    })

    expect(mockStartProjection).not.toHaveBeenCalled()
    expect(mockProject).not.toHaveBeenCalled()
  })

  it('uses the current preflight-finalized editable document for its projection payload', async () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const activeSlideId = document.slideOrder[0]
    const calls: string[] = []
    const session = {
      commitDraft: vi.fn(() => calls.push('commit')),
      flush: vi.fn(async () => {
        calls.push('flush')
      }),
      getSnapshot: vi.fn(() => {
        calls.push('snapshot')
        return { history: { present: document } }
      })
    } as unknown as PresentationEditorSession
    registryMocks.get.mockReturnValue(session)
    usePresentationWorkspaceStore.getState().setActiveSlideId('editable-deck', activeSlideId)
    useMediaProjectionStore.setState({
      playlist: [makeFile('editable-deck', 'Sunday.lpdeck', EDITABLE_PRESENTATION_MIME_TYPE)],
      currentIndex: 0,
      isPresenting: true,
      typeStates: { presentation: { slideIndex: 0, slideCount: 1 } }
    })

    renderSync()

    await waitFor(() => expect(mockStartProjection).toHaveBeenCalledTimes(1))
    expect(registryMocks.finalizeAndFlush).not.toHaveBeenCalled()
    expect(calls).toEqual(['snapshot'])
    expect(mockStartProjection).toHaveBeenCalledWith('media', [
      [
        'file:show',
        expect.objectContaining({
          presentation: { slideIndex: 0, slideCount: 1 },
          editablePresentation: expect.objectContaining({
            slide: expect.objectContaining({ id: activeSlideId })
          })
        })
      ]
    ])
  })

  it('keeps media start and navigation state atomic when editable finalization is blocked', async () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const editable = makeFile('editable-deck', 'Sunday.lpdeck', EDITABLE_PRESENTATION_MIME_TYPE)
    const other = makeFile('other', 'other.png')
    const session = {
      getSnapshot: vi.fn(() => ({ history: { present: document } }))
    } as unknown as PresentationEditorSession
    registryMocks.get.mockReturnValue(session)
    registryMocks.finalizeAndFlush.mockResolvedValue(null)
    useMediaProjectionStore.setState({
      playlist: [],
      currentIndex: 0,
      isPresenting: false,
      sessionRevision: 7,
      snapshot: null
    })
    renderSync()

    const started = await useMediaProjectionStore.getState().startPresentation([editable], 0)

    expect(started).toEqual({ status: 'blocked' })
    expect(useMediaProjectionStore.getState()).toMatchObject({
      playlist: [],
      currentIndex: 0,
      isPresenting: false,
      sessionRevision: 7
    })
    expect(mockStartProjection).not.toHaveBeenCalled()

    useMediaProjectionStore.setState({
      playlist: [editable, other],
      currentIndex: 0,
      isPresenting: true,
      isEnded: false
    })
    const advanced = await useMediaProjectionStore.getState().next()
    expect(advanced).toEqual({ status: 'blocked' })
    expect(useMediaProjectionStore.getState().currentIndex).toBe(0)

    useMediaProjectionStore.setState({ currentIndex: 1 })
    const reversed = await useMediaProjectionStore.getState().prev()
    expect(reversed).toEqual({ status: 'blocked' })
    expect(useMediaProjectionStore.getState().currentIndex).toBe(1)
  })

  it('retries an editable start once after finalization succeeds', async () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const activeSlideId = document.slideOrder[0]
    const editable = makeFile('editable-deck', 'Sunday.lpdeck', EDITABLE_PRESENTATION_MIME_TYPE)
    const session = {
      getSnapshot: vi.fn(() => ({ history: { present: document } }))
    } as unknown as PresentationEditorSession
    registryMocks.get.mockReturnValue(session)
    registryMocks.finalizeAndFlush.mockResolvedValueOnce(null).mockResolvedValueOnce(document)
    usePresentationWorkspaceStore.getState().setActiveSlideId(editable.id, activeSlideId)
    useMediaProjectionStore.setState({ playlist: [], isPresenting: false, snapshot: null })
    renderSync()

    expect(await useMediaProjectionStore.getState().startPresentation([editable], 0)).toEqual({
      status: 'blocked'
    })
    expect(await useMediaProjectionStore.getState().startPresentation([editable], 0)).toEqual({
      status: 'success'
    })
    await waitFor(() => expect(mockStartProjection).toHaveBeenCalledTimes(1))
    expect(useMediaProjectionStore.getState()).toMatchObject({
      playlist: [editable],
      currentIndex: 0,
      isPresenting: true
    })
  })

  it('keeps editable start state unchanged when finalization rejects', async () => {
    const editable = makeFile('editable-deck', 'Sunday.lpdeck', EDITABLE_PRESENTATION_MIME_TYPE)
    const session = { getSnapshot: vi.fn() } as unknown as PresentationEditorSession
    registryMocks.get.mockReturnValue(session)
    registryMocks.finalizeAndFlush.mockRejectedValueOnce(new Error('persist failed'))
    useMediaProjectionStore.setState({
      playlist: [],
      currentIndex: 0,
      isPresenting: false,
      sessionRevision: 3,
      snapshot: null
    })
    renderSync()

    expect(await useMediaProjectionStore.getState().startPresentation([editable], 0)).toEqual({
      status: 'blocked'
    })
    expect(useMediaProjectionStore.getState()).toMatchObject({
      playlist: [],
      currentIndex: 0,
      isPresenting: false,
      sessionRevision: 3
    })
    expect(mockStartProjection).not.toHaveBeenCalled()
  })

  it('does not start from a finalized document after that editable session is replaced', async () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const editable = makeFile('editable-deck', 'Sunday.lpdeck', EDITABLE_PRESENTATION_MIME_TYPE)
    const pending = deferred<typeof document>()
    const closingSession = {
      getSnapshot: vi.fn(() => ({
        history: { present: document },
        draftKind: 'text',
        save: { status: 'pending' }
      }))
    } as unknown as PresentationEditorSession
    const reopenedSession = {
      getSnapshot: vi.fn(() => ({ history: { present: document } }))
    } as unknown as PresentationEditorSession
    registryMocks.get.mockReturnValue(closingSession)
    registryMocks.finalizeAndFlush.mockReturnValue(pending.promise)
    useMediaProjectionStore.setState({
      playlist: [],
      currentIndex: 0,
      isPresenting: false,
      sessionRevision: 11,
      snapshot: null
    })
    resetMediaProjectionPreflightForTests()
    const rendered = renderSync()
    await act(async () => {
      await Promise.resolve()
    })

    const start = useMediaProjectionStore.getState().startPresentation([editable], 0)
    await waitFor(() => expect(registryMocks.finalizeAndFlush).toHaveBeenCalledWith(editable.id))
    registryMocks.get.mockReturnValue(reopenedSession)
    pending.resolve(document)

    expect(await start).toEqual({ status: 'superseded' })
    expect(useMediaProjectionStore.getState()).toMatchObject({
      isPresenting: false,
      sessionRevision: 11
    })
    expect(mockStartProjection).not.toHaveBeenCalled()
    rendered.unmount()
  })

  it('does not republish editable ownership after an in-flight start is ended', async () => {
    const closingDocument = createBlankEditablePresentationDocument('Closing')
    const reopenedBase = createBlankEditablePresentationDocument('Reopened')
    const reopenedDocument = addElementToSlide(
      reopenedBase,
      reopenedBase.slideOrder[0],
      createTextElement({ text: 'Reopened session' })
    )
    const editable = makeFile('editable-deck', 'Sunday.lpdeck', EDITABLE_PRESENTATION_MIME_TYPE)
    const pending = deferred<typeof closingDocument>()
    const closingSession = {
      getSnapshot: vi.fn(() => ({
        history: { present: closingDocument },
        draftKind: 'text',
        save: { status: 'pending' }
      }))
    } as unknown as PresentationEditorSession
    const reopenedSession = {
      getSnapshot: vi.fn(() => ({
        history: { present: reopenedDocument },
        draftKind: null,
        save: { status: 'saved' }
      }))
    } as unknown as PresentationEditorSession
    registryMocks.get.mockReturnValue(closingSession)
    registryMocks.finalizeAndFlush.mockReturnValue(pending.promise)
    useMediaProjectionStore.setState({ playlist: [], isPresenting: false, snapshot: null })
    renderSync()

    const start = useMediaProjectionStore.getState().startPresentation([editable], 0)
    await waitFor(() => expect(registryMocks.finalizeAndFlush).toHaveBeenCalledWith(editable.id))
    act(() => useMediaProjectionStore.getState().endLiveSession())
    pending.resolve(closingDocument)
    expect(await start).toEqual({ status: 'superseded' })
    registryMocks.get.mockReturnValue(reopenedSession)

    mockStartProjection.mockClear()
    act(() => {
      useMediaProjectionStore.setState({
        playlist: [editable],
        currentIndex: 0,
        isPresenting: true,
        sessionRevision: 2,
        snapshot: {
          id: 'resumed',
          createdAt: 2,
          entries: [
            {
              index: 0,
              itemId: editable.id,
              blobId: editable.id,
              name: editable.name,
              mimeType: editable.mimeType,
              sourceUrl: editable.url
            }
          ]
        }
      })
    })

    await waitFor(() => expect(mockStartProjection).toHaveBeenCalledOnce())
    expect(mockStartProjection.mock.calls[0]?.[1][0]?.[1]).toMatchObject({
      editablePresentation: expect.objectContaining({
        slide: expect.objectContaining({
          elements: expect.objectContaining({
            [reopenedDocument.slides[reopenedDocument.slideOrder[0]].elementOrder[0]]:
              expect.objectContaining({ text: 'Reopened session' })
          })
        })
      })
    })
  })

  it('revalidates a clean editable session at the store commit boundary', async () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const replacementDocument = createBlankEditablePresentationDocument('Replacement')
    const editable = makeFile('editable-deck', 'Sunday.lpdeck', EDITABLE_PRESENTATION_MIME_TYPE)
    const closingSession = {
      getSnapshot: vi.fn(() => ({
        history: { present: document },
        draftKind: null,
        save: { status: 'saved' }
      }))
    } as unknown as PresentationEditorSession
    const replacementSession = {
      getSnapshot: vi.fn(() => ({
        history: { present: replacementDocument },
        draftKind: null,
        save: { status: 'saved' }
      }))
    } as unknown as PresentationEditorSession
    registryMocks.get.mockReturnValue(closingSession)
    useMediaProjectionStore.setState({
      playlist: [],
      currentIndex: 0,
      isPresenting: false,
      sessionRevision: 12,
      snapshot: null
    })
    renderSync()

    const staleStart = useMediaProjectionStore.getState().startPresentation([editable], 0)
    registryMocks.get.mockReturnValue(replacementSession)

    expect(await staleStart).toEqual({ status: 'superseded' })
    expect(useMediaProjectionStore.getState()).toMatchObject({
      isPresenting: false,
      sessionRevision: 12
    })
    expect(mockStartProjection).not.toHaveBeenCalled()

    expect(await useMediaProjectionStore.getState().startPresentation([editable], 0)).toEqual({
      status: 'success'
    })
    await waitFor(() => expect(mockStartProjection).toHaveBeenCalledTimes(1))
  })

  it('releases editable ownership when a media session ends', async () => {
    const firstDocument = createBlankEditablePresentationDocument('First')
    const secondBase = createBlankEditablePresentationDocument('Second')
    const secondDocument = addElementToSlide(
      secondBase,
      secondBase.slideOrder[0],
      createTextElement({ text: 'Current session' })
    )
    const editable = makeFile('editable-deck', 'Sunday.lpdeck', EDITABLE_PRESENTATION_MIME_TYPE)
    const firstSession = {
      getSnapshot: vi.fn(() => ({
        history: { present: firstDocument },
        draftKind: null,
        save: { status: 'saved' }
      }))
    } as unknown as PresentationEditorSession
    const secondSession = {
      getSnapshot: vi.fn(() => ({
        history: { present: secondDocument },
        draftKind: null,
        save: { status: 'saved' }
      }))
    } as unknown as PresentationEditorSession
    registryMocks.get.mockReturnValue(firstSession)
    useMediaProjectionStore.setState({ playlist: [], isPresenting: false, snapshot: null })
    renderSync()

    expect(await useMediaProjectionStore.getState().startPresentation([editable], 0)).toEqual({
      status: 'success'
    })
    await waitFor(() => expect(mockStartProjection).toHaveBeenCalledOnce())

    act(() => useMediaProjectionStore.getState().endLiveSession())
    registryMocks.get.mockReturnValue(secondSession)
    mockStartProjection.mockClear()
    act(() => {
      useMediaProjectionStore.setState({
        playlist: [editable],
        currentIndex: 0,
        isPresenting: true,
        sessionRevision: 2,
        snapshot: {
          id: 'resumed',
          createdAt: 2,
          entries: [
            {
              index: 0,
              itemId: editable.id,
              blobId: editable.id,
              name: editable.name,
              mimeType: editable.mimeType,
              sourceUrl: editable.url
            }
          ]
        }
      })
    })

    await waitFor(() => expect(mockStartProjection).toHaveBeenCalledOnce())
    expect(mockStartProjection).toHaveBeenCalledWith('media', [
      [
        'file:show',
        expect.objectContaining({
          editablePresentation: expect.objectContaining({
            slide: expect.objectContaining({
              elements: expect.objectContaining({
                [secondDocument.slides[secondDocument.slideOrder[0]].elementOrder[0]]:
                  expect.objectContaining({ type: 'text', text: 'Current session' })
              })
            })
          })
        })
      ]
    ])
  })

  it('does not project a deferred remote source after an explicit replacement start', async () => {
    const pending = deferred<{
      providerConnectionId: string
      remoteItemId: string
      rootRemoteFolderId: string
      source: { kind: 'ticket'; url: string; expiresAt: number; etag: string }
    }>()
    setRemotePresentationItem()
    remoteMocks.prepare.mockReturnValueOnce(pending.promise)
    renderSync({
      auth: {
        getSession: () => ({ userId: 'user-1', displayName: 'Ada', roles: [] }),
        getAccessToken: vi.fn(),
        refreshAfterUnauthorized: vi.fn(),
        endSession: vi.fn()
      }
    })
    await waitFor(() => expect(remoteMocks.prepare).toHaveBeenCalledOnce())

    const replacement = makeFile('replacement', 'replacement.png')
    expect(await useMediaProjectionStore.getState().startPresentation([replacement], 0)).toBe(true)
    mockStartProjection.mockClear()
    pending.resolve({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'asset-1',
      rootRemoteFolderId: 'collection-1',
      source: {
        kind: 'ticket',
        url: 'https://www.alive.org.tw/api/assets/content?ticket=stale',
        expiresAt: Date.now() + 60_000,
        etag: 'etag-1'
      }
    })
    await act(async () => {
      await pending.promise
    })

    expect(useMediaProjectionStore.getState().currentItem()?.id).toBe(replacement.id)
    expect(mockStartProjection).not.toHaveBeenCalled()
  })

  it('abandons an explicit no-session fallback when a same-id session appears during loading', async () => {
    const editable = makeFile('editable-deck', 'Sunday.lpdeck', EDITABLE_PRESENTATION_MIME_TYPE)
    const pending = deferred<unknown>()
    payloadMocks.fallback.mockReturnValueOnce(pending.promise)
    useMediaProjectionStore.setState({
      playlist: [],
      currentIndex: 0,
      isPresenting: false,
      sessionRevision: 20,
      snapshot: null
    })
    registryMocks.get.mockReturnValue(undefined)
    renderSync()

    expect(await useMediaProjectionStore.getState().startPresentation([editable], 0)).toEqual({
      status: 'success'
    })
    await waitFor(() => expect(payloadMocks.fallback).toHaveBeenCalledOnce())
    registryMocks.get.mockReturnValue({
      getSnapshot: vi.fn()
    } as unknown as PresentationEditorSession)
    pending.resolve({ itemId: editable.id })

    await act(async () => {
      await pending.promise
    })

    expect(mockStartProjection).not.toHaveBeenCalled()
    expect(mockProject).not.toHaveBeenCalledWith('file:show', expect.anything())
  })

  it('abandons a session-owned editable payload when that session is replaced during source loading', async () => {
    const document = createBlankEditablePresentationDocument('Sunday')
    const replacementBase = createBlankEditablePresentationDocument('Replacement')
    const replacementText = createTextElement({ text: 'Replacement document content' })
    const replacementDocument = addElementToSlide(
      replacementBase,
      replacementBase.slideOrder[0],
      replacementText
    )
    const editable = makeFile('editable-deck', 'Sunday.lpdeck', EDITABLE_PRESENTATION_MIME_TYPE)
    const pending = deferred<{
      providerConnectionId: string
      remoteItemId: string
      rootRemoteFolderId: string
      source: { kind: 'ticket'; url: string; expiresAt: number; etag: string }
    }>()
    const session = {
      getSnapshot: vi.fn(() => ({
        history: { present: document },
        draftKind: null,
        save: { status: 'saved' }
      }))
    } as unknown as PresentationEditorSession
    const replacement = {
      getSnapshot: vi.fn(() => ({
        history: { present: replacementDocument },
        draftKind: null,
        save: { status: 'saved' }
      }))
    } as unknown as PresentationEditorSession
    registryMocks.get.mockReturnValue(session)
    projectionState.activeOwner = 'timer'
    const rendered = renderSync({
      auth: {
        getSession: () => ({ userId: 'user-1', displayName: 'Ada', roles: [] }),
        getAccessToken: vi.fn(),
        refreshAfterUnauthorized: vi.fn(),
        endSession: vi.fn()
      }
    })
    expect(await useMediaProjectionStore.getState().startPresentation([editable], 0)).toEqual({
      status: 'success'
    })
    mockStartProjection.mockClear()
    projectionState.activeOwner = 'media'
    rendered.rerender()
    const remoteEntry = {
      index: 0,
      itemId: editable.id,
      blobId: editable.id,
      name: editable.name,
      mimeType: editable.mimeType,
      sourceUrl: editable.url,
      remoteItem: {
        providerConnectionId: 'hhc-line:user-1',
        remoteItemId: 'asset-1',
        rootRemoteFolderId: 'collection-1'
      }
    }
    useMediaProjectionStore.setState({
      snapshot: { id: 'snapshot', createdAt: 1, entries: [remoteEntry] },
      isEnded: true
    })
    remoteMocks.prepare.mockReturnValueOnce(pending.promise)
    useMediaProjectionStore.setState({ isEnded: false })
    await waitFor(() => expect(remoteMocks.prepare).toHaveBeenCalledOnce())

    registryMocks.get.mockReturnValue(replacement)
    pending.resolve({
      providerConnectionId: 'hhc-line:user-1',
      remoteItemId: 'asset-1',
      rootRemoteFolderId: 'collection-1',
      source: {
        kind: 'ticket',
        url: 'https://www.alive.org.tw/api/assets/content?ticket=stale',
        expiresAt: Date.now() + 60_000,
        etag: 'etag-1'
      }
    })
    await act(async () => {
      await pending.promise
    })

    expect(mockStartProjection).not.toHaveBeenCalled()
    expect(mockProject).not.toHaveBeenCalledWith('file:show', expect.anything())

    expect(await useMediaProjectionStore.getState().startPresentation([editable], 0)).toEqual({
      status: 'success'
    })
    await waitFor(() => expect(mockStartProjection).toHaveBeenCalledOnce())
    const payload = mockStartProjection.mock.calls[0]?.[1][0]?.[1]
    expect(payload?.editablePresentation?.slide.elements[replacementText.id]).toMatchObject({
      text: 'Replacement document content'
    })
  })
})
