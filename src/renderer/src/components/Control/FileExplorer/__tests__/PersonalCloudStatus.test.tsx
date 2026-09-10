import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PersonalCloudStatus } from '../PersonalCloudStatus'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@renderer/contexts/ConfirmDialogContext', () => ({ useConfirm: () => vi.fn() }))
vi.mock('@renderer/contexts/PresentationSessionRegistryContext', () => ({
  usePresentationSessionRegistry: () => ({})
}))
afterEach(cleanup)

it('shows failures before a root exists without offering destructive conflict actions for network failure', () => {
  usePersonalSyncStore.setState({
    activeOwnerId: 'owner',
    accountStatus: 'authenticated',
    syncStatus: 'failed',
    itemStatuses: {}
  })
  render(<PersonalCloudStatus />)
  expect(screen.getByRole('status')).toHaveTextContent('personalCloud.failed')
  expect(screen.queryByRole('button', { name: 'personalCloud.retry' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'personalCloud.keepCloud' })).toBeNull()
})

it('keeps normal background synchronization invisible', () => {
  usePersonalSyncStore.setState({
    activeOwnerId: 'owner',
    accountStatus: 'authenticated',
    syncStatus: 'syncing',
    itemStatuses: {}
  })
  const { container } = render(<PersonalCloudStatus />)
  expect(container).toBeEmptyDOMElement()
})

it('does not offer conflict actions for quota-blocked items', () => {
  usePersonalSyncStore.setState({
    activeOwnerId: 'owner',
    accountStatus: 'authenticated',
    syncStatus: 'failed',
    itemStatuses: { item: 'failed' },
    quotaExceeded: { usedBytes: 90, quotaBytes: 100, requiredBytes: 20 }
  })
  render(<PersonalCloudStatus />)
  expect(screen.getByRole('status')).toHaveTextContent('personalCloud.quotaExceeded')
  expect(screen.queryByRole('button', { name: 'personalCloud.keepCloud' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'personalCloud.backup' })).toBeNull()
})
