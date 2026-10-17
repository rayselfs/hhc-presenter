import { useItemSelection } from '@renderer/hooks/useItemSelection'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FileBrowser from '../FileBrowser'
import {
  FILE_EXPLORER_ROOT_ID,
  useFileExplorerSearch,
  useFileExplorerSettings,
  useFileExplorerStore
} from '@renderer/stores/file-explorer'
import { EDITABLE_PRESENTATION_MIME_TYPE, PPTX_MIME_TYPE } from '@renderer/lib/presentation-media'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import type { FileItemRecord, FolderRecord } from '@shared/types/folder'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  ensureProjectionOpen: vi.fn(() => Promise.resolve()),
  startMediaProjection: vi.fn()
}))

vi.mock('@renderer/contexts/ProjectionContext', () => ({
  useProjection: () => ({ ensureProjectionOpen: mocks.ensureProjectionOpen })
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mocks.navigate
  }
})

vi.mock('@renderer/lib/projection-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/projection-actions')>()),
  startMediaProjection: mocks.startMediaProjection
}))

vi.mock('@renderer/contexts/ConfirmDialogContext', () => ({
  useConfirm: () => vi.fn(async () => true)
}))

vi.mock('@heroui/react/toast', () => ({
  toast: {
    warning: vi.fn(),
    danger: vi.fn(),
    success: vi.fn()
  }
}))

vi.mock('@renderer/lib/sync-db', () => ({
  SYNC_ENTRY_CHANGED_EVENT: 'hhc:test-sync-entry-changed',
  listSyncEntries: vi.fn(() => new Promise(() => {}))
}))

vi.mock('@renderer/hooks/useThumbnails', () => ({
  canHaveThumbnail: () => false,
  useThumbnails: () => ({})
}))

function makeRootFolder(): FolderRecord {
  return {
    id: FILE_EXPLORER_ROOT_ID,
    name: 'Files',
    parentId: null,
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null
  }
}

function makeFile(overrides: Partial<FileItemRecord>): FileItemRecord {
  return {
    id: 'file-1',
    parentId: FILE_EXPLORER_ROOT_ID,
    type: 'file',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    name: 'file.png',
    url: 'blob:file-1',
    size: 100,
    mimeType: 'image/png',
    ...overrides
  }
}

async function renderWithItems(items: readonly FileItemRecord[]): Promise<void> {
  const root = makeRootFolder()
  act(() => {
    useFileExplorerStore.setState({
      folders: { [root.id]: root },
      items: Object.fromEntries(items.map((item) => [item.id, item])),
      _foldersArray: [root],
      _itemsArray: [...items],
      _childFoldersByParent: { [FILE_EXPLORER_ROOT_ID]: [] },
      _itemsByParent: { [FILE_EXPLORER_ROOT_ID]: [...items] },
      loadedParents: new Set([FILE_EXPLORER_ROOT_ID]),
      currentFolderId: FILE_EXPLORER_ROOT_ID,
      isLoading: false,
      isInitialized: true
    })
  })

  render(<SelectedFileBrowser />)
  await act(async () => undefined)
}

describe('FileBrowser presentation open behavior', () => {
  beforeEach(() => {
    mocks.navigate.mockClear()
    mocks.ensureProjectionOpen.mockClear()
    mocks.startMediaProjection.mockClear()
    act(() => {
      usePresentationWorkspaceStore.setState({
        documents: [],
        activeItemId: null,
        activeSlideIdByItemId: {}
      })
      useFileExplorerSearch.setState({ searchQuery: '' })
      useFileExplorerSettings.setState({
        viewMode: 'medium-icon',
        sortField: 'createdAt',
        sortDir: 'none'
      })
    })
  })

  it('opens an imported PPTX in the presentation workspace when double-clicked', async () => {
    const deck = makeFile({ id: 'deck-1', name: 'Deck.pptx', mimeType: PPTX_MIME_TYPE })
    await renderWithItems([deck])

    act(() => {
      fireEvent.doubleClick(screen.getByText('Deck.pptx'))
    })

    expect(usePresentationWorkspaceStore.getState().activeItemId).toBe('deck-1')
    expect(mocks.navigate).toHaveBeenCalledWith('/presentations/deck-1')
    expect(mocks.startMediaProjection).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'image', name: 'Photo.png', mimeType: 'image/png' },
    { kind: 'video', name: 'Clip.mp4', mimeType: 'video/mp4' }
  ])('starts a ready $kind projection and enters Media when double-clicked', async (media) => {
    const item = makeFile({ id: `${media.kind}-1`, name: media.name, mimeType: media.mimeType })
    mocks.startMediaProjection.mockResolvedValue({
      summary: { ready: 1, preparing: 0, unsupported: 0, missing: 0, failed: 0 },
      items: [
        {
          itemId: item.id,
          blobId: item.id,
          status: 'ready',
          reason: 'ready',
          support: 'native'
        }
      ]
    })
    await renderWithItems([item])

    await act(async () => {
      fireEvent.doubleClick(screen.getByText(media.name))
      await Promise.resolve()
    })

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/media'))
    expect(mocks.startMediaProjection).toHaveBeenCalledWith([item], 0, expect.any(Object), {
      prioritizeStartItem: true
    })
    expect(usePresentationWorkspaceStore.getState().documents).toEqual([])
  })

  it('keeps the current route when image projection has no ready items', async () => {
    const image = makeFile({ id: 'image-1', name: 'Photo.png', mimeType: 'image/png' })
    mocks.startMediaProjection.mockResolvedValue({
      summary: { ready: 0, preparing: 0, unsupported: 1, missing: 0, failed: 0 },
      items: []
    })
    await renderWithItems([image])

    await act(async () => {
      fireEvent.doubleClick(screen.getByText('Photo.png'))
      await Promise.resolve()
    })

    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('keeps the current route when image projection preparation rejects', async () => {
    const image = makeFile({ id: 'image-1', name: 'Photo.png', mimeType: 'image/png' })
    mocks.startMediaProjection.mockRejectedValue(new Error('preparation failed'))
    await renderWithItems([image])

    await act(async () => {
      fireEvent.doubleClick(screen.getByText('Photo.png'))
      await Promise.resolve()
    })

    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('enters Media after Shift+F5 starts a ready projection', async () => {
    const image = makeFile({ id: 'image-1', name: 'Photo.png', mimeType: 'image/png' })
    mocks.startMediaProjection.mockResolvedValue({
      summary: { ready: 1, preparing: 0, unsupported: 0, missing: 0, failed: 0 },
      items: []
    })
    await renderWithItems([image])

    fireEvent.keyDown(document, { code: 'F5', key: 'F5', shiftKey: true })

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/media'))
  })

  it('stays in Files when Shift+F5 preparation fails', async () => {
    const image = makeFile({ id: 'image-1', name: 'Photo.png', mimeType: 'image/png' })
    mocks.startMediaProjection.mockRejectedValue(new Error('preparation failed'))
    await renderWithItems([image])

    fireEvent.keyDown(document, { code: 'F5', key: 'F5', shiftKey: true })
    await act(async () => Promise.resolve())

    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('starts PDF projection when double-clicked', async () => {
    const pdf = makeFile({ id: 'pdf-1', name: 'Program.pdf', mimeType: 'application/pdf' })
    mocks.startMediaProjection.mockResolvedValue({
      summary: { ready: 1, preparing: 0, unsupported: 0, missing: 0, failed: 0 },
      items: [
        {
          itemId: pdf.id,
          blobId: pdf.id,
          status: 'ready',
          reason: 'ready',
          support: 'native'
        }
      ]
    })
    await renderWithItems([pdf])

    await act(async () => {
      fireEvent.doubleClick(screen.getByText('Program.pdf'))
      await Promise.resolve()
    })

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/media'))
    expect(mocks.startMediaProjection).toHaveBeenCalledWith([pdf], 0, expect.any(Object), {
      prioritizeStartItem: true
    })
  })

  it('keeps PPTX out of a direct media projection playlist', async () => {
    const image = makeFile({ id: 'image-1', name: 'Photo.png', mimeType: 'image/png' })
    const video = makeFile({ id: 'video-1', name: 'Clip.mp4', mimeType: 'video/mp4' })
    const deck = makeFile({ id: 'deck-1', name: 'Deck.pptx', mimeType: PPTX_MIME_TYPE })
    mocks.startMediaProjection.mockResolvedValue({
      summary: { ready: 1, preparing: 0, unsupported: 0, missing: 0, failed: 0 },
      items: [{ itemId: image.id, status: 'ready' }]
    })
    await renderWithItems([image, video, deck])

    await act(async () => {
      fireEvent.doubleClick(screen.getByText('Photo.png'))
      await Promise.resolve()
    })

    expect(mocks.startMediaProjection).toHaveBeenCalledWith([image, video], 0, expect.any(Object), {
      prioritizeStartItem: true
    })
  })

  it('starts a selected PPTX alone at index zero with Shift+F5', async () => {
    const image = makeFile({ id: 'image-1', name: 'Photo.png', mimeType: 'image/png' })
    const video = makeFile({ id: 'video-1', name: 'Clip.mp4', mimeType: 'video/mp4' })
    const deck = makeFile({ id: 'deck-1', name: 'Deck.pptx', mimeType: PPTX_MIME_TYPE })
    mocks.startMediaProjection.mockResolvedValue({
      summary: { ready: 1, preparing: 0, unsupported: 0, missing: 0, failed: 0 },
      items: [{ itemId: deck.id, status: 'ready' }]
    })
    await renderWithItems([image, video, deck])
    fireEvent.click(screen.getByText('Deck.pptx'))

    fireEvent.keyDown(document, { code: 'F5', key: 'F5', shiftKey: true })

    await waitFor(() =>
      expect(mocks.startMediaProjection).toHaveBeenCalledWith([deck], 0, expect.any(Object), {
        prioritizeStartItem: true
      })
    )
  })

  it('opens an editable presentation in the presentation workspace', async () => {
    const deck = makeFile({
      id: 'deck-1',
      name: 'Deck.presentation',
      mimeType: EDITABLE_PRESENTATION_MIME_TYPE
    })
    await renderWithItems([deck])

    act(() => {
      fireEvent.doubleClick(screen.getByText('Deck.presentation'))
    })

    expect(usePresentationWorkspaceStore.getState().activeItemId).toBe('deck-1')
    expect(mocks.navigate).toHaveBeenCalledWith('/presentations/deck-1')
    expect(mocks.startMediaProjection).not.toHaveBeenCalled()
  })

  it('opens an imported PPTX search result in the presentation workspace', async () => {
    const deck = makeFile({
      id: 'deck-1',
      name: 'Deck.pptx',
      mimeType: PPTX_MIME_TYPE,
      createdAt: new Date(2026, 8, 4, 22, 3, 5).getTime()
    })
    act(() => {
      useFileExplorerSearch.setState({ searchQuery: 'Deck' })
    })
    await renderWithItems([deck])
    expect(screen.getByText('2026/09/04 22:03:05')).toBeInTheDocument()

    act(() => {
      fireEvent.doubleClick(screen.getByText('Deck.pptx'))
    })

    expect(usePresentationWorkspaceStore.getState().activeItemId).toBe('deck-1')
    expect(mocks.navigate).toHaveBeenCalledWith('/presentations/deck-1')
    expect(mocks.startMediaProjection).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'Photo.png', mimeType: 'image/png' },
    { name: 'Clip.mp4', mimeType: 'video/mp4' }
  ])('projects a ready search result for $mimeType instead of opening preview', async (media) => {
    const item = makeFile({ id: 'search-media', name: media.name, mimeType: media.mimeType })
    mocks.startMediaProjection.mockResolvedValue({
      summary: { ready: 1, preparing: 0, unsupported: 0, missing: 0, failed: 0 },
      items: [
        {
          itemId: item.id,
          blobId: item.id,
          status: 'ready',
          reason: 'ready',
          support: 'native'
        }
      ]
    })
    act(() => useFileExplorerSearch.setState({ searchQuery: media.name }))
    await renderWithItems([item])

    await act(async () => {
      fireEvent.doubleClick(screen.getByText(media.name))
      await Promise.resolve()
    })

    expect(mocks.startMediaProjection).toHaveBeenCalledWith(
      [item],
      0,
      { ensureProjectionOpen: mocks.ensureProjectionOpen },
      {
        prioritizeStartItem: true
      }
    )
    expect(mocks.navigate).toHaveBeenCalledWith('/media')
  })

  it('shows safe error health for an access-revoked sync root', async () => {
    const root = makeRootFolder()
    const revoked: FolderRecord = {
      id: 'revoked-root',
      name: 'Revoked collection',
      parentId: FILE_EXPLORER_ROOT_ID,
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null,
      syncLink: {
        providerConnectionId: 'hhc-line:user-1',
        providerType: 'hhc-line',
        remoteFolderId: 'collection-1',
        offlinePolicy: 'online-only',
        status: 'access-revoked'
      }
    }
    act(() => {
      useFileExplorerStore.setState({
        folders: { [root.id]: root, [revoked.id]: revoked },
        items: {},
        _foldersArray: [root, revoked],
        _itemsArray: [],
        _childFoldersByParent: { [FILE_EXPLORER_ROOT_ID]: [revoked] },
        _itemsByParent: { [FILE_EXPLORER_ROOT_ID]: [] },
        loadedParents: new Set([FILE_EXPLORER_ROOT_ID]),
        currentFolderId: FILE_EXPLORER_ROOT_ID,
        isLoading: false,
        isInitialized: true
      })
    })

    render(<SelectedFileBrowser />)

    expect(await screen.findByLabelText('Sync error')).toBeInTheDocument()
    expect(screen.queryByText(/401|403|authorization|forbidden/i)).not.toBeInTheDocument()
  })
})

function SelectedFileBrowser(): React.JSX.Element {
  const selection = useItemSelection()
  return <FileBrowser selection={selection} />
}
