vi.unmock('@heroui/react/tabs')

import { act, render, screen } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@renderer/i18n'
import ModeSelector from '@renderer/components/Control/Timer/ModeSelector'
import { useTimerStore } from '@renderer/stores/timer'

// jsdom does not run CSS animations or provide the Web Animations API.
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
})
afterAll(() => {
  Reflect.deleteProperty(Element.prototype, 'getAnimations')
})

beforeEach(() => {
  useTimerStore.setState({ mode: 'timer' })
})

function renderWithI18n(): RenderResult {
  return render(
    <I18nextProvider i18n={i18n}>
      <ModeSelector />
    </I18nextProvider>
  )
}

describe('ModeSelector', () => {
  it('renders all 4 mode tabs', () => {
    renderWithI18n()
    expect(screen.getByTestId('mode-timer')).toBeInTheDocument()
    expect(screen.getByTestId('mode-clock')).toBeInTheDocument()
    expect(screen.getByTestId('mode-both')).toBeInTheDocument()
    expect(screen.getByTestId('mode-stopwatch')).toBeInTheDocument()
  })

  it('highlights the current mode tab', () => {
    renderWithI18n()
    expect(screen.getByTestId('mode-timer')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('mode-clock')).toHaveAttribute('aria-selected', 'false')
  })

  it('calls setMode when a mode tab is clicked', async () => {
    const user = userEvent.setup()
    renderWithI18n()
    await user.click(screen.getByTestId('mode-clock'))
    expect(useTimerStore.getState().mode).toBe('clock')
  })

  it('updates selected state after mode change', async () => {
    const user = userEvent.setup()
    renderWithI18n()
    await user.click(screen.getByTestId('mode-stopwatch'))
    expect(screen.getByTestId('mode-stopwatch')).toHaveAttribute('aria-selected', 'true')
  })
})

it('supports keyboard navigation with the real Tabs control', async () => {
  const user = userEvent.setup()
  renderWithI18n()
  act(() => screen.getByTestId('mode-timer').focus())
  await user.keyboard('{ArrowRight}')
  expect(screen.getByTestId('mode-both')).toHaveFocus()
  expect(useTimerStore.getState().mode).toBe('both')
})
