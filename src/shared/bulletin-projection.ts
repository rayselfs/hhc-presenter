import type { BulletinHighlight, BulletinPage, BulletinPosition } from './bulletin-reader'

export interface BulletinProjectionView {
  page: BulletinPage
  traceCode: string
  fontScale: number
  highlights: BulletinHighlight[]
  position: BulletinPosition | null
}

export interface BulletinProjectionScroll {
  pageId: string
  position: BulletinPosition
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function offset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validPosition(value: unknown): value is BulletinPosition {
  if (!record(value)) return false
  if ('scrollRatio' in value)
    return typeof value.scrollRatio === 'number' && value.scrollRatio >= 0 && value.scrollRatio <= 1
  return (
    typeof value.sentenceId === 'string' &&
    offset(value.offset) &&
    typeof value.within === 'number' &&
    Number.isFinite(value.within)
  )
}

export function isBulletinScroll(value: unknown): value is BulletinProjectionScroll {
  return record(value) && typeof value.pageId === 'string' && validPosition(value.position)
}

export function isBulletinView(value: unknown): value is BulletinProjectionView {
  if (!record(value) || !record(value.page)) return false
  const page = value.page
  return (
    typeof page.id === 'string' &&
    typeof page.label === 'string' &&
    Array.isArray(page.blocks) &&
    page.blocks.every(
      (block: unknown) =>
        record(block) &&
        typeof block.id === 'string' &&
        (block.kind === undefined ||
          ['heading', 'paragraph', 'lyrics'].includes(String(block.kind))) &&
        (block.image === undefined ||
          (record(block.image) &&
            typeof block.image.src === 'string' &&
            block.image.src.startsWith('data:image/png;base64,') &&
            typeof block.image.alt === 'string')) &&
        Array.isArray(block.fragments) &&
        block.fragments.every(
          (fragment: unknown) =>
            record(fragment) &&
            typeof fragment.sentenceId === 'string' &&
            offset(fragment.start) &&
            typeof fragment.text === 'string'
        )
    ) &&
    typeof value.traceCode === 'string' &&
    typeof value.fontScale === 'number' &&
    Number.isFinite(value.fontScale) &&
    value.fontScale > 0 &&
    Array.isArray(value.highlights) &&
    value.highlights.every(
      (range: unknown) =>
        record(range) &&
        typeof range.sentenceId === 'string' &&
        offset(range.start) &&
        offset(range.end) &&
        range.end > range.start
    ) &&
    (value.position === null || validPosition(value.position))
  )
}
