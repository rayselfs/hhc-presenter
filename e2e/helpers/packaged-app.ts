import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { completeOnboarding } from '../helpers'

export async function launchPackaged(
  executablePath: string,
  userDataPath: string,
  onLog: (chunk: string) => void = () => {}
): Promise<{ app: ElectronApplication; control: Page }> {
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataPath}`],
    timeout: 15_000
  })
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on('data', (chunk) => {
      onLog(String(chunk))
    })
  }
  try {
    const control = await app.firstWindow()
    await expect(control).toHaveTitle(/HHC Presenter|HHC 投影系統|HHC 投影系统/)
    await completeOnboarding(control)
    return { app, control }
  } catch (error) {
    await closePackaged(app).catch(() => undefined)
    throw error
  }
}

export async function closePackaged(app: ElectronApplication): Promise<void> {
  const deadline = setTimeout(() => app.process().kill('SIGKILL'), 10_000)
  try {
    await app.close()
  } finally {
    clearTimeout(deadline)
  }
}
