import { useState } from 'react'
import { Button } from '@heroui/react'
import { toast } from '@heroui/react/toast'
import { useTranslation } from 'react-i18next'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { useConfirm } from '@renderer/contexts/ConfirmDialogContext'
import { usePresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import { resolvePersonalCloudConflict } from '@renderer/lib/personal-conflict-recovery'
import { listPersonalOutbox, isPermanentPersonalFileFailure } from '@renderer/lib/personal-sync-db'
import { recoverPersonalOperation, requestPersonalSync } from '@renderer/lib/personal-sync-runtime'
import { formatPersonalGiB } from '@shared/personal-cloud'

export function PersonalCloudStatus(): React.JSX.Element | null {
  const ownerId = usePersonalSyncStore((state) => state.activeOwnerId)
  return ownerId ? <PersonalCloudAccountStatus key={ownerId} ownerId={ownerId} /> : null
}

function PersonalCloudAccountStatus({ ownerId }: { ownerId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const status = usePersonalSyncStore((state) => state.syncStatus)
  const hasConflicts = usePersonalSyncStore((state) =>
    Object.values(state.itemStatuses).some((value) => value === 'conflict')
  )
  const accountStatus = usePersonalSyncStore((state) => state.accountStatus)
  const errorCode = usePersonalSyncStore((state) => state.errorCode)
  const permanentFileFailure = isPermanentPersonalFileFailure(errorCode ?? undefined)
  const quotaExceeded = usePersonalSyncStore((state) => state.quotaExceeded)
  const confirm = useConfirm()
  const sessions = usePresentationSessionRegistry()
  const [busy, setBusy] = useState(false)
  const resolve = async (backup: boolean): Promise<void> => {
    setBusy(true)
    try {
      await resolvePersonalCloudConflict({
        ownerId,
        backup,
        sessions,
        confirm: (count) =>
          confirm({
            title: t(`personalCloud.${backup ? 'backup' : 'keepCloud'}`),
            description: t(`personalCloud.${backup ? 'backupConfirm' : 'discardConfirm'}`, {
              count
            }),
            confirmLabel: t(`personalCloud.${backup ? 'backup' : 'keepCloud'}`)
          }),
        errors: {
          busy: t('personalCloud.busy'),
          backupFailed: t('personalCloud.backupFailed'),
          changed: t('personalCloud.changed')
        }
      })
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : t('personalCloud.failed'))
    } finally {
      setBusy(false)
    }
  }

  const recover = async (action: 'retry' | 'backup-cancel'): Promise<void> => {
    setBusy(true)
    try {
      const operation = (await listPersonalOutbox(ownerId))[0]
      if (
        action === 'backup-cancel' &&
        !(await confirm({
          title: t('personalCloud.backupCancel'),
          description: t('personalCloud.backupCancelConfirm'),
          confirmLabel: t('personalCloud.backupCancel')
        }))
      )
        return
      if (usePersonalSyncStore.getState().activeOwnerId !== ownerId) return
      if (!operation?.failure && action === 'retry') {
        requestPersonalSync(ownerId)
        return
      }
      if (!operation) throw new Error(t('personalCloud.changed'))
      await recoverPersonalOperation(ownerId, operation.id, action, sessions)
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : t('personalCloud.failed'))
    } finally {
      setBusy(false)
    }
  }
  const displayedStatus = accountStatus === 'unavailable' ? 'offline' : status
  if (
    accountStatus === 'unavailable' ||
    (status !== 'failed' && status !== 'conflict' && !hasConflicts)
  )
    return null
  return (
    <div className="mx-3 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
      <span role="status" className="mr-auto text-sm">
        {t('personalCloud.title')} ·{' '}
        {quotaExceeded
          ? t('personalCloud.quotaExceeded', {
              required: formatPersonalGiB(quotaExceeded.requiredBytes),
              used: formatPersonalGiB(quotaExceeded.usedBytes),
              quota: formatPersonalGiB(quotaExceeded.quotaBytes)
            })
          : permanentFileFailure
            ? t('personalCloud.invalidFile', { reason: errorCode })
            : `${t(`personalCloud.${displayedStatus}`)}${errorCode ? ` · ${errorCode}` : ''}`}
      </span>
      {status === 'conflict' || hasConflicts ? (
        <>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={busy}
            onPress={() => void resolve(true)}
          >
            {t('personalCloud.backup')}
          </Button>
          <Button
            size="sm"
            variant="tertiary"
            isDisabled={busy}
            onPress={() => void resolve(false)}
          >
            {t('personalCloud.keepCloud')}
          </Button>
        </>
      ) : status === 'failed' ? (
        <Button
          size="sm"
          variant="secondary"
          isDisabled={busy}
          onPress={() => void recover(permanentFileFailure ? 'backup-cancel' : 'retry')}
        >
          {t(`personalCloud.${permanentFileFailure ? 'backupCancel' : 'retry'}`)}
        </Button>
      ) : null}
    </div>
  )
}
