import type { BibleBook, BibleVersion } from '@shared/types/bible'
import { BIBLE_API } from '@shared/api-paths'
import { isElectron } from './env'
import { http } from './http'

import { BibleApiError, parseBibleStream, sortBibleBooks } from '@shared/bible-stream'
export { BibleApiError, type BibleApiErrorType } from '@shared/bible-stream'

export interface BibleApiAdapter {
  fetchVersions(): Promise<BibleVersion[]>
  fetchContent(versionId: number): Promise<BibleBook[]>
}

export class ElectronBibleApiAdapter implements BibleApiAdapter {
  async fetchVersions(): Promise<BibleVersion[]> {
    return window.api.bible.getVersions()
  }

  async fetchContent(versionId: number): Promise<BibleBook[]> {
    const books = await window.api.bible.getContent(versionId)
    return sortBibleBooks(books)
  }
}

const BIBLE_BASE = import.meta.env.DEV ? '/api/bible/v1' : BIBLE_API.base
const BIBLE_VERSIONS_BASE = import.meta.env.DEV
  ? '/api/bible/v2'
  : BIBLE_API.versions.replace('/versions', '')
const VERSIONS_TIMEOUT_MS = 3_000
const CONTENT_TIMEOUT_MS = 30_000

export class BrowserBibleApiAdapter implements BibleApiAdapter {
  async fetchVersions(): Promise<BibleVersion[]> {
    return this.withRetry(() => this.doFetchVersions())
  }

  async fetchContent(versionId: number): Promise<BibleBook[]> {
    return this.withRetry(() => this.doFetchContent(versionId))
  }

  private async doFetchVersions(): Promise<BibleVersion[]> {
    try {
      const { data } = await http.get<BibleVersion[]>(`${BIBLE_VERSIONS_BASE}/versions`, {
        timeout: VERSIONS_TIMEOUT_MS
      })
      return data
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new BibleApiError('timeout', 'Request timed out')
      }
      if (error instanceof Error) {
        throw new BibleApiError('network', error.message)
      }
      throw new BibleApiError('network', String(error))
    }
  }

  private async doFetchContent(versionId: number): Promise<BibleBook[]> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), CONTENT_TIMEOUT_MS)

    try {
      const response = await fetch(`${BIBLE_BASE}/content/${versionId}`, {
        signal: controller.signal
      })
      if (!response.ok) {
        throw new BibleApiError('network', `HTTP ${response.status}: ${response.statusText}`)
      }
      if (!response.body) {
        throw new BibleApiError('network', 'Response body is empty')
      }
      return await parseBibleStream(response.body)
    } catch (error) {
      if (error instanceof BibleApiError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new BibleApiError('timeout', 'Request timed out after 30s')
      }
      throw new BibleApiError('network', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch {
      return await fn()
    }
  }
}

export function createBibleApiAdapter(): BibleApiAdapter {
  if (isElectron()) {
    return new ElectronBibleApiAdapter()
  }
  return new BrowserBibleApiAdapter()
}
