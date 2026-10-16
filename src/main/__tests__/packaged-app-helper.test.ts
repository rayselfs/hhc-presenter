import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  firstWindow: vi.fn(),
  title: vi.fn(),
  onboarding: vi.fn(),
  close: vi.fn(),
  kill: vi.fn()
}))
vi.mock('@playwright/test', () => ({
  _electron: { launch: mocks.launch },
  expect: () => ({ toHaveTitle: mocks.title })
}))
vi.mock('../../../e2e/helpers', () => ({ completeOnboarding: mocks.onboarding }))

import { launchPackaged } from '../../../e2e/helpers/packaged-app'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.firstWindow.mockResolvedValue({})
  mocks.title.mockResolvedValue(undefined)
  mocks.onboarding.mockResolvedValue(undefined)
  mocks.close.mockResolvedValue(undefined)
  mocks.launch.mockResolvedValue({
    firstWindow: mocks.firstWindow,
    close: mocks.close,
    process: () => ({ stdout: null, stderr: null, kill: mocks.kill })
  })
})
afterEach(() => vi.useRealTimers())

describe('packaged app initialization cleanup', () => {
  it('closes a launched process when the first window fails', async () => {
    mocks.firstWindow.mockRejectedValue(new Error('No control window'))
    await expect(launchPackaged('/test/app', '/test/profile')).rejects.toThrow('No control window')
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledWith({
      executablePath: '/test/app',
      args: ['--user-data-dir=/test/profile'],
      timeout: 15_000
    })
  })

  it('preserves an onboarding failure after closing the process', async () => {
    mocks.onboarding.mockRejectedValue(new Error('Onboarding failed'))
    await expect(launchPackaged('/test/app', '/test/profile')).rejects.toThrow('Onboarding failed')
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.kill).not.toHaveBeenCalled()
  })

  it('kills an unresponsive process on the shutdown deadline', async () => {
    vi.useFakeTimers()
    mocks.title.mockRejectedValue(new Error('Wrong app title'))
    mocks.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          mocks.kill.mockImplementation(() => {
            resolve()
            return true
          })
        })
    )
    const failure = expect(launchPackaged('/test/app', '/test/profile')).rejects.toThrow(
      'Wrong app title'
    )
    await vi.advanceTimersByTimeAsync(10_000)
    await failure
    expect(mocks.kill).toHaveBeenCalledWith('SIGKILL')
    expect(vi.getTimerCount()).toBe(0)
  })
})
