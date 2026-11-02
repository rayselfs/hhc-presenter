import { act, fireEvent, render, screen } from '@testing-library/react'
import { ChineseSpeechPilot } from './ChineseSpeechPilot'
import { useBibleStore } from '@renderer/stores/bible'
import { useBibleSettingsStore } from '@renderer/stores/bible-settings'
import { useBibleSearchStore } from '@renderer/stores/bible-search'

it.each(['version', 'passage', 'search', 'unmount'])(
  'cancels preparation on %s without opening a microphone later',
  async (change) => {
    let ready!: () => void
    const prepare = vi.fn(
      (_session: string) =>
        new Promise<void>((resolve) => {
          ready = resolve
        })
    )
    const stop = vi.fn(async () => {})
    const microphone = vi.fn()
    vi.stubGlobal('api', { speech: { chinesePrepare: prepare, chineseStop: stop } })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: microphone }
    })
    useBibleSettingsStore.setState({ selectedVersionId: 101 })
    useBibleSearchStore.setState({ query: '' })
    const view = render(<ChineseSpeechPilot />)
    fireEvent.click(screen.getByRole('button', { name: '開始中文聆聽' }))
    expect(prepare).toHaveBeenCalledOnce()
    act(() => {
      if (change === 'version') useBibleSettingsStore.setState({ selectedVersionId: 102 })
      if (change === 'passage')
        useBibleStore.getState().navigateTo({ bookNumber: 1, chapter: 1, verse: 1 })
      if (change === 'search') useBibleSearchStore.setState({ query: '約翰' })
      if (change === 'unmount') view.unmount()
    })
    expect(stop).toHaveBeenCalledWith(prepare.mock.calls[0][0])
    await act(async () => {
      ready()
      await Promise.resolve()
    })
    expect(microphone).not.toHaveBeenCalled()
    view.unmount()
    vi.unstubAllGlobals()
  }
)
