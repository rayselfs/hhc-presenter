import { parseBibleStream } from '@shared/bible-stream'
import { ipcMain } from 'electron'
import type { WindowManager } from '../windowManager'
import { isMainWindow } from './validate'
import type { BibleVersion, BibleBook } from '@shared/types/bible'
import { BIBLE_API, BIBLE_CONTENT_TIMEOUT_MS, BIBLE_VERSIONS_TIMEOUT_MS } from '@shared/api-paths'
import { http } from '../lib/http'

async function fetchVersions(): Promise<BibleVersion[]> {
  const { data } = await http.get<BibleVersion[]>(BIBLE_API.versions, {
    timeout: BIBLE_VERSIONS_TIMEOUT_MS
  })
  return data
}

async function fetchContent(versionId: number): Promise<BibleBook[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BIBLE_CONTENT_TIMEOUT_MS)
  try {
    const response = await fetch(BIBLE_API.content(versionId), {
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (!response.body) throw new Error('Response body is null')

    return await parseBibleStream(response.body)
  } finally {
    clearTimeout(timeout)
  }
}

export function registerBibleApiHandlers(wm: WindowManager): void {
  ipcMain.handle('bible:get-versions', async (event) => {
    if (!isMainWindow(wm, event)) return []
    return fetchVersions()
  })

  ipcMain.handle('bible:get-content', async (event, versionId: number) => {
    if (!isMainWindow(wm, event)) return []
    return fetchContent(versionId)
  })
}
