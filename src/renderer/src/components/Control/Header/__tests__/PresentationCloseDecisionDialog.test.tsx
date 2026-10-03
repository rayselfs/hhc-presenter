import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import PresentationCloseDecisionDialog from '../PresentationCloseDecisionDialog'
import {
  PresentationCloseDecisionProvider,
  usePresentationCloseDecision,
  type CloseDecision
} from '@renderer/contexts/PresentationCloseDecisionContext'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key })
}))

function DecisionHarness({
  onDecision
}: {
  onDecision: (decision: Promise<CloseDecision>) => void
}): React.JSX.Element {
  const requestDecision = usePresentationCloseDecision()
  return (
    <button type="button" onClick={() => onDecision(requestDecision(['deck-1']))}>
      Request close
    </button>
  )
}

describe('PresentationCloseDecisionDialog', () => {
  it.each([
    ['Keep editing', 'keep-editing'],
    ['Retry save', 'retry'],
    ['Close without saving', 'discard']
  ] as const)('resolves %s as %s', async (label, expected) => {
    const user = userEvent.setup()
    let decision: Promise<CloseDecision> | null = null
    render(
      <PresentationCloseDecisionProvider>
        <DecisionHarness onDecision={(next) => (decision = next)} />
        <PresentationCloseDecisionDialog />
      </PresentationCloseDecisionProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Request close' }))
    await user.click(screen.getByRole('button', { name: label }))

    await expect(decision).resolves.toBe(expected)
    expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
  })

  it('returns the existing decision promise while a request is pending', async () => {
    const user = userEvent.setup()
    const decisions: Promise<CloseDecision>[] = []
    render(
      <PresentationCloseDecisionProvider>
        <DecisionHarness onDecision={(next) => decisions.push(next)} />
        <PresentationCloseDecisionDialog />
      </PresentationCloseDecisionProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Request close' }))
    await user.click(screen.getByRole('button', { name: 'Request close' }))

    expect(decisions).toHaveLength(2)
    expect(decisions[0]).toBe(decisions[1])
  })
})
