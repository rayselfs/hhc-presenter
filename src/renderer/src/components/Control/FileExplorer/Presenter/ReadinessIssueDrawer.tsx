import { useMemo, useState } from 'react'
import { Button } from '@heroui/react/button'
import { AlertTriangle, ExternalLink, RotateCcw, SkipForward, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Modal } from '@heroui/react/modal'
import { ShortcutScope } from '@renderer/contexts/ShortcutScopeContext'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import type {
  PresentationReadinessItem,
  PresentationReadinessReport
} from '@renderer/lib/presentation-readiness'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { isFileItem } from '@shared/types/folder'

interface ReadinessIssueDrawerProps {
  report: PresentationReadinessReport
  onClose: () => void
}

export default function ReadinessIssueDrawer({
  report,
  onClose
}: ReadinessIssueDrawerProps): React.JSX.Element {
  const { t } = useTranslation()
  const items = useFileExplorerStore((state) => state.items)
  const acknowledgedIds = useMediaProjectionStore((state) => state.skippedReadinessIds)
  const playlist = useMediaProjectionStore((state) => state.playlist)
  const pendingIds = useMediaProjectionStore((state) => state.repairingReadinessIds)
  const [error, setError] = useState(false)
  const issues = useMemo(
    () =>
      report.items.filter(
        (item) =>
          !playlist.some((entry) => entry.id === item.itemId) &&
          !acknowledgedIds.includes(item.itemId)
      ),
    [acknowledgedIds, playlist, report.items]
  )

  const retryPreparation = async (item: PresentationReadinessItem): Promise<void> => {
    setError(false)
    try {
      const state = useMediaProjectionStore.getState()
      const ready =
        item.status === 'ready'
          ? await state.addRepairedItem(item.itemId)
          : await state.retryReadiness(item.itemId)
      if (!ready) setError(true)
    } catch {
      setError(true)
    }
  }

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Modal.Container size="md">
        <Modal.Dialog aria-label={t('fileExplorer.presenter.readinessIssues', 'Readiness issues')}>
          <ShortcutScope name="overlay">
            <div className="flex h-12 items-center border-b border-divider px-4">
              <AlertTriangle className="mr-2 size-4 text-warning" />
              <h2 className="font-semibold">
                {t('fileExplorer.presenter.readinessIssues', 'Readiness issues')}
              </h2>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                className="ml-auto"
                onPress={onClose}
                aria-label={t('common.close')}
              >
                <X size={16} />
              </Button>
            </div>
            <p className="border-b border-divider px-4 py-3 text-xs text-default-500">
              {t(
                'fileExplorer.presenter.readinessHelp',
                'These items remain in this session until you repair or explicitly skip them.'
              )}
            </p>
            {error && (
              <p role="alert" className="px-4 py-2 text-sm text-danger">
                {t(
                  'fileExplorer.presenter.repairNotReady',
                  'This item is not ready. Check its source or open Recovery Center, then retry.'
                )}
              </p>
            )}
            {issues.length === 0 ? (
              <div className="p-6 text-sm text-default-500">
                {t('fileExplorer.presenter.noReadinessIssues', 'No unresolved readiness issues')}
              </div>
            ) : (
              <ul className="min-h-0 flex-1 overflow-y-auto">
                {issues.map((issue) => {
                  const sourceItem = items[issue.itemId]
                  const name = sourceItem && isFileItem(sourceItem) ? sourceItem.name : issue.itemId
                  const repairable = issue.status !== 'unsupported'
                  return (
                    <li key={issue.itemId} className="border-b border-divider p-4">
                      <div className="truncate text-sm font-medium">{name}</div>
                      <div className="mt-1 text-xs text-default-500">
                        {t(`fileExplorer.presenter.readinessStatus.${issue.status}`, issue.status)}{' '}
                        ·{' '}
                        {t(
                          `fileExplorer.presenter.readinessReason.${issue.reason}`,
                          t(
                            'fileExplorer.presenter.readinessReasonFallback',
                            'Check the source and retry preparation.'
                          )
                        )}
                      </div>
                      <div className="mt-3 flex gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          isDisabled={pendingIds.includes(issue.itemId)}
                          onPress={() => {
                            if (repairable) {
                              void retryPreparation(issue)
                            } else {
                              window.dispatchEvent(new CustomEvent('hhc:open-recovery-center'))
                            }
                          }}
                        >
                          {repairable ? <RotateCcw size={14} /> : <ExternalLink size={14} />}
                          {issue.status === 'ready'
                            ? t('fileExplorer.presenter.addRepairedItem', 'Add to presentation')
                            : repairable
                              ? t('fileExplorer.presenter.retryPreparation', 'Retry')
                              : t('fileExplorer.presenter.openRecovery', 'Open Recovery Center')}
                        </Button>
                        <Button
                          size="sm"
                          variant="tertiary"
                          onPress={() =>
                            useMediaProjectionStore.getState().skipReadinessItem(issue.itemId)
                          }
                        >
                          <SkipForward size={14} />
                          {t('fileExplorer.presenter.skipItem', 'Skip')}
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </ShortcutScope>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
