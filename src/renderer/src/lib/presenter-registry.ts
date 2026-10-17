import type React from 'react'
import type { FileItemRecord } from '@shared/types/folder'
import { getMediaType, type MediaType, type MediaTypeStateMap } from './presentability'
import ImagePreview from '../components/Control/FileExplorer/Presenter/Preview/ImagePreview'
import VideoPreview from '../components/Control/FileExplorer/Presenter/Preview/VideoPreview'
import PdfPreview from '../components/Control/FileExplorer/Presenter/Preview/PdfPreview'
import PresentationPreview from '../components/Control/FileExplorer/Presenter/Preview/PresentationPreview'

export interface PreviewComponentProps {
  item: FileItemRecord
}

export interface MediaTypeDescriptor<K extends MediaType = MediaType> {
  type: K
  matches: (mimeType: string) => boolean
  supportsZoomPan: boolean
  clickToAdvance: boolean
  PreviewComponent: React.ComponentType<PreviewComponentProps>
  initialTypeState: MediaTypeStateMap[K]
}

const DESCRIPTORS: MediaTypeDescriptor[] = [
  {
    type: 'image',
    matches: (m) => getMediaType(m) === 'image',
    supportsZoomPan: true,
    clickToAdvance: true,
    PreviewComponent: ImagePreview,
    initialTypeState: {}
  },
  {
    type: 'video',
    matches: (m) => getMediaType(m) === 'video',
    supportsZoomPan: false,
    clickToAdvance: false,
    PreviewComponent: VideoPreview,
    initialTypeState: {}
  },
  {
    type: 'pdf',
    matches: (m) => getMediaType(m) === 'pdf',
    supportsZoomPan: true,
    clickToAdvance: false,
    PreviewComponent: PdfPreview,
    initialTypeState: { viewMode: 'slide' as const }
  },
  {
    type: 'presentation',
    matches: (m) => getMediaType(m) === 'presentation',
    supportsZoomPan: false,
    clickToAdvance: true,
    PreviewComponent: PresentationPreview,
    initialTypeState: { slideIndex: 0 }
  }
]

export function getDescriptor(mimeType: string): MediaTypeDescriptor | null {
  return DESCRIPTORS.find((d) => d.matches(mimeType)) ?? null
}
