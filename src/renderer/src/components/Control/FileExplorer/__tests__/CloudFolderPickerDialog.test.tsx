import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import CloudFolderPickerDialog, { type CloudFolderPickerProvider } from '../CloudFolderPickerDialog'
vi.mock('react-i18next', () => {
  const t = (key: string): string => key
  return { useTranslation: () => ({ t }) }
})
vi.mock('@renderer/contexts/ShortcutScopeContext', () => ({
  ShortcutScope: ({ children }: { children: ReactNode }) => children
}))
it('keeps available choices importable and retries an incomplete listing', async () => {
  const legacy = { remoteItemId: 'legacy', name: 'Legacy', parentRemoteItemId: null }
  const source = { remoteItemId: 'source', name: 'Source', parentRemoteItemId: null }
  const listFolders = vi
    .fn<CloudFolderPickerProvider['listFolders']>()
    .mockResolvedValueOnce({ folders: [legacy], incomplete: true })
    .mockResolvedValueOnce([legacy, source])
  const provider: CloudFolderPickerProvider = {
    providerType: 'hhc-line',
    displayName: 'LINE',
    icon: null,
    supportsFolderNavigation: false,
    listFolders,
    importFolder: vi.fn()
  }
  const onImport = vi.fn()
  const user = userEvent.setup()
  render(
    <CloudFolderPickerDialog provider={provider} isOpen onClose={vi.fn()} onImport={onImport} />
  )
  await screen.findByRole('button', { name: 'Legacy' })
  expect(screen.getByRole('status')).toHaveTextContent('fileExplorer.cloudFolderPicker.incomplete')
  await user.click(screen.getByRole('button', { name: 'Legacy' }))
  await user.click(screen.getByRole('button', { name: 'fileExplorer.cloudFolderPicker.import' }))
  expect(onImport).toHaveBeenCalledWith(legacy)
  await user.click(screen.getByRole('button', { name: 'fileExplorer.cloudFolderPicker.retry' }))
  await screen.findByRole('button', { name: 'Source' })
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  expect(
    screen.getByRole('button', { name: 'fileExplorer.cloudFolderPicker.import' })
  ).toBeDisabled()
  expect(listFolders.mock.calls).toEqual([['root'], ['root']])
})

it('explains empty LINE access and discovers a newly authorized folder on retry', async () => {
  const folder = { remoteItemId: 'source', name: 'Shared folder', parentRemoteItemId: null }
  const listFolders = vi
    .fn<CloudFolderPickerProvider['listFolders']>()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([folder])
  const provider: CloudFolderPickerProvider = {
    providerType: 'hhc-line',
    displayName: 'LINE',
    icon: null,
    supportsFolderNavigation: false,
    listFolders,
    importFolder: vi.fn()
  }
  const onImport = vi.fn()
  render(
    <CloudFolderPickerDialog provider={provider} isOpen onClose={vi.fn()} onImport={onImport} />
  )
  expect(await screen.findByRole('status')).toHaveTextContent(
    'fileExplorer.cloudFolderPicker.hhcLineEmpty'
  )
  expect(
    screen.getByRole('button', { name: 'fileExplorer.cloudFolderPicker.import' })
  ).toBeDisabled()
  await userEvent.click(
    screen.getByRole('button', { name: 'fileExplorer.cloudFolderPicker.retry' })
  )
  await userEvent.click(await screen.findByRole('button', { name: 'Shared folder' }))
  await userEvent.click(
    screen.getByRole('button', { name: 'fileExplorer.cloudFolderPicker.import' })
  )
  expect(onImport).toHaveBeenCalledWith(folder)
})

it('allows retry after discovery fails without importing an unavailable selection', async () => {
  const provider: CloudFolderPickerProvider = {
    providerType: 'hhc-line',
    displayName: 'LINE',
    icon: null,
    listFolders: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]),
    importFolder: vi.fn()
  }
  render(
    <CloudFolderPickerDialog provider={provider} isOpen onClose={vi.fn()} onImport={vi.fn()} />
  )
  await screen.findByText('fileExplorer.cloudFolderPicker.loadFailed')
  expect(
    screen.getByRole('button', { name: 'fileExplorer.cloudFolderPicker.import' })
  ).toBeDisabled()
  await userEvent.click(
    screen.getByRole('button', { name: 'fileExplorer.cloudFolderPicker.retry' })
  )
  expect(await screen.findByRole('status')).toHaveTextContent(
    'fileExplorer.cloudFolderPicker.hhcLineEmpty'
  )
})
