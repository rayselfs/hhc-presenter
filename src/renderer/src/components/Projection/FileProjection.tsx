import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createProjectionAdapter } from '@renderer/lib/projection-adapter'
import { getFileSource, openFileExplorerDB } from '@renderer/lib/file-explorer-db'
import { loadPresentationFont } from '@renderer/lib/font-loader'
import type {
  FileControlPayload,
  ProjectionMediaReplayState,
  ProjectionPayload
} from '@shared/projection-messages'
import PptxSlideSurface from '@renderer/components/Common/PptxSlideSurface'
import EditableSlideSurface from '@renderer/components/Common/EditableSlideSurface'
import {
  loadEditablePresentation,
  type EditablePresentationDocument
} from '@renderer/lib/editable-presentation'
import {
  isEditablePresentationMimeType,
  isPresentationMimeType
} from '@renderer/lib/presentation-media'
import {
  useProjectionPdfOwner,
  getPdfPageHeight,
  PDF_CONTINUOUS_PAGE_GAP
} from '@renderer/hooks/useProjectionPdfOwner'

type FileProjectionProps = {
  generation?: number
  projectionSessionId?: string
  initialReplayState?: ProjectionMediaReplayState | null
  fileName?: string
  initialItemId?: string
  initialBlobId?: string
  initialMimeType?: string
  initialStreamUrl?: string
  initialContentRevision?: number
  initialPlaybackMode?: 'native' | 'vlc-embedded'
  initialPlaybackVariant?: 'source' | 'matroska-remux'
  vlcStartRevision?: number
  initialSeekable?: boolean
  initialDurationMs?: number
  initialPdf?: ProjectionPayload<'file:show'>['pdf']
  initialPresentation?: {
    slideIndex: number
    slideCount?: number
  }
  initialEditablePresentation?: ProjectionPayload<'file:show'>['editablePresentation']
  controlEvent?: { id: number; data: FileControlPayload } | null
}

type LoadFileOptions = {
  streamUrl?: string
  playbackMode?: 'native' | 'vlc-embedded'
  seekable?: boolean
  durationMs?: number
}

type PendingVideoControl = {
  itemId: string | null
  seekTo?: number
  shouldPlay?: boolean
  volume?: number
  playbackRate?: number
}

const HAVE_METADATA = 1
export { PDF_CONTINUOUS_CANVAS_RADIUS } from '@renderer/hooks/useProjectionPdfOwner'

export default function FileProjection({
  generation = 0,
  projectionSessionId,
  initialReplayState,
  fileName,
  initialItemId,
  initialBlobId,
  initialMimeType,
  initialStreamUrl,
  initialContentRevision,
  initialPlaybackMode,
  initialPlaybackVariant,
  vlcStartRevision,
  initialSeekable,
  initialDurationMs,
  initialPdf,
  initialPresentation,
  initialEditablePresentation,
  controlEvent
}: FileProjectionProps): React.JSX.Element {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [loadedContentRevision, setLoadedContentRevision] = useState<number | undefined>()
  const [mimeType, setMimeType] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const replayPlaylistEnded =
    initialReplayState?.itemId === initialItemId && initialReplayState?.playlistEnded === true
  const [isEnded, setIsEnded] = useState(replayPlaylistEnded)
  const [displayName, setDisplayName] = useState(fileName ?? '')
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const adapterSendRef = useRef<ReturnType<typeof createProjectionAdapter>['send'] | null>(null)
  const currentItemIdRef = useRef<string | null>(null)
  const currentBlobIdRef = useRef<string | null>(null)
  const imageReadyRef = useRef(false)
  const objectUrlRef = useRef(objectUrl)
  objectUrlRef.current = objectUrl
  const retainedSurfaceSequenceRef = useRef<number | null>(null)
  const cancelPendingImageRef = useRef<(() => void) | null>(null)
  const reportedErrorSequenceRef = useRef(0)
  const [playbackError, setPlaybackError] = useState(false)
  const sourceRevokeRef = useRef<(() => void) | null>(null)
  const pendingVideoControlRef = useRef<PendingVideoControl | null>(null)
  const seekableRef = useRef(true)
  const playbackModeRef = useRef<FileProjectionProps['initialPlaybackMode']>('native')
  const durationMsRef = useRef<number | undefined>(initialDurationMs)
  const loadSequenceRef = useRef(0)
  const endedRef = useRef(false)
  const initialPdfRef = useRef(initialPdf)
  initialPdfRef.current = initialPdf
  const [documentFailed, setDocumentFailed] = useState(false)
  const renderIdentityRef = useRef({
    itemId: initialItemId,
    blobId: initialBlobId,
    contentRevision: initialContentRevision
  })
  renderIdentityRef.current = {
    itemId: initialItemId,
    blobId: initialBlobId,
    contentRevision: initialContentRevision
  }
  const reportRenderStatus = useCallback(
    (
      status: 'ready' | 'failed',
      sequence = loadSequenceRef.current,
      reason: ProjectionPayload<'file:render-status'>['reason'] = 'render-failed'
    ): void => {
      if (sequence !== loadSequenceRef.current || endedRef.current) return
      if (status === 'ready' && retainedSurfaceSequenceRef.current === sequence) return
      const { itemId, blobId, contentRevision } = renderIdentityRef.current
      if (status === 'failed' && retainedSurfaceSequenceRef.current !== sequence)
        setDocumentFailed(true)
      if (!itemId || !blobId || !contentRevision) return
      adapterSendRef.current?.('file:render-status', {
        itemId,
        blobId,
        contentRevision,
        status,
        ...(status === 'failed' ? { reason } : {})
      })
    },
    []
  )
  const reportPresentationReady = useCallback(
    () => reportRenderStatus('ready'),
    [reportRenderStatus]
  )
  const reportPresentationFailure = useCallback(
    () => reportRenderStatus('failed'),
    [reportRenderStatus]
  )
  const replayStateRef = useRef(initialReplayState)
  replayStateRef.current = initialReplayState

  const isControlForCurrentItem = useCallback((data: FileControlPayload): boolean => {
    if (!('itemId' in data) || data.itemId === undefined) return true
    return data.itemId === currentItemIdRef.current
  }, [])

  const clampVideoTime = useCallback((video: HTMLMediaElement, value: number): number => {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : value
    return Math.max(0, Math.min(value, duration))
  }, [])

  const applyPendingVideoControl = useCallback((): void => {
    const pending = pendingVideoControlRef.current
    const video = mediaRef.current
    if (!pending || !video) return
    if (pending.itemId && pending.itemId !== currentItemIdRef.current) {
      pendingVideoControlRef.current = null
      return
    }

    if (pending.volume !== undefined) {
      video.muted = false
      video.volume = Math.max(0, Math.min(1, pending.volume))
      delete pending.volume
    }

    if (pending.playbackRate !== undefined) {
      video.playbackRate = pending.playbackRate
      delete pending.playbackRate
    }

    if (pending.seekTo !== undefined) {
      if (!seekableRef.current) {
        delete pending.seekTo
      } else {
        if (video.readyState < HAVE_METADATA) return
        try {
          video.currentTime = clampVideoTime(video, pending.seekTo)
          delete pending.seekTo
        } catch {
          return
        }
      }
    }

    if (pending.shouldPlay !== undefined) {
      if (pending.shouldPlay) {
        const mustApplySeekBeforePlay = pending.seekTo !== undefined && seekableRef.current
        if (mustApplySeekBeforePlay && video.readyState < HAVE_METADATA) return
        video.muted = false
        video.play().catch((error) => {
          console.error('[file-projection] Video play failed', error)
        })
      } else {
        video.pause()
      }
      delete pending.shouldPlay
    }

    if (
      pending.seekTo === undefined &&
      pending.shouldPlay === undefined &&
      pending.volume === undefined &&
      pending.playbackRate === undefined
    ) {
      pendingVideoControlRef.current = null
    }
  }, [clampVideoTime])

  const queueVideoControl = useCallback(
    (data: FileControlPayload, control: Omit<PendingVideoControl, 'itemId'>): void => {
      if (!isControlForCurrentItem(data)) return
      const itemId =
        'itemId' in data && data.itemId !== undefined ? data.itemId : currentItemIdRef.current
      pendingVideoControlRef.current = {
        ...(pendingVideoControlRef.current ?? {}),
        itemId,
        ...control
      }
      applyPendingVideoControl()
    },
    [applyPendingVideoControl, isControlForCurrentItem]
  )

  const isCurrentPdfSource = useCallback(
    (itemId: string, sequence: number): boolean =>
      loadSequenceRef.current === sequence &&
      currentItemIdRef.current === itemId &&
      !endedRef.current,
    []
  )
  const onPdfInstalled = useCallback((): void => {
    retainedSurfaceSequenceRef.current = null
  }, [])
  const {
    pdfState,
    pdfPreviewUrls,
    pdfContainerRef,
    pdfContainerWidth,
    pdfPageCount,
    pdfWindowCenter,
    pdfWindowStart,
    pdfWindowEnd,
    disposePdf,
    cancelPendingPdfLoad,
    hasPdfDocument,
    loadPdf,
    loadPdfPreviews,
    preparePdf,
    getPdfPosition,
    resetPdfSurface,
    setPdfPage,
    setPdfScroll,
    setPdfViewMode,
    applyPdfReplay
  } = useProjectionPdfOwner({
    isCurrentSource: isCurrentPdfSource,
    onInstalled: onPdfInstalled,
    reportRenderStatus
  })

  const sendVideoPlaybackState = useCallback(
    (next?: { isPlaying?: boolean; isEnded?: boolean }): void => {
      const video = mediaRef.current
      const itemId = currentItemIdRef.current
      const send = adapterSendRef.current
      if (!video || !itemId || !send) return
      const metadataDuration =
        durationMsRef.current !== undefined && durationMsRef.current > 0
          ? durationMsRef.current / 1000
          : undefined
      const duration =
        metadataDuration ??
        (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0)
      send('file:playback-state', {
        itemId,
        phase:
          (next?.isEnded ?? video.ended)
            ? 'ended'
            : (next?.isPlaying ?? !video.paused)
              ? 'playing'
              : video.currentTime > 0
                ? 'paused'
                : 'ready',
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        duration,
        isPlaying: next?.isPlaying ?? !video.paused,
        isEnded: next?.isEnded ?? video.ended,
        playbackRate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
        seekable: seekableRef.current,
        volume: Number.isFinite(video.volume) ? video.volume : 1
      })
    },
    []
  )

  const endPlaylist = useCallback(() => {
    endedRef.current = true
    loadSequenceRef.current += 1
    cancelPendingImageRef.current?.()
    cancelPendingImageRef.current = null
    pendingVideoControlRef.current = null
    sourceRevokeRef.current?.()
    sourceRevokeRef.current = null
    disposePdf()
    setObjectUrl(null)
    setIsEnded(true)
  }, [disposePdf])

  const loadFile = useCallback(
    async (itemId: string, blobId: string, fileMimeType: string, options: LoadFileOptions = {}) => {
      const replay = replayStateRef.current?.itemId === itemId ? replayStateRef.current : null
      if (replay?.playlistEnded) {
        endPlaylist()
        return
      }
      const loadSequence = loadSequenceRef.current + 1
      loadSequenceRef.current = loadSequence
      cancelPendingImageRef.current?.()
      cancelPendingImageRef.current = null
      cancelPendingPdfLoad()
      const retainSurface =
        currentItemIdRef.current === itemId &&
        currentBlobIdRef.current === blobId &&
        !endedRef.current &&
        ((fileMimeType.startsWith('image/') &&
          objectUrlRef.current !== null &&
          imageReadyRef.current) ||
          (fileMimeType === 'application/pdf' && hasPdfDocument()))
      retainedSurfaceSequenceRef.current = retainSurface ? loadSequence : null
      setPlaybackError(false)
      setDocumentFailed(false)
      endedRef.current = false
      const previousPlaybackMode = playbackModeRef.current
      const nextPlaybackMode = options.playbackMode ?? 'native'
      const liveVideo = currentItemIdRef.current === itemId ? mediaRef.current : null
      currentItemIdRef.current = itemId
      currentBlobIdRef.current = blobId
      playbackModeRef.current = nextPlaybackMode
      seekableRef.current = options.seekable !== false
      durationMsRef.current = options.durationMs
      if (previousPlaybackMode === 'vlc-embedded' && nextPlaybackMode !== 'vlc-embedded') {
        await window.api?.projectionVlc?.stop({ force: true }).catch((error) => {
          console.error('[file-projection] Failed to stop VLC before loading next item', error)
        })
        if (loadSequenceRef.current !== loadSequence) return
      }
      const videoReplay =
        replay ??
        (liveVideo
          ? {
              positionSeconds: Number.isFinite(liveVideo.currentTime) ? liveVideo.currentTime : 0,
              isPlaying: !liveVideo.paused,
              isEnded: liveVideo.ended,
              volume: liveVideo.volume,
              playbackRate: liveVideo.playbackRate
            }
          : null)
      pendingVideoControlRef.current = videoReplay
        ? {
            itemId,
            seekTo: videoReplay.positionSeconds,
            shouldPlay: videoReplay.isPlaying && !videoReplay.isEnded,
            volume: videoReplay.volume,
            playbackRate: videoReplay.playbackRate ?? 1
          }
        : null
      preparePdf({
        page: replay?.pdfPage ?? initialPdfRef.current?.page ?? 1,
        scroll: replay?.pdfScroll ?? initialPdfRef.current?.scroll ?? 0,
        viewMode: replay?.pdfViewMode ?? initialPdfRef.current?.viewMode ?? 'single'
      })
      if (!retainSurface) {
        imageReadyRef.current = false
        sourceRevokeRef.current?.()
        sourceRevokeRef.current = null
        disposePdf()
        setObjectUrl(null)
        resetPdfSurface()
        setZoom(replay?.zoom ?? 1)
        setPan(replay ? { ...replay.pan } : { x: 0, y: 0 })
      }
      setIsEnded(false)
      setMimeType(fileMimeType)
      if (fileMimeType === 'application/pdf') {
        void loadPdfPreviews(blobId, itemId, loadSequence).catch((error) => {
          console.warn('[file-projection] PDF previews unavailable', error)
        })
      }
      if (options.playbackMode === 'vlc-embedded') {
        return
      }
      if (isPresentationMimeType(fileMimeType)) return
      let source: { url: string; revoke: () => void } | null
      try {
        source = options.streamUrl
          ? { url: options.streamUrl, revoke: (): void => undefined }
          : await getFileSource(await openFileExplorerDB(), blobId, fileMimeType, {
              verifyNativeFile: false
            })
      } catch {
        reportRenderStatus('failed', loadSequence, 'source-unavailable')
        return
      }
      if (
        !source ||
        loadSequenceRef.current !== loadSequence ||
        currentItemIdRef.current !== itemId
      ) {
        source?.revoke()
        if (!source) reportRenderStatus('failed', loadSequence, 'source-unavailable')
        return
      }
      let installed = false
      try {
        if (fileMimeType === 'application/pdf') {
          installed = await loadPdf(source.url, itemId, loadSequence, retainSurface)
        } else {
          if (retainSurface && fileMimeType.startsWith('image/')) {
            await new Promise<void>((resolve, reject) => {
              const image = new Image()
              const clear = (): void => {
                image.onload = null
                image.onerror = null
              }
              const cancel = (): void => {
                clear()
                image.src = ''
                reject(new Error('Image load cancelled'))
              }
              cancelPendingImageRef.current = cancel
              image.onload = () => {
                clear()
                if (cancelPendingImageRef.current === cancel) cancelPendingImageRef.current = null
                resolve()
              }
              image.onerror = () => {
                clear()
                if (cancelPendingImageRef.current === cancel) cancelPendingImageRef.current = null
                reject(new Error('Image decode failed'))
              }
              image.src = source.url
            })
          }
          if (loadSequenceRef.current !== loadSequence || endedRef.current) return
          retainedSurfaceSequenceRef.current = null
          setLoadedContentRevision(initialContentRevision)
          setObjectUrl(source.url)
          installed = true
        }
        if (installed) {
          sourceRevokeRef.current?.()
          sourceRevokeRef.current = source.revoke
        }
      } finally {
        if (!installed) source.revoke()
      }
    },
    [
      endPlaylist,
      disposePdf,
      initialContentRevision,
      loadPdf,
      loadPdfPreviews,
      reportRenderStatus,
      cancelPendingPdfLoad,
      hasPdfDocument,
      preparePdf,
      resetPdfSurface
    ]
  )

  const handleControl = useCallback(
    (data: FileControlPayload) => {
      if (endedRef.current || !isControlForCurrentItem(data)) return
      switch (data.action) {
        case 'play':
          if (playbackModeRef.current === 'vlc-embedded') {
            void window.api?.projectionVlc?.control({ action: 'play', itemId: data.itemId })
            break
          }
          queueVideoControl(data, { shouldPlay: true })
          break
        case 'pause':
          if (playbackModeRef.current === 'vlc-embedded') {
            void window.api?.projectionVlc?.control({ action: 'pause', itemId: data.itemId })
            break
          }
          queueVideoControl(data, { shouldPlay: false })
          break
        case 'seek':
          if (playbackModeRef.current === 'vlc-embedded') {
            void window.api?.projectionVlc?.control({
              action: 'seek',
              itemId: data.itemId,
              value: data.value
            })
            break
          }
          if (!seekableRef.current) break
          queueVideoControl(data, { seekTo: data.value })
          break
        case 'zoom':
          setZoom(data.value)
          if (data.value <= 1) setPan({ x: 0, y: 0 })
          break
        case 'pan':
          setPan(data.value)
          break
        case 'pdfPage':
          setPdfPage(data.value)
          break
        case 'pdfScroll':
          setPdfScroll(data.value)
          break
        case 'pdfViewMode':
          setPdfViewMode(data.value)
          break
        case 'volume':
          if (playbackModeRef.current === 'vlc-embedded') {
            void window.api?.projectionVlc?.control({
              action: 'volume',
              itemId: data.itemId,
              value: data.value
            })
            break
          }
          queueVideoControl(data, { volume: data.value })
          break
      }
    },
    [queueVideoControl, isControlForCurrentItem, setPdfPage, setPdfScroll, setPdfViewMode]
  )

  useEffect(() => {
    const adapter = createProjectionAdapter('projection', projectionSessionId)
    adapter.setGeneration(generation)
    adapterSendRef.current = adapter.send.bind(adapter)

    const unsubEnd = adapter.on('file:end', endPlaylist)

    return () => {
      unsubEnd()
      adapter.dispose()
      adapterSendRef.current = null
    }
  }, [generation, projectionSessionId, endPlaylist])

  useEffect(() => {
    if (initialItemId && initialBlobId && initialMimeType) {
      setDisplayName(fileName ?? '')
      const loading = loadFile(initialItemId, initialBlobId, initialMimeType, {
        streamUrl: initialStreamUrl,
        playbackMode: initialPlaybackMode,
        seekable: initialSeekable,
        durationMs: initialDurationMs
      })
      const sequence = loadSequenceRef.current
      void loading.catch((error: unknown) =>
        reportRenderStatus(
          'failed',
          sequence,
          ['MissingPDFException', 'UnexpectedResponseException'].includes(
            (error as { name?: string })?.name ?? ''
          )
            ? 'source-unavailable'
            : 'decode-failed'
        )
      )
    }
  }, [
    fileName,
    initialBlobId,
    initialItemId,
    initialMimeType,
    initialPlaybackMode,
    initialContentRevision,
    replayPlaylistEnded,
    initialSeekable,
    initialDurationMs,
    initialStreamUrl,
    loadFile,
    reportRenderStatus
  ])

  useEffect(() => {
    if (!initialPdf || endedRef.current) return
    const replay = initialReplayState?.itemId === initialItemId ? initialReplayState : null
    const desired = replay
      ? { page: replay.pdfPage, scroll: replay.pdfScroll, viewMode: replay.pdfViewMode }
      : initialPdf
    applyPdfReplay(desired)
  }, [initialItemId, initialPdf, initialReplayState, applyPdfReplay])

  useEffect(() => {
    if (controlEvent) handleControl(controlEvent.data)
  }, [controlEvent, handleControl])

  useEffect(
    () => () => {
      loadSequenceRef.current += 1
      cancelPendingImageRef.current?.()
      cancelPendingImageRef.current = null
      sourceRevokeRef.current?.()
      sourceRevokeRef.current = null
      disposePdf()
      void window.api?.projectionVlc?.stop({ force: true })
    },
    [disposePdf]
  )

  const transform =
    zoom !== 1
      ? `scale(${zoom}) translate(${(pan.x / zoom) * 100}%, ${(pan.y / zoom) * 100}%)`
      : undefined

  const imageTransform =
    zoom !== 1
      ? `scale(${zoom}) translate(${(-pan.x / zoom) * 100}%, ${(-pan.y / zoom) * 100}%)`
      : undefined

  const renderedLoadSequence = loadSequenceRef.current

  if (isEnded || replayPlaylistEnded) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black">
        <span className="text-white/10 text-4xl font-bold tracking-widest">投影結束</span>
      </div>
    )
  }

  if (documentFailed) return <div className="h-screen w-screen bg-black" />

  if (pdfState) {
    if (pdfState.viewMode === 'continuous') {
      const fallbackSize = pdfState.pageSizes.find((size) => size !== undefined)
      const getPageHeight = (index: number): number =>
        getPdfPageHeight(pdfState.pageSizes[index] ?? fallbackSize, pdfContainerWidth)
      const omittedBefore = pdfWindowStart - 1
      const omittedAfter = pdfPageCount - pdfWindowEnd
      let topSpacerHeight = Math.max(0, omittedBefore - 1) * PDF_CONTINUOUS_PAGE_GAP
      for (let index = 0; index < omittedBefore; index++) {
        topSpacerHeight += getPageHeight(index)
      }
      let bottomSpacerHeight = Math.max(0, omittedAfter - 1) * PDF_CONTINUOUS_PAGE_GAP
      for (let index = pdfWindowEnd; index < pdfPageCount; index++) {
        bottomSpacerHeight += getPageHeight(index)
      }

      return (
        <div className="flex h-screen w-screen bg-black overflow-hidden">
          <div
            ref={pdfContainerRef}
            className="w-full h-full overflow-y-auto flex flex-col items-center gap-4 py-4"
          >
            {omittedBefore > 0 && (
              <div
                data-pdf-spacer="top"
                className="w-full shrink-0"
                style={{ height: topSpacerHeight }}
                aria-hidden
              />
            )}
            {Array.from({ length: pdfWindowEnd - pdfWindowStart + 1 }, (_, index) => {
              const pageNumber = pdfWindowStart + index
              return (
                <PdfCanvas
                  key={pageNumber}
                  canvas={pdfState.pages[pageNumber - 1]}
                  size={pdfState.pageSizes[pageNumber - 1]}
                  previewUrl={pdfPreviewUrls[pageNumber - 1]}
                  pageNumber={pageNumber}
                  continuous
                />
              )
            })}
            {omittedAfter > 0 && (
              <div
                data-pdf-spacer="bottom"
                className="w-full shrink-0"
                style={{ height: bottomSpacerHeight }}
                aria-hidden
              />
            )}
          </div>
        </div>
      )
    }

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black overflow-hidden">
        <div
          ref={pdfContainerRef}
          className="flex flex-col items-center overflow-hidden w-full h-full"
          style={{ transform, transformOrigin: 'center center' }}
        >
          <PdfCanvas
            canvas={pdfState.pages[pdfWindowCenter - 1]}
            size={pdfState.pageSizes[pdfWindowCenter - 1]}
            previewUrl={pdfPreviewUrls[pdfWindowCenter - 1]}
            pageNumber={pdfWindowCenter}
          />
        </div>
      </div>
    )
  }

  if (mimeType === 'application/pdf' && pdfPreviewUrls.length > 0) {
    const replayPage = getPdfPosition().page
    const pageNumber = Math.min(pdfPreviewUrls.length, Math.max(1, Math.floor(replayPage)))
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black overflow-hidden">
        <img
          data-pdf-preview={pageNumber}
          src={pdfPreviewUrls[pageNumber - 1]}
          alt={displayName}
          className="h-full w-full object-contain"
        />
      </div>
    )
  }

  if (mimeType?.startsWith('image/') && objectUrl) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black overflow-hidden">
        <img
          key={`${initialItemId}:${loadedContentRevision}`}
          src={objectUrl}
          onLoad={() => {
            imageReadyRef.current = true
            if (loadedContentRevision === initialContentRevision)
              reportRenderStatus('ready', renderedLoadSequence)
          }}
          onError={() => {
            imageReadyRef.current = false
            if (loadedContentRevision === initialContentRevision)
              reportRenderStatus('failed', renderedLoadSequence, 'decode-failed')
          }}
          alt={displayName}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            transform: imageTransform,
            transformOrigin: 'center center'
          }}
        />
      </div>
    )
  }

  if (mimeType?.startsWith('video/') && objectUrl) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black overflow-hidden">
        <video
          key={`${loadedContentRevision ?? 0}:${renderedLoadSequence}`}
          onError={(event) => {
            const video = event.currentTarget
            const errorCode = video.error?.code
            if (
              loadedContentRevision !== initialContentRevision ||
              video !== mediaRef.current ||
              renderedLoadSequence !== loadSequenceRef.current ||
              reportedErrorSequenceRef.current === renderedLoadSequence ||
              (errorCode !== 3 && errorCode !== 4) ||
              !initialItemId ||
              !initialBlobId ||
              !initialContentRevision ||
              playbackModeRef.current === 'vlc-embedded'
            )
              return
            reportedErrorSequenceRef.current = renderedLoadSequence
            setPlaybackError(true)
            adapterSendRef.current?.('file:playback-error', {
              itemId: initialItemId,
              blobId: initialBlobId,
              contentRevision: initialContentRevision,
              errorCode,
              currentTime: Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0,
              duration: Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0,
              transport: video.paused ? 'pause' : 'play',
              volume: video.volume
            })
          }}
          ref={mediaRef as React.RefObject<HTMLVideoElement>}
          src={objectUrl}
          preload={seekableRef.current ? 'metadata' : 'none'}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            transform,
            transformOrigin: 'center center'
          }}
          muted
          onLoadedMetadata={() => {
            sendVideoPlaybackState()
            applyPendingVideoControl()
          }}
          onCanPlay={() => {
            sendVideoPlaybackState()
            applyPendingVideoControl()
          }}
          onTimeUpdate={() => sendVideoPlaybackState()}
          onPlay={() => sendVideoPlaybackState({ isPlaying: true, isEnded: false })}
          onPause={() => sendVideoPlaybackState({ isPlaying: false })}
          onEnded={() => sendVideoPlaybackState({ isPlaying: false, isEnded: true })}
        />
        {playbackError && (
          <p role="alert" className="absolute text-white">
            Video playback failed. Check the operator window for recovery.
          </p>
        )}
      </div>
    )
  }

  if (mimeType?.startsWith('audio/') && objectUrl) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black overflow-hidden">
        <audio
          ref={mediaRef as React.RefObject<HTMLAudioElement>}
          src={objectUrl}
          preload={seekableRef.current ? 'metadata' : 'none'}
          onLoadedMetadata={() => {
            sendVideoPlaybackState()
            applyPendingVideoControl()
          }}
          onCanPlay={() => {
            sendVideoPlaybackState()
            applyPendingVideoControl()
          }}
          onTimeUpdate={() => sendVideoPlaybackState()}
          onPlay={() => sendVideoPlaybackState({ isPlaying: true, isEnded: false })}
          onPause={() => sendVideoPlaybackState({ isPlaying: false })}
          onEnded={() => sendVideoPlaybackState({ isPlaying: false, isEnded: true })}
        />
      </div>
    )
  }

  if (initialMimeType?.startsWith('video/') && initialPlaybackMode === 'vlc-embedded') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black overflow-hidden">
        <VlcProjectionSurface
          itemId={initialItemId ?? null}
          blobId={initialBlobId}
          durationMs={durationMsRef.current}
          replayState={initialReplayState}
          playbackVariant={initialPlaybackVariant}
          startRevision={vlcStartRevision}
        />
      </div>
    )
  }

  if (isEditablePresentationMimeType(mimeType ?? undefined) && initialItemId && initialBlobId) {
    return (
      <EditableProjectionSurface
        key={`${initialItemId}:${initialBlobId}:${initialContentRevision}`}
        itemId={initialItemId}
        blobId={initialBlobId}
        fileName={displayName}
        slideIndex={initialPresentation?.slideIndex ?? 0}
        editablePresentation={initialEditablePresentation}
        onReady={reportPresentationReady}
        onError={reportPresentationFailure}
      />
    )
  }

  if (isPresentationMimeType(mimeType ?? undefined) && initialItemId && initialBlobId) {
    const presentationMimeType =
      mimeType ?? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    return (
      <div className="flex h-screen w-screen items-center justify-center overflow-hidden bg-black">
        <div className="h-full w-full">
          <PptxSlideSurface
            renderRevision={initialContentRevision}
            source={{
              id: initialItemId,
              url: initialStreamUrl ?? `blob:${initialBlobId}`,
              mimeType: presentationMimeType
            }}
            slideIndex={initialPresentation?.slideIndex ?? 0}
            verifyNativeFile={false}
            onReady={reportPresentationReady}
            onError={reportPresentationFailure}
          />
        </div>
      </div>
    )
  }

  return <div className="h-screen w-screen bg-black" />
}

function EditableProjectionSurface({
  itemId,
  blobId,
  fileName,
  slideIndex,
  editablePresentation,
  onReady,
  onError
}: {
  onReady: () => void
  onError: () => void
  itemId: string
  blobId: string
  fileName: string
  slideIndex: number
  editablePresentation?: ProjectionPayload<'file:show'>['editablePresentation']
}): React.JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null)
  const payloadDocument = useMemo(
    () =>
      editablePresentation
        ? {
            id: itemId,
            name: fileName,
            width: editablePresentation.width,
            height: editablePresentation.height,
            slideOrder: [editablePresentation.slide.id],
            slides: { [editablePresentation.slide.id]: editablePresentation.slide },
            assets: editablePresentation.assets,
            createdAt: 0,
            updatedAt: 0
          }
        : null,
    [editablePresentation, fileName, itemId]
  )
  const sourceKey = `${itemId}:${blobId}`
  const [loaded, setLoaded] = useState<{
    sourceKey: string
    document: EditablePresentationDocument | null
    error: string | null
  } | null>(null)

  useEffect(() => {
    if (payloadDocument) return
    let cancelled = false
    void loadEditablePresentation({ id: itemId, url: `blob:${blobId}`, name: fileName })
      .then((loadedDocument) => {
        if (!cancelled) {
          setLoaded({ sourceKey, document: loadedDocument, error: null })
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setLoaded({
            sourceKey,
            document: null,
            error: loadError instanceof Error ? loadError.message : String(loadError)
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [blobId, fileName, itemId, payloadDocument, sourceKey])

  const durableDocument = loaded?.sourceKey === sourceKey ? loaded.document : null
  const document = payloadDocument ?? durableDocument
  const error = payloadDocument || loaded?.sourceKey !== sourceKey ? null : loaded.error

  const slideId =
    document?.slideOrder[Math.min(slideIndex, Math.max(0, document.slideOrder.length - 1))]

  useEffect(() => {
    if (error) {
      onError()
      return
    }
    if (!document || !slideId || !frameRef.current) return
    let cancelled = false
    const frame = frameRef.current
    const slide = document.slides[slideId]
    const assets = document.assets
    async function prepare(): Promise<void> {
      const fonts = new Set<string>()
      for (const id of slide.elementOrder) {
        const element = slide.elements[id]
        if (element.type === 'image' && !assets[element.assetId]?.dataUrl) {
          throw new Error('Missing presentation image')
        }
        if (element.type === 'text') {
          fonts.add(element.fontFamily)
          for (const paragraph of element.paragraphs ?? []) {
            for (const run of paragraph.runs) fonts.add(run.fontFamily)
          }
        }
      }
      await Promise.all([
        ...Array.from(fonts, loadPresentationFont),
        ...Array.from(frame.querySelectorAll('img'), (image) => image.decode())
      ])
      await globalThis.document.fonts?.ready
      if (!cancelled) onReady()
    }
    void prepare().catch(() => {
      if (!cancelled) onError()
    })
    return () => {
      cancelled = true
    }
  }, [document, error, onError, onReady, slideId])

  if (error) return <div className="h-screen w-screen bg-black" />

  if (!document || !slideId) {
    return <div className="h-screen w-screen bg-black" />
  }

  const slideRatio = document.width / document.height

  return (
    <div className="flex h-screen w-screen items-center justify-center overflow-hidden bg-black">
      <div
        ref={frameRef}
        data-editable-projection-frame
        style={{
          width: `min(100vw, calc(100vh * ${slideRatio}))`,
          height: `min(100vh, calc(100vw / ${slideRatio}))`
        }}
      >
        <EditableSlideSurface document={document} slideId={slideId} className="h-full w-full" />
      </div>
    </div>
  )
}

function VlcProjectionSurface({
  itemId,
  blobId,
  durationMs,
  replayState,
  playbackVariant,
  startRevision
}: {
  itemId: string | null
  blobId?: string
  durationMs?: number
  replayState?: ProjectionMediaReplayState | null
  playbackVariant?: 'source' | 'matroska-remux'
  startRevision?: number
}): React.JSX.Element {
  useEffect(() => {
    if (!itemId || !blobId) return undefined
    const attemptId = crypto.randomUUID()
    void window.api?.projectionVlc
      ?.start({
        itemId,
        attemptId,
        sourceFileId: blobId,
        container: '#vlc-player',
        durationMs,
        playbackVariant,
        initialPositionSeconds:
          replayState?.itemId === itemId ? replayState.positionSeconds : undefined,
        initialVolume: replayState?.itemId === itemId ? replayState.volume : undefined,
        initialPlaybackState:
          replayState?.itemId !== itemId
            ? undefined
            : replayState.isEnded
              ? 'ended'
              : replayState.isPlaying
                ? 'playing'
                : 'paused'
      })
      .catch((error) => {
        console.error('[projection-vlc] Failed to start embedded VLC playback', error)
      })
    return () => {
      void window.api?.projectionVlc?.stop({ itemId, attemptId })
    }
  }, [blobId, durationMs, itemId, playbackVariant, replayState, startRevision])

  return <div id="vlc-player" className="h-full w-full bg-black" />
}

function PdfCanvas({
  canvas,
  size,
  previewUrl,
  pageNumber,
  continuous = false
}: {
  canvas: HTMLCanvasElement | undefined
  size?: { width: number; height: number }
  previewUrl?: string
  pageNumber: number
  continuous?: boolean
}): React.JSX.Element | null {
  const canvasHostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const canvasHost = canvasHostRef.current
    if (!canvasHost || !canvas) return
    Object.assign(canvas.style, {
      width: continuous ? '100%' : '',
      height: continuous ? 'auto' : '',
      maxWidth: '100%',
      maxHeight: continuous ? 'none' : '100%',
      objectFit: 'contain'
    })
    canvasHost.replaceChildren(canvas)
    return () => canvas.remove()
  }, [canvas, continuous])

  if (!canvas && !previewUrl) return null
  return (
    <div
      className={`flex items-center justify-center w-full${continuous ? '' : ' h-full'}`}
      style={
        continuous && size
          ? { maxWidth: size.width, aspectRatio: `${size.width} / ${size.height}` }
          : undefined
      }
    >
      <div
        ref={canvasHostRef}
        data-pdf-canvas-host={pageNumber}
        className={`flex h-full w-full items-center justify-center${canvas ? '' : ' hidden'}`}
      />
      {!canvas && previewUrl && (
        <img
          data-pdf-preview={pageNumber}
          src={previewUrl}
          alt=""
          className="h-full w-full object-contain"
        />
      )}
    </div>
  )
}
