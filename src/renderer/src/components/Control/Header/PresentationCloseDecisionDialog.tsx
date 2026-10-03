import { useState } from 'react'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import PresentationSaveDialog from '@renderer/components/Control/Presentation/PresentationSaveDialog'
import { AlertDialog } from '@heroui/react/alert-dialog'
import { Button } from '@heroui/react/button'
import { useTranslation } from 'react-i18next'
import { usePendingPresentationCloseDecision } from '@renderer/contexts/PresentationCloseDecisionContext'

export default function PresentationCloseDecisionDialog(): React.JSX.Element {
  const { t } = useTranslation()
  const pending = usePendingPresentationCloseDecision()
  const documents = usePresentationWorkspaceStore((state) => state.documents)
  const [saving, setSaving] = useState(false)
  const unsaved =
    pending?.itemIds.filter((id) =>
      documents.some((entry) => entry.itemId === id && entry.isUnsaved)
    ) ?? []
  if (saving && pending && unsaved[0])
    return (
      <PresentationSaveDialog
        key={unsaved[0]}
        itemId={unsaved[0]}
        onCancel={() => {
          setSaving(false)
          pending.resolve('keep-editing')
        }}
        onSaved={() => {
          const remaining = usePresentationWorkspaceStore
            .getState()
            .documents.some((entry) => pending.itemIds.includes(entry.itemId) && entry.isUnsaved)
          if (!remaining) {
            setSaving(false)
            pending.resolve('retry')
          }
        }}
      />
    )

  return (
    <AlertDialog.Backdrop isOpen={pending !== null} isDismissable={false}>
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Icon status="warning" />
            <AlertDialog.Heading>
              {unsaved.length
                ? t('presentationWorkspace.unsavedTitle', 'Save this presentation?')
                : t('presentationWorkspace.closeDecisionTitle', 'Presentation could not be saved')}
            </AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p>
              {unsaved.length
                ? t(
                    'presentationWorkspace.unsavedBody',
                    'This copy has no saved location. Save it, discard it, or keep editing.'
                  )
                : t(
                    'presentationWorkspace.closeDecisionBody',
                    'Retry saving, keep editing, or close without saving your latest changes.'
                  )}
            </p>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="tertiary" onPress={() => pending?.resolve('keep-editing')}>
              {t('presentationWorkspace.keepEditing', 'Keep editing')}
            </Button>
            <Button
              variant="primary"
              onPress={() => {
                if (unsaved.length) setSaving(true)
                else pending?.resolve('retry')
              }}
            >
              {unsaved.length
                ? t('common.save', 'Save')
                : t('presentationWorkspace.retrySave', 'Retry save')}
            </Button>
            <Button variant="danger" onPress={() => pending?.resolve('discard')}>
              {t('presentationWorkspace.closeWithoutSaving', 'Close without saving')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  )
}
