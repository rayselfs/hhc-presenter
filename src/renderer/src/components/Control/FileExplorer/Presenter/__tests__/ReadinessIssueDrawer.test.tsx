import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShortcutScopeProvider } from '@renderer/contexts/ShortcutScopeContext'
import ReadinessIssueDrawer from '../ReadinessIssueDrawer'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import type { PresentationReadinessReport } from '@renderer/lib/presentation-readiness'

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next')
  return {
    ...actual,
    useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key })
  }
})
const report: PresentationReadinessReport = {
  summary: { ready: 0, preparing: 1, unsupported: 1, missing: 0, failed: 0 },
  items: [
    {
      itemId: 'video-1',
      blobId: 'video-1',
      status: 'preparing',
      reason: 'metadata-building',
      support: 'native'
    },
    {
      itemId: 'legacy-1',
      blobId: 'legacy-1',
      status: 'unsupported',
      reason: 'unsupported-media',
      support: null
    }
  ]
}
describe('ReadinessIssueDrawer', () => {
  beforeEach(() =>
    useMediaProjectionStore.setState({
      playlist: [],
      skippedReadinessIds: [],
      repairingReadinessIds: []
    })
  )
  it('uses the session repair action and presents actionable status rather than internal codes', async () => {
    const retry = vi.fn(async () => true)
    const original = useMediaProjectionStore.getState().retryReadiness
    useMediaProjectionStore.setState({ retryReadiness: retry })
    try {
      const user = userEvent.setup()
      render(
        <ShortcutScopeProvider>
          <ReadinessIssueDrawer report={report} onClose={vi.fn()} />
        </ShortcutScopeProvider>
      )
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.queryByText(/metadata-building/)).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /^Retry$/i }))
      expect(retry).toHaveBeenCalledWith('video-1')
    } finally {
      useMediaProjectionStore.setState({ retryReadiness: original })
    }
  })
  it('keeps Skip after closing and reopening', async () => {
    const user = userEvent.setup()
    const first = render(
      <ShortcutScopeProvider>
        <ReadinessIssueDrawer report={report} onClose={vi.fn()} />
      </ShortcutScopeProvider>
    )
    await user.click(screen.getAllByRole('button', { name: /Skip/i })[0])
    first.unmount()
    render(
      <ShortcutScopeProvider>
        <ReadinessIssueDrawer report={report} onClose={vi.fn()} />
      </ShortcutScopeProvider>
    )
    expect(screen.queryByText('video-1')).not.toBeInTheDocument()
    expect(screen.getByText('legacy-1')).toBeInTheDocument()
  })
  it('closes using Escape without presenting another item', async () => {
    const close = vi.fn()
    const user = userEvent.setup()
    render(
      <ShortcutScopeProvider>
        <ReadinessIssueDrawer report={report} onClose={close} />
      </ShortcutScopeProvider>
    )
    screen.getByRole('button', { name: 'common.close' }).focus()
    await user.keyboard('{Escape}')
    expect(close).toHaveBeenCalled()
    expect(useMediaProjectionStore.getState().playlist).toEqual([])
  })
})
