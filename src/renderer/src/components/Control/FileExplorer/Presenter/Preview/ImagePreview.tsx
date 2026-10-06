import React, { useEffect, useState } from 'react'
import { toast } from '@heroui/react/toast'
import { useTranslation } from 'react-i18next'
import type { FileItemRecord } from '@shared/types/folder'
import { getFileSource, openFileExplorerDB } from '@renderer/lib/file-explorer-db'
import { getBlobId } from '@renderer/lib/blob-identity'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import PreviewLoadError from './PreviewLoadError'

interface ImagePreviewProps {
  item: FileItemRecord
}

export default function ImagePreview({ item }: ImagePreviewProps): React.JSX.Element {
  const { t } = useTranslation()
  const [imgSrc, setImgSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const blobId = getBlobId(item)

  const zoomLevel = useMediaProjectionStore((s) => s.zoomLevel)
  const pan = useMediaProjectionStore((s) => s.pan)
  const remoteSourceUrl = useMediaProjectionStore((s) => {
    const entry = s.snapshot?.entries.find((candidate) => candidate.itemId === item.id)
    if (!entry?.remoteItem) return undefined
    return entry.remoteSource ? entry.sourceUrl : null
  })

  useEffect(() => {
    let revokeSource: (() => void) | null = null
    let cancelled = false

    async function load(): Promise<void> {
      setLoading(true)
      setError(false)
      if (remoteSourceUrl !== undefined) {
        if (remoteSourceUrl) {
          setImgSrc(remoteSourceUrl)
          setLoading(false)
        }
        return
      }
      const db = await openFileExplorerDB()
      const source = await getFileSource(db, blobId, item.mimeType)
      if (cancelled) {
        source?.revoke()
        return
      }
      if (!source) {
        setError(true)
        setLoading(false)
        toast.warning(t('fileExplorer.blobLoadFailed'))
        return
      }
      revokeSource = source.revoke
      setImgSrc(source.url)
      setLoading(false)
    }

    void load().catch(() => {
      if (!cancelled) {
        setError(true)
        setLoading(false)
      }
    })

    return () => {
      cancelled = true
      revokeSource?.()
      setImgSrc(null)
    }
  }, [blobId, item.mimeType, remoteSourceUrl, retryToken, t])

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center text-white/50">
        {t('presenter.loading')}
      </div>
    )
  }

  if (error || !imgSrc) {
    return (
      <PreviewLoadError
        message={t('presenter.imageLoadFailed')}
        retryLabel={t('presenter.retryPreview', 'Retry preview')}
        onRetry={() => setRetryToken((value) => value + 1)}
      />
    )
  }

  if (zoomLevel > 1) {
    const viewportWidth = (1 / zoomLevel) * 100
    const viewportHeight = (1 / zoomLevel) * 100
    const viewportLeft = (0.5 - (0.5 - pan.x) / zoomLevel) * 100
    const viewportTop = (0.5 - (0.5 - pan.y) / zoomLevel) * 100

    return (
      <div className="w-full h-full overflow-hidden relative">
        <img
          src={imgSrc}
          onError={() => setError(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain'
          }}
          draggable={false}
          alt={item.name}
        />
        <div
          className="absolute border-2 border-accent bg-accent/20 pointer-events-none"
          style={{
            left: `${viewportLeft}%`,
            top: `${viewportTop}%`,
            width: `${viewportWidth}%`,
            height: `${viewportHeight}%`
          }}
        />
      </div>
    )
  }

  const transform = `scale(${zoomLevel}) translate(${(pan.x / zoomLevel) * 100}%, ${(pan.y / zoomLevel) * 100}%)`

  return (
    <div className="w-full h-full overflow-hidden">
      <img
        src={imgSrc}
        onError={() => setError(true)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          transform,
          transformOrigin: 'center center',
          transition: 'transform 0.15s ease',
          cursor: zoomLevel > 1 ? 'grab' : 'default'
        }}
        draggable={false}
        alt={item.name}
      />
    </div>
  )
}
