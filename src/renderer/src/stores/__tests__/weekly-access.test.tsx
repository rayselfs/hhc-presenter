import { act, renderHook, waitFor } from '@testing-library/react'
import type { WeeklyEdition } from '@shared/weekly-reader'
import { fetchWeeklyEditions } from '@renderer/lib/weekly-reader'
import { invalidateWeeklyAccess, useRefreshWeeklyAccess, useWeeklyAccess } from '../weekly-access'

const auth = vi.hoisted(() => ({
  status: 'authenticated',
  session: { userId: 'reader', permissionAvailability: { status: 'available' } },
  getAuthGeneration: () => 1
}))

vi.mock('@renderer/contexts/HhcAuthContext', () => ({ useHhcAuth: () => auth }))
vi.mock('@renderer/lib/weekly-reader', () => ({ fetchWeeklyEditions: vi.fn() }))

const edition: WeeklyEdition = { series: 'general', locale: 'zh-Hant' }

function useAccessHarness(): ReturnType<typeof useWeeklyAccess> {
  useRefreshWeeklyAccess()
  return useWeeklyAccess()
}

describe('bulletin navigation access', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    auth.status = 'authenticated'
    auth.session.userId = 'reader'
    auth.session.permissionAvailability.status = 'available'
  })

  it('skips Operations lookup for guests and accounts with unavailable permissions', () => {
    auth.status = 'anonymous'
    const hook = renderHook(useAccessHarness)
    expect(hook.result.current.editions).toEqual([])
    auth.status = 'authenticated'
    auth.session.permissionAvailability.status = 'unavailable'
    hook.rerender()
    expect(fetchWeeklyEditions).not.toHaveBeenCalled()
  })

  it('removes the previous account access while checking a new account', async () => {
    vi.mocked(fetchWeeklyEditions).mockResolvedValueOnce([edition]).mockResolvedValueOnce([])
    const hook = renderHook(useAccessHarness)
    await waitFor(() => expect(hook.result.current.editions).toEqual([edition]))
    auth.session.userId = 'other'
    hook.rerender()
    expect(hook.result.current.editions).toEqual([])
    await waitFor(() => expect(hook.result.current.owner).toBe('other'))
    expect(hook.result.current.editions).toEqual([])
  })

  it('discards a pending permission response after a reader request loses access', async () => {
    let resolve!: (editions: WeeklyEdition[]) => void
    vi.mocked(fetchWeeklyEditions).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const hook = renderHook(useAccessHarness)
    await waitFor(() => expect(fetchWeeklyEditions).toHaveBeenCalled())
    act(invalidateWeeklyAccess)
    await act(async () => resolve([edition]))
    expect(hook.result.current.editions).toEqual([])
  })
})
