import { fireEvent, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { FileItemRecord } from '@shared/types/folder'
import ImagePreview from '../ImagePreview'

const { source, t } = vi.hoisted(() => ({ source: vi.fn(), t: (key: string) => key }))
vi.mock('@renderer/lib/file-explorer-db', () => ({
  openFileExplorerDB: vi.fn().mockResolvedValue({}),
  getFileSource: source
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@heroui/react/toast', () => ({ toast: { warning: vi.fn() } }))
vi.mock('@renderer/stores/media-projection', () => ({
  useMediaProjectionStore: (selector: (state: unknown) => unknown) =>
    selector({ zoomLevel: 1, pan: { x: 0, y: 0 }, snapshot: null })
}))

it('shows retry for decode failure and reloads the source', async () => {
  source.mockResolvedValue({ url: 'blob:image', revoke: vi.fn() })
  const item: FileItemRecord = {
    id: 'image',
    parentId: 'root',
    type: 'file',
    sortIndex: 0,
    createdAt: 0,
    expiresAt: null,
    name: 'photo.png',
    url: 'blob:image',
    size: 1,
    mimeType: 'image/png'
  }
  const { getByRole, queryByRole } = render(<ImagePreview item={item} />)
  await waitFor(() => expect(queryByRole('img')).not.toBeNull())
  fireEvent.error(getByRole('img'))
  expect(getByRole('alert')).toHaveTextContent('presenter.previewUnavailable')
  fireEvent.click(getByRole('button', { name: 'presenter.retryPreview' }))
  await waitFor(() => expect(source).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(queryByRole('img')).not.toBeNull())
})
