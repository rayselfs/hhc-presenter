import type { HhcAuthAdapter } from '@shared/hhc-auth'
import type {
  HhcSourceControl,
  HhcSourceOutcome,
  HhcAssetCollectionChangePage,
  HhcAssetCollectionItem,
  HhcAssetCollectionPage,
  HhcAssetContentRequest,
  HhcAssetContentTicket,
  HhcAssetSyncReceipt
} from '@shared/hhc-assets'
import { isElectron } from './env'
import type { SyncRemoteContentSource } from './sync-provider'

export type HhcAssetErrorClassification = 'retryable' | 'auth-required' | 'access-revoked' | 'fatal'

export class HhcAssetApiError extends Error {
  constructor(
    readonly classification: HhcAssetErrorClassification,
    readonly status?: number,
    readonly outcome?: HhcSourceOutcome
  ) {
    super('HHC Asset request failed')
  }
}

export interface HhcAssetApi {
  getCollectionControl(collectionId: string): Promise<HhcSourceControl>
  listCollections(cursor?: string, sourcePolicyVersion?: 0 | 1): Promise<HhcAssetCollectionPage>
  getCollectionChanges(collectionId: string, cursor?: string): Promise<HhcAssetCollectionChangePage>
  getCollectionItem(collectionId: string, itemId: string): Promise<HhcAssetCollectionItem>
  issueContentTicket(collectionId: string, itemId: string): Promise<HhcAssetContentTicket>
  recordSyncReceipt(receipt: HhcAssetSyncReceipt): Promise<void>
  getRemoteContentSource(collectionId: string, itemId: string): Promise<SyncRemoteContentSource>
  downloadContent(
    request: HhcAssetContentRequest,
    signal?: AbortSignal
  ): Promise<Response | { fileId: string; size: number; mimeType: string }>
}

type HhcAssetAuth = Pick<HhcAuthAdapter, 'getAccessToken' | 'refreshAfterUnauthorized'>

export async function createHhcAssetApi(auth?: HhcAssetAuth): Promise<HhcAssetApi> {
  if (isElectron()) {
    const { createElectronHhcAssetApi } = await import('./hhc-asset-api-electron')
    return createElectronHhcAssetApi()
  }

  if (!auth) throw new Error('HHC account authentication is required')
  const { createBrowserHhcAssetApi } = await import('./hhc-asset-api-browser')
  return createBrowserHhcAssetApi({
    getAccessToken: () => auth.getAccessToken(),
    refreshAfterUnauthorized: (rejectedToken) => auth.refreshAfterUnauthorized(rejectedToken)
  })
}
