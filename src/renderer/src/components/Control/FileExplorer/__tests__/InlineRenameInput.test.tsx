import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InlineRenameInput } from '../InlineRenameInput'

describe('InlineRenameInput', () => {
  it('submits with Enter', () => {
    const onSubmit = vi.fn()
    render(
      <InlineRenameInput
        initialValue="slides"
        ariaLabel="Rename file"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    )

    fireEvent.change(screen.getByLabelText('Rename file'), { target: { value: 'sermon' } })
    fireEvent.keyDown(screen.getByLabelText('Rename file'), { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledWith('sermon')
  })

  it('does not submit Enter during IME composition', () => {
    const onSubmit = vi.fn()
    const input = render(
      <InlineRenameInput
        initialValue="講道"
        ariaLabel="Rename file"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    ).getByLabelText('Rename file')

    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('講道')
  })

  it('cancels with Escape and submits once on blur', () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const input = render(
      <InlineRenameInput
        initialValue="slides"
        ariaLabel="Rename file"
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    ).getByLabelText('Rename file')

    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

it('prevents duplicate submissions while pending and retries a failed durable write with the same input', async () => {
  let finish!: (value: boolean) => void
  const pending = new Promise<boolean>((resolve) => {
    finish = resolve
  })
  const onSubmit = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(true)
  const onCancel = vi.fn()
  const input = render(
    <InlineRenameInput
      initialValue="Original"
      ariaLabel="Rename file"
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  ).getByLabelText('Rename file') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: 'Renamed' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.blur(input)
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(onCancel).not.toHaveBeenCalled()
  expect(input.readOnly).toBe(true)
  await act(async () => {
    finish(false)
    await pending
  })
  expect(input.value).toBe('Renamed')
  expect(input.readOnly).toBe(false)
  expect(document.activeElement).toBe(input)
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter' })
  })
  expect(onSubmit.mock.calls).toEqual([['Renamed'], ['Renamed']])
})

it('resets the submission guard after a rejected callback', async () => {
  const onSubmit = vi.fn().mockRejectedValueOnce(new Error('Aborted')).mockResolvedValueOnce(true)
  const input = render(
    <InlineRenameInput
      initialValue="Original"
      ariaLabel="Rename file"
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />
  ).getByLabelText('Rename file') as HTMLTextAreaElement
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter' })
  })
  await waitFor(() => expect(input.readOnly).toBe(false))
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter' })
  })
  expect(onSubmit).toHaveBeenCalledTimes(2)
})
