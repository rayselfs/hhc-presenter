import { act, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import LyricsOutput from '../LyricsOutput'
import { DEFAULT_LYRICS_STYLE } from '@shared/lyrics'
vi.mock('@renderer/lib/font-loader', () => ({
  loadPresentationFont: vi.fn().mockResolvedValue(undefined)
}))
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 64 }),
    font: ''
  } as unknown as CanvasRenderingContext2D)
})
afterEach(() => vi.restoreAllMocks())
it('renders all three source lines without wrapping or HTML interpretation', async () => {
  const output = {
    lines: ['第一行', '第二行', '<script>'],
    style: DEFAULT_LYRICS_STYLE,
    visible: true,
    expiresAt: Date.now() + 60000
  }
  const { rerender } = render(<LyricsOutput output={output} />)
  await waitFor(() => expect(screen.getAllByTestId('lyrics-line')).toHaveLength(3))
  expect(screen.getAllByTestId('lyrics-line').map((n) => n.textContent)).toEqual(output.lines)
  expect(screen.getAllByTestId('lyrics-line')[0]).toHaveStyle({ whiteSpace: 'pre' })
  rerender(
    <LyricsOutput
      output={{ ...output, style: { ...output.style, fontSize: 80, lineHeight: 1.5 } }}
    />
  )
  await waitFor(() =>
    expect(screen.getAllByTestId('lyrics-line').map((n) => n.textContent)).toEqual(output.lines)
  )
  expect(screen.getByTestId('lyrics-lines')).toHaveStyle({ bottom: '5%' })
})
it('shows black instead of clipping long lines and reports overflow', async () => {
  const onOverflow = vi.fn()
  render(
    <LyricsOutput
      output={{
        lines: ['a'.repeat(50)],
        style: DEFAULT_LYRICS_STYLE,
        visible: true,
        expiresAt: Date.now() + 60000
      }}
      onOverflow={onOverflow}
    />
  )
  await waitFor(() => expect(onOverflow).toHaveBeenCalledWith(true))
  expect(screen.queryByTestId('lyrics-lines')).toBeNull()
})
it('expires stale snapshots without waiting for another message', async () => {
  vi.useFakeTimers()
  try {
    render(
      <LyricsOutput
        output={{
          lines: ['第一行'],
          style: DEFAULT_LYRICS_STYLE,
          visible: true,
          expiresAt: Date.now() + 1000
        }}
      />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('lyrics-lines')).not.toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(1001)
    })
    expect(screen.queryByTestId('lyrics-lines')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})
