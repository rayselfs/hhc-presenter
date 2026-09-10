import { useState } from 'react'
import { Button } from '@heroui/react'
import { toast } from '@heroui/react/toast'
import { useTranslation } from 'react-i18next'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import {
  copyExplorerFolder,
  FILE_EXPLORER_ROOT_ID,
  refreshPersonalCatalog,
  useFileExplorerStore
} from '@renderer/stores/file-explorer'
import { useConfirm } from '@renderer/contexts/ConfirmDialogContext'
import { usePresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import {
  acceptPersonalCloudVersion,
  getPersonalConflictScope
} from '@renderer/lib/personal-sync-conflicts'
import {
  acquirePersonalSyncLease,
  releasePersonalSyncLease,
  renewPersonalSyncLease
} from '@renderer/lib/personal-sync-db'
import { requestPersonalSync } from '@renderer/lib/personal-sync-runtime'
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
  const quotaExceeded = usePersonalSyncStore((state) => state.quotaExceeded)
  const confirm = useConfirm()
  const sessions = usePresentationSessionRegistry()
  const [busy, setBusy] = useState(false)
  const resolve = async (backup: boolean): Promise<void> => {
    setBusy(true)
    const workerId = crypto.randomUUID()
    const controller = new AbortController()
    let renewal: ReturnType<typeof setInterval> | undefined
    const unsubscribe = usePersonalSyncStore.subscribe((state) => {
      if (state.activeOwnerId !== ownerId) controller.abort()
    })
    try {
      let scope = await getPersonalConflictScope(ownerId)
      if (!scope) {
        requestPersonalSync(ownerId)
        return
      }
      for (const node of scope.nodes) await sessions.finalizeAndFlush(node.id)
      scope = await getPersonalConflictScope(ownerId)
      if (!scope) return
      if (
        !(await confirm({
          title: t(`personalCloud.${backup ? 'backup' : 'keepCloud'}`),
          description: t(`personalCloud.${backup ? 'backupConfirm' : 'discardConfirm'}`, {
            count: scope.nodes.length
          }),
          confirmLabel: t(`personalCloud.${backup ? 'backup' : 'keepCloud'}`)
        }))
      )
        return
      controller.signal.throwIfAborted()
      if (!(await acquirePersonalSyncLease(ownerId, workerId)))
        throw new Error(t('personalCloud.busy'))
      renewal = setInterval(() => {
        void renewPersonalSyncLease(ownerId, workerId)
          .then((owned) => {
            if (!owned) controller.abort()
          })
          .catch(() => controller.abort())
      }, 10_000)
      if (backup) {
        for (const id of scope.rootIds) {
          controller.signal.throwIfAborted()
          const catalog = useFileExplorerStore.getState()
          if (catalog.folders[id])
            await copyExplorerFolder(id, FILE_EXPLORER_ROOT_ID, { includeDeleted: true })
          else if (!(await catalog.copyItem(id, FILE_EXPLORER_ROOT_ID)))
            throw new Error(t('personalCloud.backupFailed'))
        }
      }
      if (
        scope.nodes.some(
          (node) =>
            sessions.hasPendingEditorWork?.(node.id) ||
            (sessions.get(node.id) && sessions.get(node.id)?.getSnapshot().save.status !== 'saved')
        )
      )
        throw new Error(t('personalCloud.changed'))
      await acceptPersonalCloudVersion(ownerId, workerId, scope, controller.signal)
      for (const node of scope.nodes) await sessions.close(node.id, 'discard')
      await refreshPersonalCatalog(ownerId)
      controller.signal.throwIfAborted()
      usePersonalSyncStore.setState({ syncStatus: 'pending', errorCode: null })
      requestPersonalSync(ownerId)
    } catch (error) {
      if (!controller.signal.aborted)
        toast.danger(error instanceof Error ? error.message : t('personalCloud.failed'))
    } finally {
      unsubscribe()
      if (renewal) clearInterval(renewal)
      await releasePersonalSyncLease(ownerId, workerId).catch(() => undefined)
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
          : t(`personalCloud.${displayedStatus}`)}
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
      ) : null}
    </div>
  )
}
