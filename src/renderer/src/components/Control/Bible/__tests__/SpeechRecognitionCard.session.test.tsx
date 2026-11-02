import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '@renderer/i18n'
import LocalSpeechCard from '../LocalSpeechCard'
import { useBibleSearchStore } from '@renderer/stores/bible-search'
import { useBibleSettingsStore } from '@renderer/stores/bible-settings'
vi.mock('@renderer/lib/env', () => ({ isElectron: () => true }))
afterEach(() => vi.unstubAllGlobals())
it('does not acquire a microphone before readiness and releases a late grant after stopping', async () => {
  let ready!: () => void
  const preparation = new Promise<void>((resolve) => {
    ready = resolve
  })
  const prepare = vi.fn().mockReturnValueOnce(preparation).mockResolvedValue(undefined)
  const stop = vi.fn(async () => {})
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      speech: {
        modelStatus: vi.fn(async () => ({
          language: 'zh',
          phase: 'installed',
          received: 1,
          total: 1,
          runtimeAvailable: true,
          error: null
        })),
        prepare,
        stop
      }
    }
  })
  let grant!: (value: MediaStream) => void
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((resolve) => {
        grant = resolve
      })
  )
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  })
  useBibleSettingsStore.setState({ selectedVersionId: 1 })
  useBibleSearchStore.setState({ isIndexReady: true })
  const view = render(<LocalSpeechCard />)
  await waitFor(() => expect(prepare).toHaveBeenCalledOnce())
  expect(getUserMedia).not.toHaveBeenCalled()
  await act(async () => {
    ready()
    await preparation
  })
  fireEvent.click(screen.getByRole('button', { name: /Start listening|開始聆聽/ }))
  await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: /^(Stop|停止)$/ }))
  const stopTrack = vi.fn()
  await act(async () => {
    grant({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream)
  })
  expect(stopTrack).toHaveBeenCalledOnce()
  expect(stop).toHaveBeenCalled()
  view.unmount()
})
