import type { EditablePresentationDocument } from './editable-presentation'
import { serializePortablePresentation } from './portable-presentation'
import { validatePptxPackage, validatePptxSource } from './pptx-source'
import { buildNativePptx } from './pptx-export-package'
import { PptxExportError } from './pptx-export-drawingml'
import { PPTX_MIME_TYPE } from './presentation-media'
export { PptxExportError, type PptxExportDiagnostic } from './pptx-export-drawingml'

export async function exportPresentationPptx(
  document: EditablePresentationDocument
): Promise<Blob> {
  try {
    const snapshot: EditablePresentationDocument = JSON.parse(
      serializePortablePresentation(document)
    )
    await validatePptxSource(snapshot)
    if (snapshot.pptxSource)
      throw new PptxExportError([
        { code: 'source-conflict', message: 'Retained source export is not available yet' }
      ])
    const bytes = await buildNativePptx(snapshot)
    await validatePptxPackage(bytes)
    return new Blob([bytes], { type: PPTX_MIME_TYPE })
  } catch (error) {
    if (error instanceof PptxExportError) throw error
    throw new PptxExportError(
      [
        {
          code:
            error instanceof Error && /size limit|entry count limit/.test(error.message)
              ? 'package-limit'
              : 'invalid-value',
          message: error instanceof Error ? error.message : 'PPTX export failed'
        }
      ],
      { cause: error }
    )
  }
}
