import { parseBibleStream } from '@shared/bible-stream'
import { ipcMain } from 'electron'
import type { WindowManager } from '../windowManager'
import { isMainWindow } from './validate'
import type { BibleVersion, BibleBook } from '@shared/types/bible'
import { BIBLE_API } from '@shared/api-paths'
import { http } from '../lib/http'

async function fetchVersions(): Promise<BibleVersion[]> {
  const { data } = await http.get<BibleVersion[]>(BIBLE_API.versions)
  return data
}

async function fetchContent(versionId: number): Promise<BibleBook[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
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
