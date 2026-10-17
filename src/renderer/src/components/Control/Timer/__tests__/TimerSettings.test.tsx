import { render, screen } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@renderer/i18n'
import SettingsPopover from '@renderer/components/Control/Header/SettingsPopover/SettingsPopover'
import type { SettingsVariant } from '@renderer/components/Control/Header/SettingsPopover/SettingsPopover'
import { useTimerStore } from '@renderer/stores/timer'
import { useStopwatchStore } from '@renderer/stores/stopwatch'
import { DEFAULT_SETTINGS, DEFAULT_STATE } from '@renderer/stores/timer'

beforeEach(() => {
  useTimerStore.setState({
    ...DEFAULT_SETTINGS,
    ...DEFAULT_STATE,
    totalDuration: 300,
    reminderEnabled: false,
    reminderDuration: 60,
    overtimeMessageEnabled: false,
    overtimeMessage: "Time's Up!"
  })
})

function renderWithI18n(variant: SettingsVariant = 'timer'): RenderResult {
  return render(
    <I18nextProvider i18n={i18n}>
      <SettingsPopover variant={variant} />
    </I18nextProvider>
  )
}

describe('SettingsPopover — trigger button', () => {
  it('renders settings trigger button', () => {
    renderWithI18n()
    expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument()
  })
})

describe('SettingsPopover — timer mode', () => {
  it('renders settings region after opening popover', async () => {
    const user = userEvent.setup()
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.getByRole('region', { name: /settings/i })).toBeInTheDocument()
  })

  it('renders both timer switches in popover', async () => {
    const user = userEvent.setup()
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(3)
  })

  it('toggling reminder switch calls setReminder with new enabled state', async () => {
    const user = userEvent.setup()
    const setReminderSpy = vi.fn()
    useTimerStore.setState({ setReminder: setReminderSpy } as never)
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))

    const switches = screen.getAllByRole('switch')
    await user.click(switches[0])

    expect(setReminderSpy).toHaveBeenCalledWith(true, 60)
  })

  it('toggling reminder from enabled to disabled calls setReminder(false, duration)', async () => {
    const user = userEvent.setup()
    const setReminderSpy = vi.fn()
    useTimerStore.setState({
      reminderEnabled: true,
      reminderDuration: 30,
      setReminder: setReminderSpy
    } as never)
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))

    const switches = screen.getAllByRole('switch')
    await user.click(switches[0])

    expect(setReminderSpy).toHaveBeenCalledWith(false, 30)
  })
})

describe('SettingsPopover — reminder duration/color always visible', () => {
  it('shows reminder duration input when popover is open (reminder disabled)', async () => {
    const user = userEvent.setup()
    useTimerStore.setState({ reminderEnabled: false })
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.getByRole('textbox', { name: /reminder time/i })).toBeInTheDocument()
  })

  it('shows reminder duration input when popover is open (reminder enabled)', async () => {
    const user = userEvent.setup()
    useTimerStore.setState({ reminderEnabled: true })
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.getByRole('textbox', { name: /reminder time/i })).toBeInTheDocument()
  })

  it('disables reminder duration input when reminder switch is off', async () => {
    const user = userEvent.setup()
    useTimerStore.setState({ reminderEnabled: false, totalDuration: 300 })
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.getByRole('textbox', { name: /reminder time/i })).toBeDisabled()
  })

  it('enables reminder duration input when reminder switch is on and timer stopped', async () => {
    const user = userEvent.setup()
    useTimerStore.setState({ reminderEnabled: true, totalDuration: 300, status: 'stopped' })
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.getByRole('textbox', { name: /reminder time/i })).not.toBeDisabled()
  })

  it('disables reminder duration input when timer is running (even if reminder enabled)', async () => {
    const user = userEvent.setup()
    useTimerStore.setState({ reminderEnabled: true, totalDuration: 300, status: 'running' })
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.getByRole('textbox', { name: /reminder time/i })).toBeDisabled()
  })

  it('disables reminder color picker when reminder switch is off', async () => {
    const user = userEvent.setup()
    useTimerStore.setState({ reminderEnabled: false, totalDuration: 300 })
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.getByRole('button', { name: /reminder color/i })).toBeDisabled()
  })

  it('disables reminder color picker when timer is running', async () => {
    const user = userEvent.setup()
    useTimerStore.setState({ reminderEnabled: true, totalDuration: 300, status: 'running' })
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.getByRole('button', { name: /reminder color/i })).toBeDisabled()
  })
})

describe('SettingsPopover — reminder switch disabled states', () => {
  it('disables reminder switch when totalDuration <= 30', async () => {
    const user = userEvent.setup()
    useTimerStore.setState({ totalDuration: 30, remainingSeconds: 30 })
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    const switches = screen.getAllByRole('switch')
    expect(switches[0]).toBeDisabled()
  })

  it('disables reminder switch when timer is running', async () => {
    const user = userEvent.setup()
    useTimerStore.setState({ totalDuration: 300, status: 'running' })
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    const switches = screen.getAllByRole('switch')
    expect(switches[0]).toBeDisabled()
  })

  it('disables reminder switch when timer is paused', async () => {
    const user = userEvent.setup()
    useTimerStore.setState({ totalDuration: 300, status: 'paused' })
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    const switches = screen.getAllByRole('switch')
    expect(switches[0]).toBeDisabled()
  })

  it('enables reminder switch when timer is stopped and duration > 30', async () => {
    const user = userEvent.setup()
    useTimerStore.setState({ totalDuration: 300, status: 'stopped' })
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    const switches = screen.getAllByRole('switch')
    expect(switches[0]).not.toBeDisabled()
  })
})

describe('SettingsPopover — reminder duration input', () => {
  it('changing reminder duration calls setReminder with new seconds', async () => {
    const user = userEvent.setup()
    const setReminderSpy = vi.fn()
    useTimerStore.setState({
      reminderEnabled: true,
      reminderDuration: 0,
      setReminder: setReminderSpy
    } as never)
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))

    const durationInput = screen.getByRole('textbox', { name: /reminder time/i })
    await user.tripleClick(durationInput)
    await user.keyboard('120')
    await user.tab()

    expect(setReminderSpy).toHaveBeenLastCalledWith(true, 120)
  })

  it('smart default: uses totalDuration - 10 when totalDuration < 60', async () => {
    const user = userEvent.setup()
    const setReminderSpy = vi.fn()
    useTimerStore.setState({
      totalDuration: 45,
      remainingSeconds: 45,
      setReminder: setReminderSpy
    } as never)
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))

    const switches = screen.getAllByRole('switch')
    await user.click(switches[0])

    expect(setReminderSpy).toHaveBeenCalledWith(true, 35)
  })

  it('does not show inline validation error when reminderDuration >= totalDuration (toast-based)', async () => {
    const user = userEvent.setup()
    useTimerStore.setState({
      reminderEnabled: true,
      reminderDuration: 300,
      totalDuration: 300
    })
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('SettingsPopover — overtime message toggle', () => {
  it('toggling overtime switch calls setOvertimeMessage with new enabled state', async () => {
    const user = userEvent.setup()
    const setOvertimeMessageSpy = vi.fn()
    useTimerStore.setState({ setOvertimeMessage: setOvertimeMessageSpy } as never)
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))

    const switches = screen.getAllByRole('switch')
    await user.click(switches[1])

    expect(setOvertimeMessageSpy).toHaveBeenCalledWith(true, "Time's Up!")
  })

  it('toggling overtime from enabled to disabled calls setOvertimeMessage(false, message)', async () => {
    const user = userEvent.setup()
    const setOvertimeMessageSpy = vi.fn()
    useTimerStore.setState({
      overtimeMessageEnabled: true,
      overtimeMessage: 'Custom!',
      setOvertimeMessage: setOvertimeMessageSpy
    } as never)
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))

    const switches = screen.getAllByRole('switch')
    await user.click(switches[1])

    expect(setOvertimeMessageSpy).toHaveBeenCalledWith(false, 'Custom!')
  })
})

describe('SettingsPopover — overtime input visibility', () => {
  it('shows overtime message input as disabled when overtime is disabled', async () => {
    const user = userEvent.setup()
    useTimerStore.setState({ overtimeMessageEnabled: false })
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.getByRole('textbox', { name: "Time's Up Message" })).toBeDisabled()
  })

  it('shows overtime message input when overtime is enabled', async () => {
    const user = userEvent.setup()
    useTimerStore.setState({ overtimeMessageEnabled: true })
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.getByRole('textbox', { name: "Time's Up Message" })).toBeInTheDocument()
  })
})

describe('SettingsPopover — overtime message text input', () => {
  it('changing overtime message text calls setOvertimeMessage', async () => {
    const user = userEvent.setup()
    const setOvertimeMessageSpy = vi.fn()
    useTimerStore.setState({
      overtimeMessageEnabled: true,
      overtimeMessage: '',
      setOvertimeMessage: setOvertimeMessageSpy
    } as never)
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))

    const overtimeInput = screen.getByRole('textbox', { name: "Time's Up Message" })
    await user.type(overtimeInput, 'Hi')

    expect(setOvertimeMessageSpy).toHaveBeenCalled()
  })

  it('enforces max 15 char limit on overtime message', async () => {
    const user = userEvent.setup()
    const setOvertimeMessageSpy = vi.fn()
    useTimerStore.setState({
      overtimeMessageEnabled: true,
      overtimeMessage: '',
      setOvertimeMessage: setOvertimeMessageSpy
    } as never)
    renderWithI18n()
    await user.click(screen.getByRole('button', { name: /settings/i }))

    const overtimeInput = screen.getByRole('textbox', { name: "Time's Up Message" })
    await user.type(overtimeInput, 'ABCDEFGHIJKLMNOPQRSTU')

    const calls = setOvertimeMessageSpy.mock.calls
    const lastCall = calls[calls.length - 1]
    expect(lastCall[1].length).toBeLessThanOrEqual(15)
  })
})

describe('SettingsPopover — stopwatch mode', () => {
  it('renders settings trigger button in stopwatch mode', () => {
    renderWithI18n('stopwatch')
    expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument()
  })

  it('renders show-on-projection switch in stopwatch mode after opening popover', async () => {
    const user = userEvent.setup()
    renderWithI18n('stopwatch')
    await user.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.getByTestId('switch-show-stopwatch-projection')).toBeInTheDocument()
  })

  it('renders only one switch in stopwatch mode', async () => {
    const user = userEvent.setup()
    renderWithI18n('stopwatch')
    await user.click(screen.getByRole('button', { name: /settings/i }))
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(1)
  })

  it('toggling show-on-projection calls setShowOnProjection', async () => {
    const user = userEvent.setup()
    useStopwatchStore.setState({ showOnProjection: false })
    renderWithI18n('stopwatch')
    await user.click(screen.getByRole('button', { name: /settings/i }))

    const sw = screen.getByRole('switch')
    await user.click(sw)

    expect(useStopwatchStore.getState().showOnProjection).toBe(true)
  })
})
