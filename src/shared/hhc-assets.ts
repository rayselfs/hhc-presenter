export interface HhcAssetCollection {
  sourcePolicyVersion?: 1
  aclRevision?: number
  bindingGeneration?: number
  id: string
  namespace: string
  name: string
  revision: number
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export interface HhcAssetCollectionPage {
  collections: HhcAssetCollection[]
  cursor?: string
  hasMore: boolean
}

export interface HhcAssetCollectionItem {
  sourceExpiresAt?: string
  id: string
  collectionId: string
  remoteItemId: string
  displayName: string
  sourceRevision: string
  createdRevision: number
  updatedRevision?: number
  deletedRevision?: number
  mimeType?: string
  sizeBytes?: number
  etag?: string
  createdAt: string
  updatedAt?: string
  deletedAt?: string
}

export interface HhcAssetCollectionTombstone {
  id: string
  remoteItemId: string
  deletedRevision: number
  deletedAt: string
}

export interface HhcAssetCollectionChangePage {
  collection: HhcAssetCollection
  items: HhcAssetCollectionItem[]
  tombstones: HhcAssetCollectionTombstone[]
  cursor: string
  hasMore: boolean
  reset: boolean
}

export interface HhcAssetContentTicket {
  contentUrl: string
  expiresAt: number
  etag: string
}

export interface HhcAssetContentRequest {
  collectionId: string
  itemId: string
  rootRemoteFolderId: string
  range?: string
  targetFileId?: string
}

export interface HhcAssetCollectionRequest {
  collectionId: string
  cursor?: string
}

export interface HhcAssetItemRequest {
  collectionId: string
  itemId: string
}

export interface HhcAssetNativeDownloadRequest extends HhcAssetItemRequest {
  rootRemoteFolderId: string
  targetFileId: string
}

export interface HhcAssetNativeDownloadResult {
  fileId: string
  size: number
  mimeType: string
}

export interface HhcAssetNativeLease {
  sourceExpiresAt?: number
  kind: 'native-lease'
  url: string
  leaseId: string
  etag: string
}

export interface HhcAssetSyncReceipt {
  collectionItemId: string
  contentVersion: string
  state: 'available-offline'
  appVersion: string
}

const MAX_PAGE_ITEMS = 500

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid HHC Asset response')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Invalid HHC Asset response')
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('Invalid HHC Asset response')
  return value
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Invalid HHC Asset response')
  }
  return value as number
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value)
}

function pageArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_PAGE_ITEMS) {
    throw new Error('Invalid HHC Asset response')
  }
  return value
}

export function projectHhcAssetCollection(value: unknown): HhcAssetCollection {
  const input = record(value)
  const deletedAt = optionalString(input.deletedAt)
  const sourcePolicyVersion = input.sourcePolicyVersion
  if (sourcePolicyVersion !== undefined && sourcePolicyVersion !== 1)
    throw new Error('Unsupported HHC source policy')
  return {
    ...(sourcePolicyVersion === 1
      ? {
          sourcePolicyVersion,
          aclRevision: positiveInteger(input.aclRevision),
          bindingGeneration: positiveInteger(input.bindingGeneration)
        }
      : {}),
    id: requiredString(input.id),
    namespace: requiredString(input.namespace),
    name: requiredString(input.name),
    revision: nonNegativeInteger(input.revision),
    createdAt: requiredString(input.createdAt),
    updatedAt: requiredString(input.updatedAt),
    ...(deletedAt === undefined ? {} : { deletedAt })
  }
}

export function projectHhcAssetItem(value: unknown): HhcAssetCollectionItem {
  const input = record(value)
  const deletedRevision = optionalNonNegativeInteger(input.deletedRevision)
  const updatedRevision = optionalNonNegativeInteger(input.updatedRevision)
  const mimeType = optionalString(input.mimeType)
  const sizeBytes = optionalNonNegativeInteger(input.sizeBytes)
  const etag = optionalString(input.etag)
  const deletedAt = optionalString(input.deletedAt)
  const updatedAt = optionalString(input.updatedAt)
  const sourceExpiresAt =
    input.sourceExpiresAt === '0001-01-01T00:00:00Z'
      ? undefined
      : optionalString(input.sourceExpiresAt)
  if (
    sourceExpiresAt !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(sourceExpiresAt) ||
      !Number.isFinite(Date.parse(sourceExpiresAt)) ||
      Date.parse(sourceExpiresAt) <= 0)
  )
    throw new Error('Invalid HHC source deadline')
  return {
    ...(sourceExpiresAt === undefined ? {} : { sourceExpiresAt }),
    id: requiredString(input.id),
    collectionId: requiredString(input.collectionId),
    remoteItemId: requiredString(input.remoteItemId),
    displayName: requiredString(input.displayName),
    sourceRevision: requiredString(input.sourceRevision),
    createdRevision: nonNegativeInteger(input.createdRevision),
    createdAt: requiredString(input.createdAt),
    ...(updatedRevision === undefined ? {} : { updatedRevision }),
    ...(deletedRevision === undefined ? {} : { deletedRevision }),
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(etag === undefined ? {} : { etag }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(deletedAt === undefined ? {} : { deletedAt })
  }
}

function projectHhcAssetTombstone(value: unknown): HhcAssetCollectionTombstone {
  const input = record(value)
  return {
    id: requiredString(input.id),
    remoteItemId: requiredString(input.remoteItemId),
    deletedRevision: nonNegativeInteger(input.deletedRevision),
    deletedAt: requiredString(input.deletedAt)
  }
}

export function projectHhcAssetCollectionPage(value: unknown): HhcAssetCollectionPage {
  const input = record(value)
  if (typeof input.hasMore !== 'boolean') throw new Error('Invalid HHC Asset response')
  const cursor = optionalString(input.cursor)
  return {
    collections: pageArray(input.collections).map(projectHhcAssetCollection),
    ...(cursor === undefined ? {} : { cursor }),
    hasMore: input.hasMore
  }
}

export function projectHhcAssetChangePage(value: unknown): HhcAssetCollectionChangePage {
  const input = record(value)
  if (typeof input.hasMore !== 'boolean' || typeof input.reset !== 'boolean') {
    throw new Error('Invalid HHC Asset response')
  }
  const items = pageArray(input.items)
  const tombstones = pageArray(input.tombstones)
  if (items.length + tombstones.length > MAX_PAGE_ITEMS) {
    throw new Error('Invalid HHC Asset response')
  }
  const collection = projectHhcAssetCollection(input.collection)
  const projected = items.map(projectHhcAssetItem)
  if (
    collection.sourcePolicyVersion === 1 &&
    projected.some((item) => !item.sourceExpiresAt || item.collectionId !== collection.id)
  )
    throw new Error('Invalid HHC source page')
  return {
    collection,
    items: projected,
    tombstones: tombstones.map(projectHhcAssetTombstone),
    cursor: requiredString(input.cursor),
    hasMore: input.hasMore,
    reset: input.reset
  }
}

function positiveInteger(value: unknown): number {
  const n = nonNegativeInteger(value)
  if (n === 0) throw new Error('Invalid HHC source revision')
  return n
}
export interface HhcSourceControl {
  version: 1
  collectionId: string
  state: 'active' | 'paused' | 'revoked' | 'expired'
  policyRevision: number
  aclRevision: number
  bindingGeneration: number
}
export function projectHhcSourceControl(value: unknown): HhcSourceControl {
  const r = record(value)
  if (r.version !== 1 || !['active', 'paused', 'revoked', 'expired'].includes(String(r.state)))
    throw new Error('Invalid HHC source control')
  return {
    version: 1,
    collectionId: requiredString(r.collectionId),
    state: r.state as HhcSourceControl['state'],
    policyRevision: positiveInteger(r.policyRevision),
    aclRevision: positiveInteger(r.aclRevision),
    bindingGeneration: positiveInteger(r.bindingGeneration)
  }
}
export type HhcSourceOutcome =
  | 'item-expired'
  | 'item-revoked'
  | 'collection-paused'
  | 'item-paused'
  | 'collection-revoked'
  | 'dependency-unavailable'
  | 'upgrade-required'
export type HhcAssetFailure = {
  classification: 'retryable' | 'auth-required' | 'access-revoked' | 'fatal'
  status: number
  outcome?: HhcSourceOutcome
}
export function classifyHhcAssetFailure(status: number, value?: unknown): HhcAssetFailure {
  let failure: Record<string, unknown> | undefined
  try {
    failure = record(record(value).error)
  } catch {
    /* Legacy errors have no source envelope. */
  }
  if (typeof failure?.code === 'string' && failure.code.startsWith('AST_SOURCE_')) {
    const key = `${status}:${failure.code}:${failure.scope}`
    const outcomes: Record<string, HhcSourceOutcome> = {
      '410:AST_SOURCE_EXPIRED:item': 'item-expired',
      '410:AST_SOURCE_REVOKED:item': 'item-revoked',
      '410:AST_SOURCE_REVOKED:collection': 'collection-revoked',
      '410:AST_SOURCE_EXPIRED:collection': 'collection-revoked',
      '423:AST_SOURCE_PAUSED:collection': 'collection-paused',
      '423:AST_SOURCE_PAUSED:item': 'item-paused',
      '403:AST_SOURCE_ACL_REVOKED:collection': 'collection-revoked',
      '503:AST_SOURCE_UNAVAILABLE:dependency': 'dependency-unavailable',
      '426:AST_SOURCE_CLIENT_UPGRADE:collection': 'upgrade-required'
    }
    const outcome = failure.version === 1 ? outcomes[key] : undefined
    return {
      status,
      classification:
        outcome && ['item-expired', 'item-revoked', 'collection-revoked'].includes(outcome)
          ? 'access-revoked'
          : 'retryable',
      outcome: outcome ?? 'dependency-unavailable'
    }
  }
  return {
    status,
    classification:
      status === 401
        ? 'auth-required'
        : status === 403 || status === 404
          ? 'access-revoked'
          : [408, 409, 423, 426, 429].includes(status) || status >= 500
            ? 'retryable'
            : 'fatal'
  }
}
export async function readHhcAssetFailure(response: Response): Promise<HhcAssetFailure> {
  let value: unknown
  const reader = response.body?.getReader()
  if (reader) {
    try {
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const r = await reader.read()
        if (r.done) break
        size += r.value.byteLength
        if (size > 4096)
          return {
            status: response.status,
            classification: 'retryable',
            outcome: 'dependency-unavailable'
          }
        chunks.push(r.value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      value = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      /* Status still classifies unstructured legacy errors. */
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }
  return classifyHhcAssetFailure(response.status, value)
}

export function watchHhcSourceDeadline(deadline: number, expire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const check = (): void => {
    if (cancelled) return
    const remaining = deadline - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0) {
      expire()
      return
    }
    timer = setTimeout(check, Math.min(remaining, 2_147_483_647))
  }
  check()
  return () => {
    cancelled = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function readHhcSourceDeadline(headers: Headers): number | undefined {
  const value = headers.get('X-HHC-Source-Expires-At')
  if (value === null) return undefined
  const deadline = Date.parse(value)
  if (!Number.isFinite(deadline) || deadline <= 0)
    throw new Error('HHC_ASSET_FATAL:INVALID_SOURCE_DEADLINE')
  if (deadline <= Date.now()) throw new Error('HHC_SOURCE_FAILURE:410:item-expired')
  return deadline
}
