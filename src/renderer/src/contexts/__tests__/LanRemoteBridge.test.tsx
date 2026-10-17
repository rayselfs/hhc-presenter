import type { LanRemoteCommand } from '@shared/lan-remote'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import LanRemoteBridge from '@renderer/contexts/LanRemoteBridge'
import { useSettingsStore, DEFAULT_LAN_REMOTE } from '@renderer/stores/settings'

const mocks = vi.hoisted(() => ({
  executeLanRemoteCommand: vi.fn(),
  createLanRemoteSnapshot: vi.fn(() => ({ revision: 1 })),
  onCommand: vi.fn<(callback: (command: LanRemoteCommand) => void) => () => void>(() => vi.fn()),
  publishState: vi.fn(),
  publishAck: vi.fn()
}))

vi.mock('@renderer/lib/env', () => ({
  isElectron: () => true
}))

vi.mock('@renderer/contexts/ProjectionContext', () => ({
  useProjection: () => ({ isProjectionOpen: true })
}))

vi.mock('@renderer/lib/lan-remote-command-gateway', () => ({
  executeLanRemoteCommand: mocks.executeLanRemoteCommand,
  createLanRemoteSnapshot: mocks.createLanRemoteSnapshot
}))

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ lanRemote: DEFAULT_LAN_REMOTE })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      lanRemote: {
        onCommand: mocks.onCommand,
        publishState: mocks.publishState,
        publishAck: mocks.publishAck
      }
    }
  })
})

it('activates command and state bridges only while the LAN server is enabled', async () => {
  render(<LanRemoteBridge />)

  expect(mocks.onCommand).not.toHaveBeenCalled()
  expect(mocks.publishState).not.toHaveBeenCalled()

  act(() => {
    useSettingsStore.getState().setLanRemote({
      ...DEFAULT_LAN_REMOTE,
      enabled: true,
      selectedHost: '192.168.1.10'
    })
  })

  await waitFor(() => {
    expect(mocks.onCommand).toHaveBeenCalledOnce()
    expect(mocks.publishState).toHaveBeenCalledOnce()
  })
})

it('publishes accepted command state before acknowledging immediate remote readback', async () => {
  useSettingsStore.setState({ lanRemote: { ...DEFAULT_LAN_REMOTE, enabled: true } })
  const ack = { requestId: 'duration-75', status: 'accepted' }
  mocks.executeLanRemoteCommand.mockResolvedValue(ack)
  render(<LanRemoteBridge />)
  mocks.publishState.mockClear()
  let finishPublication!: () => void
  mocks.publishState.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishPublication = resolve
      })
  )
  await act(async () => {
    mocks.onCommand.mock.calls[0][0]({
      requestId: 'duration-75',
      type: 'timer:command',
      command: { type: 'setDuration', seconds: 75 }
    })
  })
  expect(mocks.publishState).toHaveBeenCalledOnce()
  expect(mocks.publishAck).not.toHaveBeenCalled()
  await act(async () => finishPublication())
  expect(mocks.publishAck).toHaveBeenCalledWith(ack)
})

it('does not publish new state for a rejected command', async () => {
  useSettingsStore.setState({ lanRemote: { ...DEFAULT_LAN_REMOTE, enabled: true } })
  const ack = { requestId: 'rejected', status: 'rejected', reason: 'not-initialized' }
  mocks.executeLanRemoteCommand.mockResolvedValue(ack)
  render(<LanRemoteBridge />)
  mocks.publishState.mockClear()
  await act(async () =>
    mocks.onCommand.mock.calls[0][0]({
      requestId: 'rejected',
      type: 'timer:command',
      command: { type: 'start' }
    })
  )
  expect(mocks.publishState).not.toHaveBeenCalled()
  expect(mocks.publishAck).toHaveBeenCalledWith(ack)
})

it('does not falsely acknowledge success when state publication fails', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    useSettingsStore.setState({ lanRemote: { ...DEFAULT_LAN_REMOTE, enabled: true } })
    mocks.executeLanRemoteCommand.mockResolvedValue({
      requestId: 'publication-failed',
      status: 'accepted'
    })
    render(<LanRemoteBridge />)
    mocks.publishState.mockRejectedValueOnce(new Error('IPC unavailable'))
    await act(async () =>
      mocks.onCommand.mock.calls[0][0]({
        requestId: 'publication-failed',
        type: 'timer:command',
        command: { type: 'start' }
      })
    )
    expect(log).toHaveBeenCalledWith('[lan-remote] Command publication failed', expect.any(Error))
    expect(mocks.publishAck).not.toHaveBeenCalled()
  } finally {
    log.mockRestore()
  }
})
