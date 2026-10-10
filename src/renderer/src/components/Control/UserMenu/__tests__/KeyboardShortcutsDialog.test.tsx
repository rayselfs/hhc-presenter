import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@renderer/i18n'
import KeyboardShortcutsDialog from '@renderer/components/Control/UserMenu/KeyboardShortcutsDialog'
import { ShortcutScopeProvider } from '@renderer/contexts/ShortcutScopeContext'

vi.mock('@renderer/lib/env', () => ({
  isMac: vi.fn(() => false),
  getMetaKeyLabel: vi.fn(() => 'Ctrl'),
  isElectron: vi.fn(() => false),
  isWeb: vi.fn(() => true)
}))

vi.mock('@heroui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@heroui/react')>()
  return {
    ...actual,
    useOverlayState: ({ isOpen }: { isOpen: boolean }) => ({
      isOpen,
      open: vi.fn(),
      close: vi.fn()
    }),
    Modal: Object.assign(actual.Modal, {
      Root: ({ state, children }: { state: { isOpen: boolean }; children: React.ReactNode }) =>
        state.isOpen ? <div role="dialog">{children}</div> : null,
      Trigger: () => null,
      Backdrop: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Header: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Heading: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
      Body: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Footer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
    })
  }
})

const Wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <ShortcutScopeProvider>
    <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
  </ShortcutScopeProvider>
)

describe('KeyboardShortcutsDialog', () => {
  it('renders sidebar with all section names when open', () => {
    render(<KeyboardShortcutsDialog isOpen={true} onOpenChange={() => {}} />, { wrapper: Wrapper })

    expect(screen.getAllByText('Timer').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Bible').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Media').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Video Capture' }))
    expect(screen.getByText('Move left 1 px')).toBeInTheDocument()
    expect(screen.getByText('Move down 10 px')).toBeInTheDocument()
    expect(screen.getAllByText('Shift')).toHaveLength(4)
  })

  it('does not render when isOpen=false', () => {
    const { container } = render(
      <KeyboardShortcutsDialog isOpen={false} onOpenChange={() => {}} />,
      { wrapper: Wrapper }
    )

    expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument()
  })

  it('shows projection shortcuts by default', () => {
    render(<KeyboardShortcutsDialog isOpen={true} onOpenChange={() => {}} />, { wrapper: Wrapper })

    expect(screen.getByText('Start projection')).toBeInTheDocument()
    expect(screen.getByText('F5')).toBeInTheDocument()
  })

  it('switches to timer section on click', () => {
    render(<KeyboardShortcutsDialog isOpen={true} onOpenChange={() => {}} />, { wrapper: Wrapper })

    fireEvent.click(screen.getAllByText('Timer')[0])

    expect(screen.getByText('Start / Stop')).toBeInTheDocument()
    expect(screen.getByText('Reset')).toBeInTheDocument()
  })

  it('switches to bible section on click', () => {
    render(<KeyboardShortcutsDialog isOpen={true} onOpenChange={() => {}} />, { wrapper: Wrapper })

    fireEvent.click(screen.getAllByText('Bible')[0])

    expect(screen.getByText('Previous Verse')).toBeInTheDocument()
    expect(screen.getByText('Next Chapter')).toBeInTheDocument()
  })

  it('switches to media section on click', () => {
    render(<KeyboardShortcutsDialog isOpen={true} onOpenChange={() => {}} />, { wrapper: Wrapper })

    fireEvent.click(screen.getAllByText('Media')[0])

    expect(screen.getByText('Next item')).toBeInTheDocument()
    expect(screen.getByText('Seek forward 5 seconds')).toBeInTheDocument()
    expect(screen.getByText('Next PDF page')).toBeInTheDocument()
  })
})
