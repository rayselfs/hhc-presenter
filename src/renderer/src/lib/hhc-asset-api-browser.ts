import { createHhcBrowserLease } from './hhc-content-lease'
import { APP_CONFIG } from '@shared/app-config'
import {
  projectHhcSourceControl,
  readHhcAssetFailure,
  projectHhcAssetChangePage,
  projectHhcAssetCollectionPage,
  projectHhcAssetItem,
  type HhcAssetCollectionChangePage,
  type HhcAssetCollectionItem,
  type HhcAssetCollectionPage
} from '@shared/hhc-assets'
import { HhcAssetApiError, type HhcAssetApi } from './hhc-asset-api'

const RANGE_PATTERN = /^bytes=(?:\d+-\d*|-\d+)$/

type BrowserHhcAssetApiOptions = {
  origin?: string
  getAccessToken: () => Promise<string | null>
  refreshAfterUnauthorized: (rejectedToken: string) => Promise<string | null>
  fetcher?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function parseHhcAssetItem(value: unknown): HhcAssetCollectionItem {
  try {
    return projectHhcAssetItem(value)
  } catch {
    throw new HhcAssetApiError('fatal')
  }
}

export function parseHhcAssetCollectionPage(value: unknown): HhcAssetCollectionPage {
  try {
    return projectHhcAssetCollectionPage(value)
  } catch {
    throw new HhcAssetApiError('fatal')
  }
}

export function parseHhcAssetChangePage(value: unknown): HhcAssetCollectionChangePage {
  try {
    return projectHhcAssetChangePage(value)
  } catch {
    throw new HhcAssetApiError('fatal')
  }
}

export function createBrowserHhcAssetApi(options: BrowserHhcAssetApiOptions): HhcAssetApi {
  const requestedOrigin = options.origin ?? APP_CONFIG.hhcAssetOrigin
  let configuredOrigin: string
  try {
    configuredOrigin = new URL(requestedOrigin).origin
  } catch {
    throw new Error('Invalid HHC Asset origin')
  }
  if (configuredOrigin !== requestedOrigin || configuredOrigin !== APP_CONFIG.hhcAssetOrigin) {
    throw new Error('Invalid HHC Asset origin')
  }
  const fetcher = options.fetcher ?? ((...args) => window.fetch(...args))

  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const send = async (token: string): Promise<Response> => {
      const headers = new Headers(init.headers)
      headers.set('accept', headers.get('accept') ?? 'application/json')
      headers.set('authorization', `Bearer ${token}`)
      headers.set('X-HHC-Source-Policy-Version', '1')
      try {
        return await fetcher(`${configuredOrigin}${path}`, { ...init, headers })
      } catch {
        throw new HhcAssetApiError('retryable')
      }
    }
    const firstToken = await options.getAccessToken()
    if (!firstToken) throw new HhcAssetApiError('auth-required', 401)
    let response = await send(firstToken)
    if (response.status === 401) {
      const refreshed = await options.refreshAfterUnauthorized(firstToken)
      if (!refreshed) throw new HhcAssetApiError('auth-required', 401)
      response = await send(refreshed)
    }
    if (!response.ok) {
      const failure = await readHhcAssetFailure(response)
      throw new HhcAssetApiError(failure.classification, failure.status, failure.outcome)
    }
    return response
  }

  const json = async (path: string, init?: RequestInit): Promise<unknown> => {
    try {
      return await (await request(path, init)).json()
    } catch (error) {
      if (error instanceof HhcAssetApiError) throw error
      throw new HhcAssetApiError('fatal')
    }
  }

  return {
    async getCollectionControl(collectionId) {
      return projectHhcSourceControl(
        await json(`/api/assets/collections/${encodeURIComponent(collectionId)}/control`)
      )
    },
    async listCollections(cursor) {
      const params = new URLSearchParams({ limit: '100' })
      if (cursor) params.set('cursor', cursor)
      return parseHhcAssetCollectionPage(await json(`/api/assets/collections?${params}`))
    },
    async getCollectionChanges(collectionId, cursor) {
      const query = cursor ? `?${new URLSearchParams({ cursor })}` : ''
      return parseHhcAssetChangePage(
        await json(`/api/assets/collections/${encodeURIComponent(collectionId)}/changes${query}`)
      )
    },
    async getCollectionItem(collectionId, itemId) {
      return parseHhcAssetItem(
        await json(
          `/api/assets/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`
        )
      )
    },
    async issueContentTicket(collectionId, itemId) {
      const value = await json(
        `/api/assets/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}/content-ticket`,
        { method: 'POST' }
      )
      if (!isRecord(value)) throw new HhcAssetApiError('fatal')
      const contentUrl = string(value.contentUrl)
      const expiresAt = string(value.expiresAt)
      const etag = string(value.etag)
      const parsedExpiry = expiresAt ? Date.parse(expiresAt) : Number.NaN
      if (
        !contentUrl ||
        !contentUrl.startsWith('/api/assets/content?ticket=') ||
        !etag ||
        !Number.isFinite(parsedExpiry)
      ) {
        throw new HhcAssetApiError('fatal')
      }
      return { contentUrl: `${configuredOrigin}${contentUrl}`, expiresAt: parsedExpiry, etag }
    },
    async recordSyncReceipt(receipt) {
      await request('/api/assets/sync-receipts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(receipt)
      })
    },
    async getRemoteContentSource(collectionId, itemId) {
      const item = await this.getCollectionItem(collectionId, itemId)
      if (item.sourceExpiresAt) {
        const response = await request(
          `/api/assets/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}/content`,
          { headers: { accept: '*/*' } }
        )
        const deadline = Date.parse(item.sourceExpiresAt)
        if (
          Date.parse(response.headers.get('X-HHC-Source-Expires-At') ?? '') !== deadline ||
          response.headers.get('etag') !== item.etag
        ) {
          await response.body?.cancel().catch(() => undefined)
          throw new HhcAssetApiError('retryable', 503, 'dependency-unavailable')
        }
        return createHhcBrowserLease(response, deadline, item.etag!)
      }
      const ticket = await this.issueContentTicket(collectionId, itemId)
      return {
        kind: 'ticket',
        url: ticket.contentUrl,
        expiresAt: ticket.expiresAt,
        etag: ticket.etag
      }
    },
    async downloadContent(input, signal) {
      if (input.range && !RANGE_PATTERN.test(input.range)) throw new HhcAssetApiError('fatal')
      const headers = new Headers()
      headers.set('accept', '*/*')
      if (input.range) headers.set('range', input.range)
      return request(
        `/api/assets/collections/${encodeURIComponent(input.collectionId)}/items/${encodeURIComponent(input.itemId)}/content`,
        { headers, signal }
      )
    }
  }
}
