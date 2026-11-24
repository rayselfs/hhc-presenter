import { fireEvent, render, screen } from '@testing-library/react'
import type { BulletinPage } from '@shared/bulletin-reader'
import BulletinPageView from '../BulletinPageView'
import { highlightRuns, selectedHighlights } from '../bulletin-text'
import {
  bulletinHighlightKey,
  useBulletinHighlightsStore
} from '@renderer/stores/bulletin-highlights'

const page: BulletinPage = {
  id: 'page-2',
  label: '第 1 頁',
  blocks: [
    { id: 'a', fragments: [{ sentenceId: 's1', start: 2, text: '甲😀乙' }] },
    { id: 'b', fragments: [{ sentenceId: 's2', start: 0, text: '丙丁' }] }
  ]
}

it('marks only the overlapping Unicode range of a split sentence', () => {
  expect(
    highlightRuns(page.blocks[0].fragments[0], [
      { sentenceId: 's1', start: 0, end: 3 },
      { sentenceId: 's1', start: 2, end: 4 }
    ])
      .filter((run) => run.marked)
      .map((run) => run.text)
      .join('')
  ).toBe('甲😀')
})

it('commits one cross-paragraph gesture in note mode, excluding text outside the page', () => {
  const onHighlight = vi.fn()
  const { rerender } = render(
    <BulletinPageView page={page} fontScale={1} highlights={[]} onHighlight={onHighlight} />
  )
  const region = screen.getByRole('region')
  const range = document.createRange()
  range.setStart(screen.getByText('甲😀乙').firstChild!, 1)
  range.setEnd(screen.getByText('丙丁').firstChild!, 1)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent.keyUp(region, { key: 'Shift' })
  expect(onHighlight).not.toHaveBeenCalled()
  rerender(
    <BulletinPageView
      page={page}
      fontScale={1}
      highlights={[]}
      onHighlight={onHighlight}
      noteMode
    />
  )
  fireEvent.keyUp(region, { key: 'Shift' })
  expect(onHighlight).toHaveBeenCalledExactlyOnceWith([
    { sentenceId: 's1', start: 3, end: 5 },
    { sentenceId: 's2', start: 0, end: 1 }
  ])
  expect(selection.rangeCount).toBe(0)
  range.selectNodeContents(document.body)
  selection.addRange(range)
  expect(selectedHighlights(region, selection)).toEqual([])
  selection.removeAllRanges()
})

it('rehydrates anchors by account and published edition without storing the text', async () => {
  const store = useBulletinHighlightsStore
  store.setState({ byEdition: {} })
  const key = bulletinHighlightKey('user', 'doc', 'general', 'zh-Hant', 3)
  const anchors = [{ sentenceId: 's1', start: 2, end: 4 }]
  store.getState().add(key, anchors)
  await store.persist.rehydrate()
  expect(store.getState().byEdition[key]).toEqual([anchors])
  expect(
    store.getState().byEdition[bulletinHighlightKey('other', 'doc', 'general', 'zh-Hant', 3)]
  ).toBeUndefined()
  expect(
    store.getState().byEdition[bulletinHighlightKey('user', 'doc', 'general', 'zh-Hant', 4)]
  ).toBeUndefined()
  store.getState().undo(key)
  expect(store.getState().byEdition[key]).toBeUndefined()
})

it('anchors scroll to a Unicode character across differently wrapped viewports', async () => {
  const { readPosition, followPosition } = await import('../bulletin-text')
  const rect = (top: number, height: number): DOMRect => new DOMRect(0, top, 100, height)
  const root = document.createElement('div')
  const fragment = document.createElement('span')
  fragment.dataset.bulletinSentence = 'long'
  fragment.dataset.start = '12'
  fragment.textContent = '甲乙丙丁戊己庚辛'
  root.append(fragment)
  let perLine = 2
  Object.defineProperty(root, 'clientHeight', { value: 100 })
  root.getBoundingClientRect = () => rect(0, 100)
  fragment.getBoundingClientRect = () => rect(-root.scrollTop, 80)
  const original = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Range) {
      return rect(20 * Math.floor(this.startOffset / perLine) - root.scrollTop, 20)
    }
  })
  try {
    root.scrollTop = 23
    const position = readPosition(root)
    expect(position).toEqual({ sentenceId: 'long', offset: 14, within: -0.03 })
    perLine = 1
    followPosition(root, position!)
    expect(root.scrollTop).toBe(43)
  } finally {
    if (original) Object.defineProperty(Range.prototype, 'getBoundingClientRect', original)
    else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
  }
})
