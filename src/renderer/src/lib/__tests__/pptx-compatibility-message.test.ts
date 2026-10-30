import { beforeEach, expect, it } from 'vitest'
import i18n from '@renderer/i18n'
import { PptxCompatibilityError } from '../pptx-compatibility'
import { formatPptxCompatibilityError } from '../pptx-compatibility-message'

beforeEach(async () => {
  await i18n.changeLanguage('en')
})

it.each([
  ['en', 'Slide 5', 'Object 3', 'animation', 'source file has not been changed'],
  ['zh-TW', '第 5 張投影片', '第 3 個物件', '動畫', '原檔未被修改'],
  ['zh-CN', '第 5 张幻灯片', '第 3 个对象', '动画', '原文件未被修改']
])(
  'shows safe localized location and reason in %s',
  async (locale, slide, object, reason, preserved) => {
    await i18n.changeLanguage(locale)
    const cause = new Error('private node name <p:timing/>')
    const error = new PptxCompatibilityError(
      {
        code: 'animation',
        slideNumber: 5,
        objectNumber: 3,
        objectId: 'private',
        sourcePart: 'private/path.xml'
      },
      cause.message,
      { cause }
    )
    const message = formatPptxCompatibilityError(error)
    expect(message).toContain(slide)
    expect(message).toContain(object)
    expect(message).toContain(reason)
    expect(message).toContain(preserved)
    expect(message).not.toMatch(/private|<p:|path.xml/)
    expect(error.cause).toBe(cause)
  }
)

it('omits unavailable location and preserves unrelated account errors', () => {
  const message = formatPptxCompatibilityError(
    new PptxCompatibilityError({ code: 'invalid-package' })
  )
  expect(message).not.toMatch(/Slide|Object|undefined|NaN/)
  expect(message).toContain('encrypted')
  expect(formatPptxCompatibilityError(new Error('Personal account changed'))).toBe(
    'Personal account changed'
  )
})
