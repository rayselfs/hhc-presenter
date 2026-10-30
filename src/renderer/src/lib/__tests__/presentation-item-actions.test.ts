import { beforeEach, expect, it, vi } from 'vitest'
import { toast } from '@heroui/react/toast'
import i18n from '@renderer/i18n'
import { convertPptxToEditablePresentation } from '../editable-presentation'
import { PptxCompatibilityError } from '../pptx-compatibility'
import { buildPresentationItemActions } from '../presentation-item-actions'
import { PPTX_MIME_TYPE } from '../presentation-media'

vi.mock('../editable-presentation', () => ({ convertPptxToEditablePresentation: vi.fn() }))
vi.mock('@heroui/react/toast', () => ({ toast: { danger: vi.fn() } }))
beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
})

it('shows the same located reason from the file context menu and keeps navigation unchanged', async () => {
  vi.mocked(convertPptxToEditablePresentation).mockRejectedValue(
    new PptxCompatibilityError(
      { code: 'animation', slideNumber: 2, sourcePart: 'private/source.xml' },
      'Private XML'
    )
  )
  const navigate = vi.fn()
  const action = buildPresentationItemActions({
    item: {
      id: 'source',
      type: 'file',
      name: 'Sunday.pptx',
      url: 'blob:source',
      parentId: 'file-root',
      mimeType: PPTX_MIME_TYPE,
      size: 1,
      sortIndex: 0,
      createdAt: 1,
      expiresAt: null
    },
    openLabel: 'Open',
    convertLabel: 'Edit a copy',
    openIcon: null,
    navigate
  }).find((entry) => typeof entry !== 'string' && entry.id === 'convert-presentation')
  if (!action || typeof action === 'string') throw new Error('Missing editable-copy action')
  action.onAction?.()
  await vi.waitFor(() => expect(toast.danger).toHaveBeenCalled())
  const message = vi.mocked(toast.danger).mock.calls[0][0]
  expect(message).toContain('Slide 2')
  expect(message).toContain('animation')
  expect(message).not.toContain('Private')
  expect(navigate).not.toHaveBeenCalled()
})
