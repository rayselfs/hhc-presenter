import { APP_CONFIG } from './app-config'

// Allow the API to start from zero before returning a list or streaming content.
export const BIBLE_VERSIONS_TIMEOUT_MS = 60_000
export const BIBLE_CONTENT_TIMEOUT_MS = 120_000

export const BIBLE_API = {
  base: `${APP_CONFIG.bibleApi.host}${APP_CONFIG.bibleApi.v1Prefix}`,
  versions: `${APP_CONFIG.bibleApi.host}${APP_CONFIG.bibleApi.v2Prefix}/versions`,
  content: (versionId: number) =>
    `${APP_CONFIG.bibleApi.host}${APP_CONFIG.bibleApi.v1Prefix}/content/${versionId}`
} as const
