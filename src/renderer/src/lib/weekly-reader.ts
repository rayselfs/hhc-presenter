import { APP_CONFIG } from '@shared/app-config'
import type { HhcSession } from '@shared/hhc-auth'
import {
  createWeeklyClient,
  WeeklyHttpError,
  type WeeklyEdition,
  type WeeklyIssue,
  type WeeklyClient,
  type WeeklyList,
  type WeeklyDocument,
  type WeeklyTransport
} from '@shared/weekly-reader'
import { isElectron } from './env'

type Auth = WeeklyTransport & { session: HhcSession | null; getAuthGeneration(): number }
async function load<T>(
  auth: Auth,
  signal: AbortSignal | undefined,
  action: (userId: string, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const userId = auth.session?.userId
  if (!userId) throw new WeeklyHttpError(401)
  const generation = auth.getAuthGeneration()
  const deadline = AbortSignal.timeout(20000)
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline
  active.throwIfAborted()
  try {
    const result = await action(userId, active)
    active.throwIfAborted()
    if (generation !== auth.getAuthGeneration()) throw new WeeklyHttpError(401)
    return result
  } catch (error) {
    const status = error instanceof Error && /Weekly bulletin HTTP (\d{3})$/.exec(error.message)
    if (status) throw new WeeklyHttpError(Number(status[1]))
    throw error
  }
}
function browser(auth: Auth): WeeklyClient {
  return createWeeklyClient(APP_CONFIG.hhcAssetOrigin, auth, window.fetch.bind(window))
}
export function fetchWeeklyEditions(auth: Auth, signal?: AbortSignal): Promise<WeeklyEdition[]> {
  return load(auth, signal, (id, active) =>
    isElectron() ? window.api.weekly.editions(id) : browser(auth).editions(active)
  )
}
export function listWeeklyIssues(
  edition: WeeklyEdition,
  offset: number,
  auth: Auth,
  signal?: AbortSignal
): Promise<WeeklyList> {
  return load(auth, signal, (id, active) =>
    isElectron()
      ? window.api.weekly.list(id, edition, offset)
      : browser(auth).list(edition, offset, active)
  )
}
export function openWeeklyIssue(
  issue: WeeklyIssue,
  auth: Auth,
  clientRequestId: string,
  signal?: AbortSignal
): Promise<WeeklyDocument> {
  return load(auth, signal, (id, active) =>
    isElectron()
      ? window.api.weekly.open(id, issue, clientRequestId)
      : browser(auth).open(issue, id, clientRequestId, active)
  )
}
