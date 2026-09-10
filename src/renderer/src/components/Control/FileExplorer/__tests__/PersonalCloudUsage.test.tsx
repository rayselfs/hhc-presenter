import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { PersonalCloudUsage } from '../PersonalCloudUsage'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key })
}))

afterEach(cleanup)

it('shows only binary usage text and opens the detail popover upward', async () => {
  usePersonalSyncStore.setState({
    activeOwnerId: 'owner',
    usage: {
      activeBytes: 20 * 1024 ** 3,
      trashBytes: 3 * 1024 ** 3,
      protectedBytes: Math.round(0.4 * 1024 ** 3),
      usedBytes: Math.round(23.4 * 1024 ** 3),
      quotaBytes: 100 * 1024 ** 3,
      overrideBytes: null
    }
  })
  render(<PersonalCloudUsage />)
  const trigger = screen.getByRole('button', { name: '23.4 / 100 GiB' })
  expect(trigger).toHaveTextContent('23.4 / 100 GiB')
  expect(trigger).not.toHaveTextContent('personalCloud.usage')
  await userEvent.click(trigger)
  expect(await screen.findByText('personalCloud.activeBytes')).toBeInTheDocument()
})
