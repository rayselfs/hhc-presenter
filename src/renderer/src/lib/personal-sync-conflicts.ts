import { openFileExplorerDB } from './file-explorer-db'
import { getBlobId } from './blob-identity'
import { resolveUniqueFileName, splitFileName } from './file-naming'
import {
  assertPersonalSyncLease,
  type PersonalOutboxRecord,
  type PersonalSyncNode
} from './personal-sync-db'
import { EDITABLE_PRESENTATION_MIME_TYPE } from './presentation-media'

export interface PersonalConflictScope {
  operationId: string
  nodes: PersonalSyncNode[]
  rootIds: string[]
}

function conflictScope(
  pending: PersonalOutboxRecord[],
  nodes: PersonalSyncNode[],
  catalog: { id: string; parentId: string | null }[]
): PersonalConflictScope | null {
  const first = pending.sort((a, b) => a.sequence - b.sequence)[0]
  if (first?.failure !== 'conflict') return null
  const ids = new Set([first.nodeId])
  let changed = true
  while (changed) {
    const count = ids.size
    for (const item of catalog) if (item.parentId && ids.has(item.parentId)) ids.add(item.id)
    for (const operation of pending) {
      if (ids.has(operation.nodeId) || operation.subtree?.some((entry) => ids.has(entry.nodeId))) {
        ids.add(operation.nodeId)
        for (const entry of operation.subtree ?? []) ids.add(entry.nodeId)
      }
    }
    changed = count !== ids.size
  }
  return {
    operationId: first.id,
    nodes: nodes.filter((node) => ids.has(node.id)),
    rootIds: [...ids].filter(
      (id) => !catalog.some((item) => item.id === id && item.parentId && ids.has(item.parentId))
    )
  }
}

export async function getPersonalConflictScope(
  ownerId: string
): Promise<PersonalConflictScope | null> {
  const db = await openFileExplorerDB()
  const tx = db.transaction([
    'personal-sync-outbox',
    'personal-sync-nodes',
    'folder-records',
    'folder-items'
  ])
  const pending = await tx.objectStore('personal-sync-outbox').index('by-owner').getAll(ownerId)
  const nodes = await tx.objectStore('personal-sync-nodes').index('by-owner').getAll(ownerId)
  const folders = await tx.objectStore('folder-records').getAll()
  const items = await tx.objectStore('folder-items').getAll()
  const scope = conflictScope(
    pending,
    nodes,
    [...folders, ...items].filter((item) => item.personalOwnerId === ownerId)
  )
  await tx.done
  return scope
}

// Called only after the operator chooses the cloud version (and any requested backup finishes).
export async function acceptPersonalCloudVersion(
  ownerId: string,
  workerId: string,
  expected: PersonalConflictScope,
  signal: AbortSignal
): Promise<void> {
  const db = await openFileExplorerDB()
  const tx = db.transaction(
    [
      'personal-sync-state',
      'personal-sync-outbox',
      'personal-sync-nodes',
      'folder-records',
      'folder-items',
      'file-blobs'
    ],
    'readwrite'
  )
  const abort = (): void => {
    try {
      tx.abort()
    } catch {
      /* Already completed. */
    }
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const state = await tx.objectStore('personal-sync-state').get(ownerId)
    if (!state) throw new Error('Personal owner is missing')
    assertPersonalSyncLease(state, workerId)
    const outbox = tx.objectStore('personal-sync-outbox')
    const nodes = tx.objectStore('personal-sync-nodes')
    const pending = await outbox.index('by-owner').getAll(ownerId)
    const catalog = [
      ...(await tx.objectStore('folder-records').getAll()),
      ...(await tx.objectStore('folder-items').getAll())
    ].filter((item) => item.personalOwnerId === ownerId)
    const current = conflictScope(pending, await nodes.index('by-owner').getAll(ownerId), catalog)
    if (
      !current ||
      current.operationId !== expected.operationId ||
      current.nodes.length !== expected.nodes.length ||
      current.nodes.some(
        (node) =>
          !expected.nodes.some(
            (previous) =>
              previous.id === node.id &&
              previous.localRevision === node.localRevision &&
              previous.remoteRevision === node.remoteRevision
          )
      )
    )
      throw new Error('Personal conflict changed; review the current version again')
    const ids = new Set(current.nodes.map((node) => node.id))
    const removedIds = new Set(pending.filter((op) => ids.has(op.nodeId)).map((op) => op.id))
    if (pending.some((op) => !ids.has(op.nodeId) && op.dependsOn && removedIds.has(op.dependsOn)))
      throw new Error('Personal conflict has an unresolved dependent operation')
    const blobs = tx.objectStore('file-blobs')
    const releaseBlob = async (id: string): Promise<void> => {
      const blob = await blobs.get(id)
      if (blob) await blobs.put({ ...blob, refCount: Math.max(0, (blob.refCount ?? 1) - 1) })
    }
    for (const operation of pending) {
      if (!ids.has(operation.nodeId)) continue
      if (operation.snapshotBlobId) await releaseBlob(operation.snapshotBlobId)
      await outbox.delete(operation.id)
    }
    for (const node of current.nodes) {
      const item = await tx.objectStore('folder-items').get(node.id)
      if (item?.type === 'file') await releaseBlob(getBlobId(item))
      await tx.objectStore('folder-items').delete(node.id)
      await tx.objectStore('folder-records').delete(node.id)
      await nodes.put({
        id: node.id,
        ownerId,
        remoteId: node.remoteId,
        kind: node.kind,
        localRevision: 0,
        syncedLocalRevision: 0,
        remoteRevision: 0
      })
    }
    await tx
      .objectStore('personal-sync-state')
      .put({ ...state, cursor: undefined, pullRevision: undefined })
    assertPersonalSyncLease(state, workerId)
    signal.throwIfAborted()
    await tx.done
  } catch (error) {
    abort()
    await tx.done.catch(() => undefined)
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

// Keep the local item ID so an open editor continues saving into the preserved copy.
export async function preservePersonalContentConflict(
  ownerId: string,
  workerId: string,
  signal: AbortSignal
): Promise<boolean> {
  const db = await openFileExplorerDB()
  const tx = db.transaction(
    [
      'personal-sync-state',
      'personal-sync-nodes',
      'personal-sync-outbox',
      'folder-items',
      'folder-records',
      'file-blobs'
    ],
    'readwrite'
  )
  const abort = (): void => {
    try {
      tx.abort()
    } catch {
      /* Already completed. */
    }
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const states = tx.objectStore('personal-sync-state')
    const state = await states.get(ownerId)
    if (!state) throw new Error('Personal owner is missing')
    assertPersonalSyncLease(state, workerId)
    const outbox = tx.objectStore('personal-sync-outbox')
    const pending = (await outbox.index('by-owner').getAll(ownerId)).sort(
      (a, b) => a.sequence - b.sequence
    )
    const first = pending[0]
    if (
      !first ||
      first.failure !== 'conflict' ||
      !['create-file', 'replace-content'].includes(first.mutation.type)
    )
      return false
    const nodes = tx.objectStore('personal-sync-nodes')
    const node = await nodes.get(first.nodeId)
    const items = tx.objectStore('folder-items')
    const item = await items.get(first.nodeId)
    if (
      !node ||
      node.ownerId !== ownerId ||
      item?.type !== 'file' ||
      item.personalOwnerId !== ownerId ||
      item.deletedAt
    )
      return false
    if (pending.some((op) => op.subtree?.some((member) => member.nodeId === item.id))) return false
    const replaced = pending.filter((op) => op.nodeId === item.id)
    const removedIds = new Set(replaced.map((op) => op.id))
    if (pending.some((op) => op.nodeId !== item.id && op.dependsOn && removedIds.has(op.dependsOn)))
      return false
    const parent = item.parentId === state.rootId ? undefined : await nodes.get(item.parentId)
    const parentFolder = await tx.objectStore('folder-records').get(item.parentId)
    if (
      item.parentId !== state.rootId &&
      (!parent ||
        parent.ownerId !== ownerId ||
        !parent.remoteRevision ||
        parent.remoteHead?.deletedAt ||
        !parentFolder ||
        parentFolder.deletedAt)
    )
      return false
    const blobs = tx.objectStore('file-blobs')
    const blobId = getBlobId(item)
    if (!(await blobs.get(blobId))) return false
    const { base, extension } = splitFileName(item.name)
    const suffix = ` (conflict ${first.id.slice(0, 8)})`
    const shortExtension = Array.from(extension).slice(0, 24).join('')
    const candidate = `${Array.from(base).slice(0, 200).join('')}${suffix}${shortExtension}`
    const siblings = [
      ...(await items.index('by-parent').getAll(item.parentId)),
      ...(await tx.objectStore('folder-records').index('by-parent').getAll(item.parentId))
    ]
    const name = resolveUniqueFileName(
      candidate,
      siblings
        .filter((entry) => !entry.deletedAt && 'name' in entry)
        .map((entry) => ('name' in entry ? entry.name : ''))
    )
    const operationId = crypto.randomUUID()
    const remoteId = crypto.randomUUID()
    for (const operation of replaced) {
      await outbox.delete(operation.id)
      if (operation.snapshotBlobId) {
        const snapshot = await blobs.get(operation.snapshotBlobId)
        if (snapshot)
          await blobs.put({ ...snapshot, refCount: Math.max(0, (snapshot.refCount ?? 1) - 1) })
      }
    }
    const snapshot = await blobs.get(blobId)
    if (!snapshot) throw new Error('Personal conflict snapshot disappeared')
    await blobs.put({ ...snapshot, refCount: (snapshot.refCount ?? 1) + 1 })
    if (node.remoteRevision > 0 || node.remoteHead) {
      await nodes.add({
        id: crypto.randomUUID(),
        ownerId,
        remoteId: node.remoteId,
        kind: 'file',
        localRevision: 0,
        syncedLocalRevision: 0,
        remoteRevision: 0
      })
    }
    const localRevision = node.localRevision + 1
    await nodes.put({
      id: node.id,
      ownerId,
      remoteId,
      kind: 'file',
      localRevision,
      syncedLocalRevision: 0,
      remoteRevision: 0,
      lastOperationId: operationId
    })
    await items.put({ ...item, name })
    await outbox.add({
      id: operationId,
      ownerId,
      nodeId: item.id,
      remoteId,
      sequence: first.sequence,
      localRevision,
      mutation: { type: 'create-file', name, parentId: parent?.remoteId ?? '' },
      expectedRevision: 0,
      expectedCollectionRevision: state.collectionRevision,
      snapshotBlobId: blobId,
      fileName:
        item.mimeType === EDITABLE_PRESENTATION_MIME_TYPE && !name.endsWith('.lpdeck')
          ? `${name}.lpdeck`
          : name,
      mimeType: item.mimeType,
      sizeBytes: item.size,
      createdAt: Date.now()
    })
    await states.put({ ...state, cursor: undefined, pullRevision: undefined })
    assertPersonalSyncLease(state, workerId)
    signal.throwIfAborted()
    await tx.done
    return true
  } catch (error) {
    abort()
    await tx.done.catch(() => undefined)
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
