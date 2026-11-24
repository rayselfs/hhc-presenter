import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { WeeklyDocument, WeeklyIssue } from '@shared/weekly-reader'
import BulletinPresentation from '../BulletinPresentation'

const projection = vi.hoisted(() => ({
  activeOwner: 'timer',
  recovery: { status: 'ready' },
  startProjection: vi.fn(),
  stopProjection: vi.fn(),
  getProjectionSnapshot: vi.fn(),
  send: vi.fn()
}))
vi.mock('@renderer/contexts/ProjectionContext', () => ({ useProjection: () => projection }))
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key })
}))

const issue: WeeklyIssue = {
  issueId: 'issue',
  documentId: 'document',
  revision: 3,
  series: 'children',
  locale: 'en',
  issueDate: '2026-11-15',
  issueNumber: 101,
  title: 'Sunday'
}
const content: WeeklyDocument = {
  traceCode: 'trace',
  pages: ['First', 'Second'].map((text, i) => ({
    id: String(i),
    label: 'Page ' + (i + 1),
    blocks: [{ id: 'b', fragments: [{ sentenceId: String(i), start: 0, text }] }]
  }))
}
beforeEach(() => {
  vi.clearAllMocks()
  projection.activeOwner = 'timer'
  projection.getProjectionSnapshot.mockImplementation(() => ({ owner: projection.activeOwner }))
  projection.startProjection.mockImplementation(() => {
    projection.activeOwner = 'bulletin'
  })
})

it('starts the first page once, keeps the grid private, changes pages and clears the output on exit', async () => {
  const { unmount } = render(
    <StrictMode>
      <BulletinPresentation document={content} issue={issue} accountId="person" onExit={() => {}} />
    </StrictMode>
  )
  await waitFor(() => expect(projection.startProjection).toHaveBeenCalledTimes(1))
  expect(projection.startProjection).toHaveBeenCalledWith('bulletin', [
    ['bulletin:view', expect.objectContaining({ page: content.pages[0] })]
  ])
  fireEvent.click(screen.getByRole('button', { name: 'bulletinPresentation.grid' }))
  expect(projection.send).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: /Page 2/ }))
  expect(projection.send).toHaveBeenLastCalledWith(
    'bulletin:view',
    expect.objectContaining({ page: content.pages[1] })
  )
  unmount()
  expect(projection.send).toHaveBeenLastCalledWith('bulletin:view', null)
  expect(projection.stopProjection).toHaveBeenCalledOnce()
})

it('leaves an intervening projection owner in control when the bulletin is unmounted', async () => {
  const { unmount } = render(
    <BulletinPresentation document={content} issue={issue} accountId="person" onExit={() => {}} />
  )
  await waitFor(() => expect(projection.startProjection).toHaveBeenCalledOnce())
  projection.activeOwner = 'bible'
  unmount()
  expect(projection.stopProjection).not.toHaveBeenCalled()
  expect(projection.send).not.toHaveBeenCalledWith('bulletin:view', null)
})
