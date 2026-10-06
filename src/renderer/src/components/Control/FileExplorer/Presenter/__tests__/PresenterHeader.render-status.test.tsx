import { fireEvent, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import PresenterHeader from '../PresenterHeader'

const { state, retry } = vi.hoisted(() => {
  const retry = vi.fn()
  return {
    retry,
    state: {
      isEnded: false,
      projectionRenderStatus: {
        itemId: 'pdf',
        blobId: 'blob',
        contentRevision: 2,
        status: 'failed',
        reason: 'source-unavailable'
      },
      lastReadinessReport: null,
      playlist: [{ id: 'pdf', name: 'Sunday.pdf' }],
      skippedReadinessIds: [],
      retryCurrentProjection: retry
    }
  }
})
vi.mock('@renderer/stores/media-projection', () => ({
  useMediaProjectionStore: Object.assign(
    (selector: (input: typeof state) => unknown) => selector(state),
    { getState: () => state }
  )
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../ReadinessIssueDrawer', () => ({ default: () => null }))

it('identifies the failed projected file and retries projection rather than preview', () => {
  const { getByRole, queryByRole, unmount } = render(<PresenterHeader onExit={vi.fn()} />)
  expect(getByRole('status')).toHaveTextContent('Sunday.pdf')
  expect(getByRole('status')).toHaveTextContent(
    'fileExplorer.presenter.projectionFailure.source-unavailable'
  )
  fireEvent.click(getByRole('button', { name: 'fileExplorer.presenter.retryProjection' }))
  expect(retry).toHaveBeenCalledOnce()
  expect(queryByRole('button', { name: 'presenter.retryPreview' })).toBeNull()
  unmount()
})
