import { formatPptxCompatibilityError } from './pptx-compatibility-message'
import { toast } from '@heroui/react/toast'
import type { ContextMenuEntry } from '@renderer/contexts/ContextMenuContext'
import { convertPptxToEditablePresentation } from '@renderer/lib/editable-presentation'
import {
  getPresentationWorkspacePath,
  isEditablePresentationMimeType,
  isPresentationItem
} from '@renderer/lib/presentation-media'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import { isFileItem, type AnyItemRecord } from '@shared/types/folder'

type PresentationItemActionOptions = {
  readonly item: AnyItemRecord
  readonly openLabel: string
  readonly convertLabel: string
  readonly openIcon: React.ReactNode
  readonly navigate: (path: string) => void
}

export function buildPresentationItemActions({
  item,
  openLabel,
  convertLabel,
  openIcon,
  navigate
}: PresentationItemActionOptions): ContextMenuEntry[] {
  if (!isFileItem(item) || !isPresentationItem(item)) return []

  return [
    'separator',
    {
      id: 'open-presentation',
      label: openLabel,
      icon: openIcon,
      onAction: () => {
        usePresentationWorkspaceStore.getState().openDocument(item)
        navigate(getPresentationWorkspacePath(item.id))
      }
    },
    ...(!isEditablePresentationMimeType(item.mimeType)
      ? [
          {
            id: 'convert-presentation',
            label: convertLabel,
            icon: openIcon,
            onAction: () => {
              void convertPptxToEditablePresentation(item)
                .then((createdItem) => {
                  usePresentationWorkspaceStore.getState().openDocument(createdItem)
                  navigate(getPresentationWorkspacePath(createdItem.id))
                })
                .catch((error) => {
                  toast.danger(formatPptxCompatibilityError(error))
                })
            }
          } satisfies Exclude<ContextMenuEntry, 'separator'>
        ]
      : [])
  ]
}
