import { ipcMain, net } from 'electron'
import { APP_CONFIG } from '@shared/app-config'
import { createWeeklyClient, type WeeklyEdition, type WeeklyIssue } from '@shared/weekly-reader'
import type { WindowManager } from '../windowManager'
import type { HhcAuthService } from './hhc-auth'
import { isMainWindow } from './validate'

export function registerWeeklyReader(wm: WindowManager, service: HhcAuthService): void {
  const client = createWeeklyClient(APP_CONFIG.hhcAssetOrigin, service, (url, init) =>
    net.fetch(url, init)
  )
  async function authorized<T>(
    event: Electron.IpcMainInvokeEvent,
    accountId: string,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (!isMainWindow(wm, event) || event.senderFrame !== event.sender.mainFrame)
      throw new Error('Weekly bulletin HTTP 403')
    if (!accountId || (await service.getSession())?.userId !== accountId)
      throw new Error('Weekly bulletin HTTP 401')
    const result = await run(AbortSignal.timeout(20000))
    if ((await service.getSession())?.userId !== accountId)
      throw new Error('Weekly bulletin HTTP 401')
    return result
  }
  ipcMain.handle('weekly:editions', (event, id: string) =>
    authorized(event, id, (signal) => client.editions(signal))
  )
  ipcMain.handle('weekly:list', (event, id: string, edition: WeeklyEdition, offset: number) =>
    authorized(event, id, (signal) => client.list(edition, offset, signal))
  )
  ipcMain.handle('weekly:open', (event, id: string, issue: WeeklyIssue, clientRequestId: string) =>
    authorized(event, id, (signal) => client.open(issue, id, clientRequestId, signal))
  )
}
