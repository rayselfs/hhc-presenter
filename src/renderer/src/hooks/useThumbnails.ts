import { useEffect, useMemo, useRef, useState } from 'react'
import { getBlobId } from '@renderer/lib/blob-identity'
import { getThumbnail } from '@renderer/lib/thumbnail-db'
import type { ThumbnailReadyDetail } from '@renderer/lib/thumbnail-events'
import { canGenerateMediaThumbnail, resolveMediaCapability } from '@renderer/lib/media-capabilities'
import { isElectron } from '@renderer/lib/env'

export function canHaveThumbnail(mimeType: string | undefined): boolean {
  const capability = resolveMediaCapability({ mimeType })
  return (
    canGenerateMediaThumbnail(capability) ||
    (isElectron() && capability?.kind === 'video' && capability.electron === 'desktop-engine')
  )
}

function revokeIfBlobUrl(url: string | null): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
}

function createSemaphore(limit: number): { acquire(): Promise<() => void> } {
  let active = 0
  const queue: Array<() => void> = []

  function acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = (): void => {
        if (active < limit) {
          active++
          resolve(() => {
            active--
            if (queue.length > 0) {
              const next = queue.shift()!
              next()
            }
          })
        } else {
          queue.push(tryAcquire)
        }
      }
      tryAcquire()
    })
  }

  return { acquire }
}

const THUMBNAIL_LOAD_CONCURRENCY = 5

interface ThumbnailItem {
  id: string
  url: string
  mimeType?: string
  createdAt?: number
}

interface UseThumbnailsOptions {
  pendingAgeMs?: number
}

export function useThumbnails(
  items: ThumbnailItem[],
  options: UseThumbnailsOptions = {}
): Record<string, string | null> {
  const [allThumbnails, setAllThumbnails] = useState<Record<string, string | null>>({})
  const { pendingAgeMs } = options
  const semaphore = useMemo(() => createSemaphore(THUMBNAIL_LOAD_CONCURRENCY), [])
  const thumbnailsRef = useRef<Record<string, string | null>>({})
  const sourcesRef = useRef(new Map<string, string>())
  const itemsRef = useRef(items)
  itemsRef.current = items
  const itemsKey = items
    .filter((item) => canHaveThumbnail(item.mimeType))
    .map((item) => `${item.id}:${item.url}:${item.createdAt ?? 0}`)
    .join(',')

  useEffect(() => {
    let cancelled = false
    const thumbnailItems = itemsRef.current.filter((item) => canHaveThumbnail(item.mimeType))
    const requests = new Map<string, number>()
    const sources = new Map(thumbnailItems.map((item) => [item.id, getBlobId(item)]))
    for (const [id, url] of Object.entries(thumbnailsRef.current)) {
      if (sources.get(id) !== sourcesRef.current.get(id)) {
        revokeIfBlobUrl(url)
        delete thumbnailsRef.current[id]
        sourcesRef.current.delete(id)
      }
    }
    setAllThumbnails({ ...thumbnailsRef.current })
    if (thumbnailItems.length === 0) return

    async function load(item: ThumbnailItem, ready = false): Promise<void> {
      const sourceBlobId = getBlobId(item)
      const request = (requests.get(item.id) ?? 0) + 1
      requests.set(item.id, request)
      const release = await semaphore.acquire()
      const isCurrent = (): boolean =>
        !cancelled &&
        requests.get(item.id) === request &&
        itemsRef.current.some(
          (current) => current.id === item.id && getBlobId(current) === sourceBlobId
        )
      try {
        if (!isCurrent()) return
        const url = await getThumbnail(item.id, sourceBlobId)
        if (!isCurrent()) {
          revokeIfBlobUrl(url)
          return
        }
        if (
          url !== null ||
          ready ||
          pendingAgeMs === undefined ||
          Date.now() - (item.createdAt ?? 0) > pendingAgeMs
        ) {
          revokeIfBlobUrl(thumbnailsRef.current[item.id] ?? null)
          thumbnailsRef.current[item.id] = url
          sourcesRef.current.set(item.id, sourceBlobId)
          setAllThumbnails({ ...thumbnailsRef.current })
        }
      } catch (error) {
        if (isCurrent())
          console.warn('[thumbnail] Failed to load thumbnail', { itemId: item.id, error })
      } finally {
        release()
      }
    }

    const onThumbnailReady = (event: Event): void => {
      const { itemId, sourceBlobId } = (event as CustomEvent<ThumbnailReadyDetail>).detail
      const item = thumbnailItems.find(
        (candidate) => candidate.id === itemId && getBlobId(candidate) === sourceBlobId
      )
      if (item) void load(item, true)
    }
    window.addEventListener('hhc:thumbnail-ready', onThumbnailReady)
    for (const item of thumbnailItems) void load(item)
    return () => {
      cancelled = true
      window.removeEventListener('hhc:thumbnail-ready', onThumbnailReady)
    }
  }, [itemsKey, pendingAgeMs, semaphore])

  useEffect(
    () => () => {
      for (const url of Object.values(thumbnailsRef.current)) revokeIfBlobUrl(url)
      thumbnailsRef.current = {}
      sourcesRef.current.clear()
    },
    []
  )

  return useMemo(
    () =>
      Object.fromEntries(
        items
          .filter(
            (item) =>
              canHaveThumbnail(item.mimeType) &&
              sourcesRef.current.get(item.id) === getBlobId(item) &&
              item.id in allThumbnails
          )
          .map((item) => [item.id, allThumbnails[item.id]])
      ),
    [items, allThumbnails]
  )
}
