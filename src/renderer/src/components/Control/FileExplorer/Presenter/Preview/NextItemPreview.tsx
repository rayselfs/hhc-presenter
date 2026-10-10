import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentLoadingTask } from 'pdfjs-dist'
import { useTranslation } from 'react-i18next'
import type { FileItemRecord } from '@shared/types/folder'
import { getMediaType } from '@renderer/lib/presentability'
import { resolveMediaCapability } from '@renderer/lib/media-capabilities'
import { getBlobId } from '@renderer/lib/blob-identity'
import { getFileSource, openFileExplorerDB } from '@renderer/lib/file-explorer-db'
import { loadPdfjsLib } from '@renderer/lib/pdfjs-loader'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'
import PresentationPreview from './PresentationPreview'

interface NextItemPreviewProps {
  item: FileItemRecord
  slideIndex?: number
  previewCache?: Record<string, string | null>
}

export default function NextItemPreview({
  item,
  slideIndex,
  previewCache
}: NextItemPreviewProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const mediaType = getMediaType(item.mimeType)
  const thumbnailUrl = previewCache?.[item.id] ?? null
  const blobId = getBlobId(item)
  const remoteSourceUrl = useMediaProjectionStore((s) => {
    const entry = s.snapshot?.entries.find((candidate) => candidate.itemId === item.id)
    if (!entry?.remoteItem) return undefined
    return entry.remoteSource ? entry.sourceUrl : null
  })
  const sourceKey = `${item.id}:${blobId}:${item.mimeType}:${remoteSourceUrl}`
  const [source, setSource] = useState<{ key: string; url: string } | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const capability = resolveMediaCapability({ mimeType: item.mimeType })
  const nativeVideo = capability?.kind === 'video' && capability.web === 'native'
  const handleError = useCallback(() => setFailedKey(sourceKey), [sourceKey])

  useEffect(() => {
    if (remoteSourceUrl === null || !mediaType || mediaType === 'presentation') return
    if (mediaType === 'video' && !nativeVideo) return
    let cancelled = false
    let revoke: (() => void) | undefined
    async function load(): Promise<void> {
      try {
        const loaded = remoteSourceUrl
          ? { url: remoteSourceUrl, revoke: (): void => undefined }
          : await getFileSource(await openFileExplorerDB(), blobId, item.mimeType)
        if (cancelled) {
          loaded?.revoke()
          return
        }
        if (!loaded) return
        revoke = loaded.revoke
        setSource({ key: sourceKey, url: loaded.url })
      } catch {
        // Keep the existing cover when the original source is unavailable.
      }
    }
    void load()
    return () => {
      cancelled = true
      revoke?.()
    }
  }, [blobId, item.mimeType, mediaType, nativeVideo, remoteSourceUrl, sourceKey])

  if (!mediaType) return null
  const fallback = thumbnailUrl ? (
    <img
      src={thumbnailUrl}
      alt={item.name}
      className="absolute inset-0 w-full h-full object-contain"
    />
  ) : (
    <span className="absolute inset-0 flex items-center justify-center text-white/30 text-xs">
      {item.name || t('presenter.loading')}
    </span>
  )

  if (mediaType === 'presentation')
    return failedKey === sourceKey ? (
      fallback
    ) : (
      <PresentationPreview
        item={item}
        previewOnly
        previewSlideIndex={slideIndex}
        onError={handleError}
      />
    )
  const sourceUrl = source?.key === sourceKey && failedKey !== sourceKey ? source.url : null
  if (!sourceUrl) return fallback
  if (mediaType === 'pdf')
    return <NextPdfPreview key={sourceUrl} url={sourceUrl} name={item.name} fallback={fallback} />
  if (nativeVideo) {
    return (
      <NextVideoPreview key={sourceUrl} url={sourceUrl} name={item.name} onError={handleError} />
    )
  }
  return (
    <img
      src={sourceUrl}
      alt={item.name}
      className="absolute inset-0 w-full h-full object-contain"
      onError={handleError}
    />
  )
}

function NextVideoPreview({
  url,
  name,
  onError
}: {
  url: string
  name: string
  onError: () => void
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = videoRef.current
    if (video) video.src = url
    return () => {
      video?.pause()
      video?.removeAttribute('src')
      video?.load()
    }
  }, [url])
  return (
    <video
      ref={videoRef}
      src={url}
      aria-label={name}
      muted
      playsInline
      preload="metadata"
      className="absolute inset-0 w-full h-full object-contain"
      onError={onError}
      onLoadedMetadata={(event) => {
        const video = event.currentTarget
        video.currentTime = Math.min(0.1, Number.isFinite(video.duration) ? video.duration : 0.1)
      }}
    />
  )
}

function NextPdfPreview({
  url,
  name,
  fallback
}: {
  url: string
  name: string
  fallback: React.ReactNode
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    let task: PDFDocumentLoadingTask | undefined
    async function render(): Promise<void> {
      try {
        const pdfjs = await loadPdfjsLib()
        if (cancelled) return
        task = pdfjs.getDocument({ url })
        const pdf = await task.promise
        if (cancelled) return
        const page = await pdf.getPage(1)
        const canvas = canvasRef.current
        if (cancelled || !canvas) return
        const original = page.getViewport({ scale: 1 })
        // ponytail: cap sidebar previews at 1280px; use panel/DPR sizing for larger previews.
        const viewport = page.getViewport({
          scale: 1280 / Math.max(original.width, original.height)
        })
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d')
        if (!context) return
        await page.render({ canvas, canvasContext: context, viewport }).promise
        if (!cancelled) setReady(true)
      } catch {
        // Keep the cover if PDF loading or rendering fails.
      }
    }
    void render()
    return () => {
      cancelled = true
      void task?.destroy()
    }
  }, [url])
  return (
    <>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={name}
        className={`absolute inset-0 w-full h-full object-contain ${ready ? '' : 'invisible'}`}
      />
      {!ready && fallback}
    </>
  )
}
