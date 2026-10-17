import type { FileItemRecord } from '@shared/types/folder'
import { EDITABLE_PRESENTATION_MIME_TYPE } from '@renderer/lib/presentation-media'

export function makeEditableItem(id = 'deck-1', name = 'Sunday.lpdeck'): FileItemRecord {
  return {
    id,
    parentId: 'file-root',
    type: 'file',
    sortIndex: 0,
    createdAt: 1,
    expiresAt: null,
    name,
    url: `blob:${id}`,
    size: 1024,
    mimeType: EDITABLE_PRESENTATION_MIME_TYPE
  }
}
