import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudRemoteFolder } from '@renderer/lib/cloud-provider'
import type { FolderRecord } from '@shared/types/folder'
import type { HhcSession } from '@shared/hhc-auth'

const mocks = vi.hoisted(() => ({
  listFolders: vi.fn<() => Promise<CloudRemoteFolder[]>>(),
  session: null as HhcSession | null,
  getAccessToken: vi.fn<() => Promise<string | null>>(),
  refreshAfterUnauthorized: vi.fn<() => Promise<string | null>>(),
  getCloudProviderAdapter: vi.fn((providerId: string) => ({
    id: providerId,
    supportsFolderNavigation: providerId === 'hhc-line' ? false : undefined,
    getConnectedAccount: vi.fn(async () => null),
    listFolders: vi.fn<() => Promise<CloudRemoteFolder[]>>(async () => []),
    importFolder: vi.fn(),
    refreshFolder: vi.fn()
  })),
  showEmptyAreaMenu: vi.fn(),
  copyExplorerFolder: vi.fn(async () => 'copy'),
  createExplorerFolder: vi.fn(async () => 'folder'),
  fileState: {
    currentFolderId: 'file-root',
    folders: {} as Record<string, FolderRecord>,
    items: {},
    _foldersArray: [],
    _itemsByParent: {},
    _childFoldersByParent: {},
    persistenceStatus: 'ready',
    persistenceError: null,
    pendingPersistenceCount: 0,
    isInitialized: true,
    getChildFolders: vi.fn(() => []),
    getItems: vi.fn(() => []),
    addFolder: vi.fn(),
    ensureItemsLoaded: vi.fn(async () => undefined),
    moveItem: vi.fn(),
    moveFolder: vi.fn(),
    updateFolder: vi.fn(),
    retryInitialization: vi.fn(),
    retryPersistence: vi.fn()
  }
}))

vi.mock('@renderer/contexts/HhcAuthContext', () => ({
  useHhcAuth: () => ({
    status: mocks.session ? 'authenticated' : 'anonymous',
    session: mocks.session,
    signIn: vi.fn(),
    signOut: vi.fn(),
    getAccessToken: mocks.getAccessToken,
    refreshAfterUnauthorized: mocks.refreshAfterUnauthorized
  })
}))

vi.mock('react-router-dom', () => ({
  Outlet: () => null,
  useNavigate: () => vi.fn()
}))

vi.mock('@renderer/stores/file-explorer', () => ({
  copyExplorerFile: vi.fn(),
  createExplorerFolder: mocks.createExplorerFolder,
  copyExplorerFolder: mocks.copyExplorerFolder,
  FILE_EXPLORER_ROOT_ID: 'file-root',
  useFileExplorerStore: Object.assign(
    (selector: (state: typeof mocks.fileState) => unknown) => selector(mocks.fileState),
    { getState: () => mocks.fileState }
  ),
  deleteFolderFromStore: vi.fn(),
  removeFileItemFromStore: vi.fn()
}))

vi.mock('@renderer/components/Control/FileExplorer', () => ({
  FileExplorerShell: ({
    children,
    actionContent,
    selectedCount
  }: {
    children: React.ReactNode
    actionContent?: React.ReactNode
    selectedCount: number
  }) => (
    <>
      {children}
      {actionContent}
      <span data-testid="selected-count">{selectedCount}</span>
    </>
  ),
  useFileContextMenu: () => ({
    showItemMenu: vi.fn(),
    showFolderMenu: vi.fn(),
    showMultiSelectMenu: vi.fn(),
    showEmptyAreaMenu: mocks.showEmptyAreaMenu
  })
}))

vi.mock('@renderer/components/Control/FileExplorer/FileBrowser', () => ({
  default: ({
    onEmptyAreaContextMenu,
    onCopy,
    onSelectionChange
  }: {
    onEmptyAreaContextMenu: (event: React.MouseEvent) => void
    onCopy: (ids: Set<string>) => void
    onSelectionChange: (ids: Set<string>) => void
  }) => (
    <>
      <button onClick={() => onEmptyAreaContextMenu({} as React.MouseEvent)}>
        Open file context menu
      </button>
      <button
        onClick={() => {
          onSelectionChange(new Set(['A']))
          onCopy(new Set(['A']))
        }}
      >
        Copy folder A
      </button>
    </>
  )
}))
vi.mock('@renderer/components/Control/FileExplorer/FileExplorerFAB', () => ({
  default: ({
    onAddHhcLine,
    isAddHhcLineDisabled
  }: {
    onAddHhcLine?: () => void
    isAddHhcLineDisabled?: boolean
  }) => (
    <button disabled={isAddHhcLineDisabled} onClick={onAddHhcLine}>
      Sync LINE group
    </button>
  )
}))
vi.mock('@renderer/components/Control/FileExplorer/CloudFolderPickerDialog', () => ({
  default: ({
    provider,
    isOpen
  }: {
    provider: { providerType: string; displayName: string; icon: React.ReactNode }
    isOpen: boolean
  }) =>
    provider.providerType === 'hhc-line' && isOpen ? (
      <div>
        {provider.icon}
        {provider.displayName} picker open
      </div>
    ) : null
}))
vi.mock('@renderer/components/Control/Folder/FolderModal', () => ({ FolderModal: () => null }))
vi.mock('@renderer/components/Common/FolderPersistenceStatus', () => ({
  FolderPersistenceStatus: () => null
}))
vi.mock('@renderer/contexts/ConfirmDialogContext', () => ({ useConfirm: () => vi.fn() }))
vi.mock('@renderer/stores/soundboard', () => ({
  useSoundboardStore: { getState: () => ({ findPadsUsingAsset: () => [] }) }
}))
vi.mock('@renderer/lib/cloud-provider', () => ({
  getCloudProviderAdapter: mocks.getCloudProviderAdapter
}))
vi.mock('@renderer/lib/editable-presentation', () => ({ createEditablePresentation: vi.fn() }))
vi.mock('@renderer/lib/local-sync-import', () => ({
  connectLocalSyncFolder: vi.fn(),
  refreshLocalSyncConnection: vi.fn()
}))
vi.mock('@renderer/lib/upload-utils', () => ({
  getUploadMediaPlatform: () => 'web',
  uploadFiles: vi.fn(),
  uploadFolderFiles: vi.fn()
}))
vi.mock('@renderer/lib/presentation-item-actions', () => ({
  buildPresentationItemActions: () => []
}))
vi.mock('@renderer/stores/presentation-workspace', () => ({
  usePresentationWorkspaceStore: { getState: () => ({ openDocument: vi.fn() }) }
}))

import FilesPage from '../FilesPage'

describe('FilesPage HHC LINE role resolution', () => {
  beforeEach(() => {
    mocks.session = {
      userId: 'user-1',
      displayName: 'Ada',
      roles: ['media_sync_user']
    }
    mocks.listFolders
      .mockReset()
      .mockResolvedValue([{ remoteItemId: 'folder', name: 'Group', parentRemoteItemId: null }])
    mocks.getAccessToken.mockReset()
    mocks.refreshAfterUnauthorized.mockReset()
    mocks.getCloudProviderAdapter.mockReset()
    mocks.showEmptyAreaMenu.mockReset()
    mocks.getCloudProviderAdapter.mockImplementation((providerId: string) => ({
      id: providerId,
      supportsFolderNavigation: providerId === 'hhc-line' ? false : undefined,
      getConnectedAccount: vi.fn(async () => null),
      listFolders: mocks.listFolders,
      importFolder: vi.fn(),
      refreshFolder: vi.fn()
    }))
  })

  it('keeps HHC LINE visible and disabled while folders for the current user resolve', async () => {
    let resolveToken!: (folders: CloudRemoteFolder[]) => void
    mocks.listFolders.mockReturnValue(
      new Promise((resolve) => {
        resolveToken = resolve
      })
    )
    const view = render(<FilesPage />)

    expect(screen.getByRole('button', { name: 'Sync LINE group' })).toBeDisabled()
    expect(mocks.listFolders).toHaveBeenCalledTimes(1)

    await act(async () =>
      resolveToken([{ remoteItemId: 'folder', name: 'Group', parentRemoteItemId: null }])
    )
    expect(await screen.findByRole('button', { name: 'Sync LINE group' })).toBeEnabled()
    view.rerender(<FilesPage />)
    expect(mocks.listFolders).toHaveBeenCalledTimes(1)
    expect(mocks.getCloudProviderAdapter).toHaveBeenCalledWith(
      'hhc-line',
      expect.objectContaining({
        getAccessToken: mocks.getAccessToken,
        refreshAfterUnauthorized: mocks.refreshAfterUnauthorized
      })
    )
  })

  it('allows the Asset API to resolve folder access without a client-side role gate', async () => {
    mocks.session = { userId: 'user-1', displayName: 'Ada', roles: ['reader'] }
    mocks.getAccessToken.mockResolvedValue('token')
    render(<FilesPage />)

    const action = await screen.findByRole('button', { name: 'Sync LINE group' })
    await waitFor(() => expect(action).toBeEnabled())
    await userEvent.click(action)
    expect(screen.getByText('LINE media picker open')).toBeInTheDocument()
  })

  it('disables an empty ACL result and recovers when a folder becomes available', async () => {
    mocks.listFolders.mockResolvedValueOnce([])
    render(<FilesPage />)
    await waitFor(() => expect(mocks.listFolders).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Sync LINE group' })).toBeDisabled()
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sync LINE group' })).toBeEnabled()
    )
  })

  it('disables after the only eligible collection is imported and re-enables for a new one', async () => {
    mocks.listFolders
      .mockResolvedValueOnce([{ remoteItemId: 'only', name: 'Only', parentRemoteItemId: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ remoteItemId: 'new', name: 'New', parentRemoteItemId: null }])
    render(<FilesPage />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sync LINE group' })).toBeEnabled()
    )

    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(mocks.listFolders).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Sync LINE group' })).toBeDisabled()

    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sync LINE group' })).toBeEnabled()
    )
    expect(mocks.listFolders).toHaveBeenCalledTimes(3)
  })

  it('keeps HHC LINE visible and disabled while signed out', () => {
    mocks.session = null
    render(<FilesPage />)

    expect(screen.getByRole('button', { name: 'Sync LINE group' })).toBeDisabled()
  })

  it('does not open the picker from a disabled folder context action', async () => {
    mocks.session = null
    render(<FilesPage />)

    await userEvent.click(screen.getByRole('button', { name: 'Open file context menu' }))
    const options = mocks.showEmptyAreaMenu.mock.calls[0][0]
    options.onAddHhcLine()

    expect(screen.queryByText('LINE media picker open')).not.toBeInTheDocument()
  })

  it('opens the picker from the authorized root FAB', async () => {
    mocks.getAccessToken.mockResolvedValue('token')
    render(<FilesPage />)

    await userEvent.click(await screen.findByRole('button', { name: 'Sync LINE group' }))
    expect(screen.getByText('LINE media picker open')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'LINE' })).toBeInTheDocument()
  })
})

describe('FilesPage folder paste', () => {
  beforeEach(() => {
    mocks.session = null
    mocks.fileState.currentFolderId = 'file-root'
    mocks.fileState.folders = {
      A: { id: 'A', parentId: 'file-root', name: 'A', sortIndex: 0, createdAt: 1, expiresAt: 1000 },
      B: { id: 'B', parentId: 'A', name: 'B', sortIndex: 0, createdAt: 1, expiresAt: 2000 }
    }
    mocks.createExplorerFolder.mockClear()
    mocks.copyExplorerFolder.mockClear()
    mocks.showEmptyAreaMenu.mockClear()
  })

  it.each(['A', 'B'])('rejects pasting A into %s before creating a folder', async (target) => {
    const view = render(<FilesPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy folder A' }))
    mocks.fileState.currentFolderId = target
    view.rerender(<FilesPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Open file context menu' }))
    const options = mocks.showEmptyAreaMenu.mock.calls.at(-1)![0]
    await act(async () => {
      await options.onPaste()
    })
    expect(mocks.createExplorerFolder).not.toHaveBeenCalled()
    expect(mocks.copyExplorerFolder).not.toHaveBeenCalled()
  })

  it('routes a legal local paste through the guarded copy command', async () => {
    render(<FilesPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy folder A' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open file context menu' }))
    const options = mocks.showEmptyAreaMenu.mock.calls.at(-1)![0]
    await act(async () => {
      await options.onPaste()
    })
    expect(mocks.createExplorerFolder).not.toHaveBeenCalled()
    expect(mocks.copyExplorerFolder).toHaveBeenCalledWith('A', 'file-root', { name: 'A' })
  })
  it('keeps the clipboard and selection available after a failed copy', async () => {
    mocks.copyExplorerFolder.mockRejectedValueOnce(new Error('Disk unavailable'))
    render(<FilesPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy folder A' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open file context menu' }))
    await act(async () => {
      await mocks.showEmptyAreaMenu.mock.calls.at(-1)![0].onPaste()
    })
    expect(screen.getByTestId('selected-count')).toHaveTextContent('1')
    await userEvent.click(screen.getByRole('button', { name: 'Open file context menu' }))
    await act(async () => {
      await mocks.showEmptyAreaMenu.mock.calls.at(-1)![0].onPaste()
    })
    expect(mocks.copyExplorerFolder).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('selected-count')).toHaveTextContent('0')
  })
})
