import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@renderer/i18n'
import FileExplorerFAB from '../FileExplorerFAB'

const dropdown = vi.hoisted(() => ({
  onAction: null as ((key: string) => void) | null
}))

vi.mock('@heroui/react/dropdown', () => ({
  Dropdown: {
    Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Trigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Menu: ({
      children,
      onAction
    }: {
      children: React.ReactNode
      onAction: (key: string) => void
    }) => {
      dropdown.onAction = onAction
      return <div>{children}</div>
    },
    Section: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Item: ({ id, children }: { id: string; children: React.ReactNode }) => (
      <button onClick={() => dropdown.onAction?.(id)}>{children}</button>
    )
  }
}))

vi.mock('@renderer/stores/file-explorer', () => ({
  createExplorerFolder: vi.fn(async () => 'folder'),
  useFileExplorerStore: (selector: (state: unknown) => unknown) =>
    selector({
      currentFolderId: 'file-root',
      folders: {},
      getChildFolders: () => [],
      addFolder: vi.fn()
    })
}))

vi.mock('@renderer/components/Control/Folder/FolderModal', () => ({
  FolderModal: () => null
}))

describe('FileExplorerFAB HHC LINE action', () => {
  it('exposes the authorized HHC LINE collection picker callback', async () => {
    const onAddHhcLine = vi.fn()
    render(<FileExplorerFAB onAddHhcLine={onAddHhcLine} />)

    expect(screen.getByRole('img', { name: 'LINE', hidden: true })).toHaveClass('size-4')
    await userEvent.click(screen.getByRole('button', { name: 'LINE group folders' }))

    expect(onAddHhcLine).toHaveBeenCalledTimes(1)
  })

  it('keeps the plain LINE media folder label while unavailable', async () => {
    const onAddHhcLine = vi.fn()
    render(<FileExplorerFAB onAddHhcLine={onAddHhcLine} isAddHhcLineDisabled />)

    const action = screen.getByRole('button', { name: 'LINE group folders' })
    await userEvent.click(action)

    expect(onAddHhcLine).not.toHaveBeenCalled()
  })
})
