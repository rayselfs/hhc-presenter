export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'presentation' | 'document'
export type MediaPlatform = 'web' | 'electron'
export type MediaSupportMode = 'native' | 'desktop-engine' | 'unsupported'
export type ThumbnailStrategy = 'image' | 'video' | 'pdf' | 'presentation' | 'none'

export interface MediaCapability {
  kind: MediaKind
  extensions: readonly string[]
  canonicalMimeType: string
  aliases?: readonly string[]
  thumbnail: ThumbnailStrategy
  web: MediaSupportMode
  electron: MediaSupportMode
  kindLabelKey?: string
  kindLabelFallback?: string
}

export interface ClassifiedFile {
  kind: MediaKind | 'unsupported'
  mimeType: string
  extension: string
  support: MediaSupportMode
}

const CAPABILITIES: readonly MediaCapability[] = [
  {
    kind: 'image',
    extensions: ['png'],
    canonicalMimeType: 'image/png',
    thumbnail: 'image',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.pngImage',
    kindLabelFallback: 'PNG Image'
  },
  {
    kind: 'image',
    extensions: ['jpg', 'jpeg'],
    canonicalMimeType: 'image/jpeg',
    aliases: ['image/jpg'],
    thumbnail: 'image',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.jpegImage',
    kindLabelFallback: 'JPEG Image'
  },
  {
    kind: 'image',
    extensions: ['gif'],
    canonicalMimeType: 'image/gif',
    thumbnail: 'image',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.gifImage',
    kindLabelFallback: 'GIF Image'
  },
  {
    kind: 'image',
    extensions: ['webp'],
    canonicalMimeType: 'image/webp',
    thumbnail: 'image',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.webpImage',
    kindLabelFallback: 'WebP Image'
  },
  {
    kind: 'image',
    extensions: ['svg'],
    canonicalMimeType: 'image/svg+xml',
    thumbnail: 'image',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.svgImage',
    kindLabelFallback: 'SVG Image'
  },
  {
    kind: 'image',
    extensions: ['bmp'],
    canonicalMimeType: 'image/bmp',
    thumbnail: 'image',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.bmpImage',
    kindLabelFallback: 'BMP Image'
  },
  {
    kind: 'image',
    extensions: ['tif', 'tiff'],
    canonicalMimeType: 'image/tiff',
    thumbnail: 'image',
    web: 'unsupported',
    electron: 'unsupported',
    kindLabelKey: 'fileKind.tiffImage',
    kindLabelFallback: 'TIFF Image'
  },
  {
    kind: 'image',
    extensions: ['heic'],
    canonicalMimeType: 'image/heic',
    thumbnail: 'image',
    web: 'unsupported',
    electron: 'unsupported',
    kindLabelKey: 'fileKind.heicImage',
    kindLabelFallback: 'HEIC Image'
  },
  {
    kind: 'image',
    extensions: ['heif'],
    canonicalMimeType: 'image/heif',
    thumbnail: 'image',
    web: 'unsupported',
    electron: 'unsupported',
    kindLabelKey: 'fileKind.heifImage',
    kindLabelFallback: 'HEIF Image'
  },
  {
    kind: 'audio',
    extensions: ['mp3'],
    canonicalMimeType: 'audio/mpeg',
    aliases: ['audio/mp3'],
    thumbnail: 'none',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.mp3Audio',
    kindLabelFallback: 'MP3 Audio'
  },
  {
    kind: 'audio',
    extensions: ['wav'],
    canonicalMimeType: 'audio/wav',
    aliases: ['audio/x-wav', 'audio/wave'],
    thumbnail: 'none',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.wavAudio',
    kindLabelFallback: 'WAV Audio'
  },
  {
    kind: 'audio',
    extensions: ['m4a'],
    canonicalMimeType: 'audio/mp4',
    aliases: ['audio/x-m4a'],
    thumbnail: 'none',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.m4aAudio',
    kindLabelFallback: 'M4A Audio'
  },
  {
    kind: 'audio',
    extensions: ['aac'],
    canonicalMimeType: 'audio/aac',
    thumbnail: 'none',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.aacAudio',
    kindLabelFallback: 'AAC Audio'
  },
  {
    kind: 'audio',
    extensions: ['ogg'],
    canonicalMimeType: 'audio/ogg',
    aliases: ['application/ogg'],
    thumbnail: 'none',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.oggAudio',
    kindLabelFallback: 'OGG Audio'
  },
  {
    kind: 'video',
    extensions: ['mp4', 'm4v'],
    canonicalMimeType: 'video/mp4',
    thumbnail: 'video',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.mp4Video',
    kindLabelFallback: 'MP4 Video'
  },
  {
    kind: 'video',
    extensions: ['mov'],
    canonicalMimeType: 'video/quicktime',
    thumbnail: 'video',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.quicktimeVideo',
    kindLabelFallback: 'QuickTime Video'
  },
  {
    kind: 'video',
    extensions: ['webm'],
    canonicalMimeType: 'video/webm',
    thumbnail: 'video',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.webmVideo',
    kindLabelFallback: 'WebM Video'
  },
  {
    kind: 'video',
    extensions: ['ogv'],
    canonicalMimeType: 'video/ogg',
    thumbnail: 'video',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.oggVideo',
    kindLabelFallback: 'OGG Video'
  },
  {
    kind: 'video',
    extensions: ['avi'],
    canonicalMimeType: 'video/x-msvideo',
    aliases: ['video/avi'],
    thumbnail: 'none',
    web: 'unsupported',
    electron: 'desktop-engine',
    kindLabelKey: 'fileKind.aviVideo',
    kindLabelFallback: 'AVI Video'
  },
  {
    kind: 'video',
    extensions: ['mkv'],
    canonicalMimeType: 'video/x-matroska',
    thumbnail: 'video',
    web: 'native',
    electron: 'desktop-engine',
    kindLabelKey: 'fileKind.mkvVideo',
    kindLabelFallback: 'MKV Video'
  },
  {
    kind: 'video',
    extensions: ['wmv'],
    canonicalMimeType: 'video/x-ms-wmv',
    aliases: ['video/x-ms-asf'],
    thumbnail: 'none',
    web: 'unsupported',
    electron: 'desktop-engine',
    kindLabelKey: 'fileKind.wmvVideo',
    kindLabelFallback: 'WMV Video'
  },
  {
    kind: 'video',
    extensions: ['mpg', 'mpeg'],
    canonicalMimeType: 'video/mpeg',
    thumbnail: 'none',
    web: 'unsupported',
    electron: 'unsupported',
    kindLabelKey: 'fileKind.mpegVideo',
    kindLabelFallback: 'MPEG Video'
  },
  {
    kind: 'pdf',
    extensions: ['pdf'],
    canonicalMimeType: 'application/pdf',
    thumbnail: 'pdf',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.pdfDocument',
    kindLabelFallback: 'PDF Document'
  },
  {
    kind: 'presentation',
    extensions: ['pptx'],
    canonicalMimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    thumbnail: 'presentation',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.powerpointPresentation',
    kindLabelFallback: 'PowerPoint Presentation'
  },
  {
    kind: 'presentation',
    extensions: ['lpdeck'],
    canonicalMimeType: 'application/vnd.hhc.presenter+json',
    thumbnail: 'presentation',
    web: 'native',
    electron: 'native',
    kindLabelKey: 'fileKind.presentation',
    kindLabelFallback: 'Presentation'
  },
  {
    kind: 'document',
    extensions: ['ppt'],
    canonicalMimeType: 'application/vnd.ms-powerpoint',
    thumbnail: 'none',
    web: 'unsupported',
    electron: 'unsupported',
    kindLabelKey: 'fileKind.powerpointPresentation',
    kindLabelFallback: 'PowerPoint Presentation'
  },
  {
    kind: 'document',
    extensions: ['key'],
    canonicalMimeType: 'application/vnd.apple.keynote',
    thumbnail: 'none',
    web: 'unsupported',
    electron: 'unsupported',
    kindLabelKey: 'fileKind.keynotePresentation',
    kindLabelFallback: 'Keynote Presentation'
  },
  {
    kind: 'document',
    extensions: ['odp'],
    canonicalMimeType: 'application/vnd.oasis.opendocument.presentation',
    thumbnail: 'none',
    web: 'unsupported',
    electron: 'unsupported',
    kindLabelKey: 'fileKind.presentation',
    kindLabelFallback: 'Presentation'
  }
]

const GENERIC_IMAGE_CAPABILITY: MediaCapability = {
  kind: 'image',
  extensions: [],
  canonicalMimeType: 'image/*',
  thumbnail: 'image',
  web: 'native',
  electron: 'native'
}

const GENERIC_VIDEO_CAPABILITY: MediaCapability = {
  kind: 'video',
  extensions: [],
  canonicalMimeType: 'video/*',
  thumbnail: 'none',
  web: 'unsupported',
  electron: 'unsupported'
}

const GENERIC_AUDIO_CAPABILITY: MediaCapability = {
  kind: 'audio',
  extensions: [],
  canonicalMimeType: 'audio/*',
  thumbnail: 'none',
  web: 'native',
  electron: 'native'
}

function normalizeMimeType(mimeType: string | undefined): string {
  return mimeType?.split(';', 1)[0].trim().toLowerCase() ?? ''
}

export function getFileExtension(fileName: string | undefined): string {
  if (!fileName) return ''
  const baseName = fileName.split(/[\\/]/).pop() ?? ''
  const dotIndex = baseName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) return ''
  return baseName.slice(dotIndex + 1).toLowerCase()
}

function buildCapabilityIndexes(): {
  mime: ReadonlyMap<string, MediaCapability>
  extension: ReadonlyMap<string, MediaCapability>
} {
  const mime = new Map<string, MediaCapability>()
  const extension = new Map<string, MediaCapability>()

  for (const capability of CAPABILITIES) {
    for (const value of [capability.canonicalMimeType, ...(capability.aliases ?? [])]) {
      const normalized = normalizeMimeType(value)
      if (mime.has(normalized)) throw new Error(`Duplicate media MIME registration: ${normalized}`)
      mime.set(normalized, capability)
    }
    for (const value of capability.extensions) {
      const normalized = value.toLowerCase()
      if (extension.has(normalized)) {
        throw new Error(`Duplicate media extension registration: ${normalized}`)
      }
      extension.set(normalized, capability)
    }
  }

  return { mime, extension }
}

const INDEXES = buildCapabilityIndexes()

export function resolveMediaCapability(input: {
  mimeType?: string
  fileName?: string
}): MediaCapability | null {
  const mimeType = normalizeMimeType(input.mimeType)
  const exact = INDEXES.mime.get(mimeType)
  if (exact) return exact

  const byExtension = INDEXES.extension.get(getFileExtension(input.fileName))
  if (byExtension) return byExtension

  if (mimeType.startsWith('image/')) return GENERIC_IMAGE_CAPABILITY
  if (mimeType.startsWith('video/')) return GENERIC_VIDEO_CAPABILITY
  if (mimeType.startsWith('audio/')) return GENERIC_AUDIO_CAPABILITY
  return null
}

export function classifyFile(
  file: Pick<File, 'name' | 'type'>,
  platform: MediaPlatform = 'web'
): ClassifiedFile {
  const capability = resolveMediaCapability({ mimeType: file.type, fileName: file.name })
  const normalizedMimeType = normalizeMimeType(file.type)
  if (!capability) {
    return {
      kind: 'unsupported',
      mimeType: normalizedMimeType || 'application/octet-stream',
      extension: getFileExtension(file.name),
      support: 'unsupported'
    }
  }

  const support = getMediaSupport(capability, platform)
  return {
    kind: support !== 'unsupported' ? capability.kind : 'unsupported',
    mimeType:
      capability.canonicalMimeType.endsWith('/*') && normalizedMimeType
        ? normalizedMimeType
        : capability.canonicalMimeType,
    extension: getFileExtension(file.name),
    support
  }
}

export function getMediaSupport(
  capability: MediaCapability,
  platform: MediaPlatform
): MediaSupportMode {
  return capability[platform]
}

export function canGenerateMediaThumbnail(capability: MediaCapability | null): boolean {
  return capability !== null && capability.thumbnail !== 'none'
}

function getSupportedExtensions(platform: MediaPlatform): string[] {
  return CAPABILITIES.filter(
    (capability) => getMediaSupport(capability, platform) !== 'unsupported'
  ).flatMap((capability) => capability.extensions.map((extension) => `.${extension}`))
}

export function getMediaFileAcceptAttribute(platform: MediaPlatform): string {
  return ['image/*', 'video/*', 'audio/*', ...new Set(getSupportedExtensions(platform))].join(',')
}

export function validateMediaCapabilityRegistry(): void {
  buildCapabilityIndexes()
}

export { CAPABILITIES as MEDIA_CAPABILITIES }
