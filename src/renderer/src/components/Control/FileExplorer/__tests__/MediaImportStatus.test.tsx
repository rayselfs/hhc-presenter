import { StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { toast } from '@heroui/react/toast'
import { MediaImportStatus } from '../MediaImportStatus'
import { useMediaImportStore } from '@renderer/stores/media-import'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  close: vi.fn(),
  retry: vi.fn(),
  dismiss: vi.fn()
}))
vi.mock('@heroui/react/toast', () => ({
  toast: Object.assign(mocks.toast, { close: mocks.close })
}))
vi.mock('@renderer/lib/upload-utils', () => ({
  retryFailedImports: mocks.retry,
  dismissImportResults: mocks.dismiss
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

function start(): void {
  act(() => useMediaImportStore.setState({ running: true, total: 3, completed: 0 }))
}

function options(): NonNullable<Parameters<typeof toast>[1]> {
  return mocks.toast.mock.calls.at(-1)![1]
}

describe('MediaImportStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.toast.mockImplementation(() => `toast-${mocks.toast.mock.calls.length}`)
    mocks.close.mockImplementation((key: string) => {
      const call = mocks.toast.mock.calls[Number(key.replace('toast-', '')) - 1]
      call?.[1].onClose?.()
    })
    useMediaImportStore.setState({
      running: false,
      total: 0,
      completed: 0,
      succeeded: 0,
      failures: [],
      currentNames: [],
      destinationNames: [],
      cancelRequested: false
    })
  })

  it('updates one loading toast in StrictMode and supports cancellation', () => {
    start()
    const root = render(
      <StrictMode>
        <MediaImportStatus />
      </StrictMode>
    )
    expect(root.container).toBeEmptyDOMElement()
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    expect(options().isLoading).toBe(true)
    const content = render(<>{options().description}</>)
    act(() => useMediaImportStore.setState({ completed: 1, currentNames: ['second.pptx'] }))
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    expect(screen.getByText('second.pptx')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'fileExplorer.importProgress.cancel' }))
    expect(useMediaImportStore.getState().cancelRequested).toBe(true)
    expect(screen.getByRole('button')).toBeDisabled()
    content.unmount()
  })

  it('keeps failed completion available until dismissal or retry', () => {
    render(<MediaImportStatus />)
    start()
    act(() =>
      useMediaImportStore.setState({
        running: false,
        completed: 3,
        succeeded: 2,
        failures: [{ name: 'bad.pptx', reason: 'Invalid archive' }]
      })
    )
    expect(mocks.close).toHaveBeenCalledWith('toast-1')
    expect(mocks.toast).toHaveBeenCalledTimes(2)
    expect(mocks.dismiss).not.toHaveBeenCalled()
    expect(options().timeout).toBe(0)
    expect(options().variant).toBe('danger')
    render(<>{options().description}</>)
    expect(screen.getByText('bad.pptx: Invalid archive')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'fileExplorer.importProgress.retry' }))
    expect(mocks.retry).toHaveBeenCalledOnce()
  })

  it('auto-dismisses a successful result and releases retained import data', () => {
    render(<MediaImportStatus />)
    start()
    act(() => useMediaImportStore.setState({ running: false, completed: 3, succeeded: 3 }))
    expect(options().variant).toBe('success')
    expect(options().timeout).toBe(6000)
    act(() => options().onClose?.())
    expect(mocks.dismiss).toHaveBeenCalledOnce()
  })

  it('does not let an old completion close dismiss a new import or its failures', () => {
    render(<MediaImportStatus />)
    start()
    act(() => useMediaImportStore.setState({ running: false, completed: 3, succeeded: 3 }))
    const oldCompletion = options()
    start()
    expect(mocks.close).toHaveBeenCalledWith('toast-2')
    expect(mocks.dismiss).not.toHaveBeenCalled()
    act(() =>
      useMediaImportStore.setState({
        running: false,
        failures: [{ name: 'new.pptx', reason: 'Invalid archive' }]
      })
    )
    act(() => oldCompletion.onClose?.())
    expect(mocks.dismiss).not.toHaveBeenCalled()
    expect(useMediaImportStore.getState().failures).toEqual([
      { name: 'new.pptx', reason: 'Invalid archive' }
    ])
    expect(options().variant).toBe('danger')
  })

  it('does not reopen a dismissed session but opens for a new import', () => {
    render(<MediaImportStatus />)
    start()
    act(() => options().onClose?.())
    act(() => useMediaImportStore.setState({ completed: 1 }))
    act(() => useMediaImportStore.setState({ running: false }))
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    start()
    expect(mocks.toast).toHaveBeenCalledTimes(2)
  })
})
