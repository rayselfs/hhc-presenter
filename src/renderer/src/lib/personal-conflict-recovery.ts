import type { PresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import {
  createLocalRecoveryEntryBackup,
  refreshPersonalCatalog
} from '@renderer/stores/file-explorer'
import { acceptPersonalCloudVersion, getPersonalConflictScope } from './personal-sync-conflicts'
import {
  acquirePersonalSyncLease,
  releasePersonalSyncLease,
  renewPersonalSyncLease
} from './personal-sync-db'
import { requestPersonalSync } from './personal-sync-runtime'

export async function resolvePersonalCloudConflict({
  ownerId,
  backup,
  sessions,
  confirm,
  errors
}: {
  ownerId: string
  backup: boolean
  sessions: Pick<
    PresentationSessionRegistry,
    'finalizeAndFlush' | 'hasPendingEditorWork' | 'get' | 'close' | 'subscribe'
  >
  confirm: (count: number) => Promise<boolean>
  errors: { busy: string; backupFailed: string; changed: string }
}): Promise<void> {
  const workerId = crypto.randomUUID()
  const controller = new AbortController()
  let renewal: ReturnType<typeof setInterval> | undefined
  const assertAccount = (): void => {
    const account = usePersonalSyncStore.getState()
    if (account.activeOwnerId !== ownerId || account.accountStatus !== 'authenticated')
      controller.abort()
    controller.signal.throwIfAborted()
  }
  const unsubscribe = usePersonalSyncStore.subscribe((state) => {
    if (state.activeOwnerId !== ownerId || state.accountStatus !== 'authenticated')
      controller.abort()
  })
  let unsubscribeEditor: (() => void) | undefined
  try {
    assertAccount()
    let scope = await getPersonalConflictScope(ownerId)
    if (!scope) {
      requestPersonalSync(ownerId)
      return
    }
    for (const node of scope.nodes) await sessions.finalizeAndFlush(node.id)
    scope = await getPersonalConflictScope(ownerId)
    if (!scope) return
    if (!(await confirm(scope.nodes.length))) return
    assertAccount()
    if (!(await acquirePersonalSyncLease(ownerId, workerId))) throw new Error(errors.busy)
    renewal = setInterval(() => {
      void renewPersonalSyncLease(ownerId, workerId)
        .then((owned) => {
          if (!owned) controller.abort()
        })
        .catch(() => controller.abort())
    }, 10_000)
    const editorIsSaved = (): boolean =>
      scope.nodes.every((node) => {
        const session = sessions.get(node.id)
        return (
          !sessions.hasPendingEditorWork?.(node.id) &&
          (!session ||
            (session.getSnapshot().save.status === 'saved' &&
              session.getSnapshot().draftKind === null))
        )
      })
    if (!editorIsSaved()) throw new Error(errors.changed)
    unsubscribeEditor = sessions.subscribe(() => {
      if (!editorIsSaved()) controller.abort()
    })
    if (backup) {
      for (const id of scope.rootIds) {
        controller.signal.throwIfAborted()
        if (!(await createLocalRecoveryEntryBackup(ownerId, id, controller.signal)))
          throw new Error(errors.backupFailed)
      }
    }
    assertAccount()
    if (!editorIsSaved()) throw new Error(errors.changed)
    for (const node of scope.nodes) {
      if (!(await sessions.close(node.id))) throw new Error(errors.changed)
    }
    assertAccount()
    await acceptPersonalCloudVersion(ownerId, workerId, scope, controller.signal)
    await refreshPersonalCatalog(ownerId)
    assertAccount()
    usePersonalSyncStore.setState({ syncStatus: 'pending', errorCode: null })
    requestPersonalSync(ownerId)
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    unsubscribe()
    unsubscribeEditor?.()
    if (renewal) clearInterval(renewal)
    await releasePersonalSyncLease(ownerId, workerId).catch(() => undefined)
  }
}
