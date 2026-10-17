import type { PresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import {
  copyExplorerFolder,
  FILE_EXPLORER_ROOT_ID,
  refreshPersonalCatalog,
  useFileExplorerStore
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
    'finalizeAndFlush' | 'hasPendingEditorWork' | 'get' | 'close'
  >
  confirm: (count: number) => Promise<boolean>
  errors: { busy: string; backupFailed: string; changed: string }
}): Promise<void> {
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
    if (!(await confirm(scope.nodes.length))) return
    controller.signal.throwIfAborted()
    if (!(await acquirePersonalSyncLease(ownerId, workerId))) throw new Error(errors.busy)
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
          throw new Error(errors.backupFailed)
      }
    }
    if (
      scope.nodes.some(
        (node) =>
          sessions.hasPendingEditorWork?.(node.id) ||
          (sessions.get(node.id) && sessions.get(node.id)?.getSnapshot().save.status !== 'saved')
      )
    )
      throw new Error(errors.changed)
    await acceptPersonalCloudVersion(ownerId, workerId, scope, controller.signal)
    for (const node of scope.nodes) await sessions.close(node.id, 'discard')
    await refreshPersonalCatalog(ownerId)
    controller.signal.throwIfAborted()
    usePersonalSyncStore.setState({ syncStatus: 'pending', errorCode: null })
    requestPersonalSync(ownerId)
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    unsubscribe()
    if (renewal) clearInterval(renewal)
    await releasePersonalSyncLease(ownerId, workerId).catch(() => undefined)
  }
}
