import i18n from '@renderer/i18n'
import { PptxCompatibilityError } from './pptx-compatibility'

export function formatPptxCompatibilityError(error: unknown): string {
  if (!(error instanceof PptxCompatibilityError))
    return error instanceof Error ? error.message : i18n.t('personalCloud.failed')
  const { code, slideNumber, objectNumber } = error.diagnostic
  const location = [
    slideNumber === undefined
      ? ''
      : i18n.t('presentationWorkspace.exportErrorSlide', { slide: slideNumber }),
    objectNumber === undefined
      ? ''
      : i18n.t('presentationWorkspace.exportErrorElement', { element: objectNumber })
  ]
    .filter(Boolean)
    .join(' · ')
  const reason = i18n.t(`presentationWorkspace.importErrors.${code}`)
  return `${location ? `${location}: ` : ''}${reason} ${i18n.t('presentationWorkspace.importOriginalKept')}`
}
