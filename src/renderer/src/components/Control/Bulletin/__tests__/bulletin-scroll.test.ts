import { expect, it } from 'vitest'
import { isBulletinScroll } from '@shared/bulletin-projection'
import { followPosition, readPosition } from '../bulletin-text'

function scroller(clientHeight: number, scrollHeight: number): HTMLDivElement {
  const node = document.createElement('div')
  Object.defineProperties(node, {
    clientHeight: { value: clientHeight },
    scrollHeight: { value: scrollHeight }
  })
  return node
}

it('follows the operator through image-only viewports including the bottom edge', () => {
  const operator = scroller(500, 2000)
  operator.append(document.createElement('img'))
  const projection = scroller(800, 3200)
  for (const ratio of [0, 0.5, 1]) {
    operator.scrollTop = ratio * 1500
    const position = readPosition(operator)
    expect(position).toEqual({ scrollRatio: ratio })
    expect(isBulletinScroll({ pageId: 'page', position })).toBe(true)
    followPosition(projection, position!)
    expect(projection.scrollTop).toBe(ratio * 2400)
  }
  expect(isBulletinScroll({ pageId: 'page', position: { scrollRatio: 1.5 } })).toBe(false)
})
