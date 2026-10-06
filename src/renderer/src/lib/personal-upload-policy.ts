// Keep aligned with Asset API internal/assets/policy.go PersonalNamespace.
const PERSONAL_MAX_FILE_BYTES = 200 * 1024 * 1024
const PERSONAL_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/ogg',
  'video/x-msvideo',
  'video/x-matroska',
  'video/x-ms-wmv',
  'audio/mpeg',
  'audio/wav',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.hhc.presenter+json'
])

export class PersonalUploadPolicyError extends Error {
  constructor(public readonly code: 'unsupported-mime' | 'file-too-large' | 'empty-file') {
    super(code)
  }
}

export function assertPersonalUploadPolicy(size: number, mimeType: string): void {
  if (!Number.isSafeInteger(size) || size <= 0) throw new PersonalUploadPolicyError('empty-file')
  if (size > PERSONAL_MAX_FILE_BYTES) throw new PersonalUploadPolicyError('file-too-large')
  if (!PERSONAL_MIME_TYPES.has(mimeType)) throw new PersonalUploadPolicyError('unsupported-mime')
}
