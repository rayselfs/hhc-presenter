import { useCallback, useEffect, useRef } from 'react'
import { toast } from '@heroui/react/toast'
import { useTranslation } from 'react-i18next'
import { useBeforeUnload, useBlocker, useLocation } from 'react-router-dom'
import { usePresentationCloseDecision } from '@renderer/contexts/PresentationCloseDecisionContext'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import {
  usePresentationSessionRegistry,
  type PresentationSessionRegistry
} from '@renderer/contexts/PresentationSessionRegistryContext'
import { closeProjectionAndMediaSession } from '@renderer/lib/projection-actions'
import { useMediaProjectionStore } from '@renderer/stores/media-projection'

type RequestCloseDecision = ReturnType<typeof usePresentationCloseDecision>

async function resolveUnsafePresentationWork(
  registry: PresentationSessionRegistry,
  requestCloseDecision: RequestCloseDecision
): Promise<boolean> {
  try {
    await (registry.checkpointAll?.() ?? registry.flushAll())
    return true
  } catch {
    const decision = await requestCloseDecision(registry.getUnsafeItemIds())
    if (decision === 'keep-editing') return false
    try {
      if (decision === 'retry') {
        await (registry.checkpointAll?.() ?? registry.flushAll())
      } else {
        await registry.discardAll()
      }
      return true
    } catch {
      return false
    }
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePresentationSafeAction(): (
  action: () => void | Promise<void>
) => Promise<boolean> {
  const registry = usePresentationSessionRegistry()
  const requestCloseDecision = usePresentationCloseDecision()

  return useCallback(
    async (action) => {
      if (!(await resolveUnsafePresentationWork(registry, requestCloseDecision))) return false
      await action()
      return true
    },
    [registry, requestCloseDecision]
  )
}

export default function PresentationNavigationGuard(): null {
  const { t } = useTranslation()
  const location = useLocation()
  const { stopProjection } = useProjection()
  const registry = usePresentationSessionRegistry()
  const requestCloseDecision = usePresentationCloseDecision()
  const isMediaPresenting = useMediaProjectionStore((state) => state.isPresenting)
  const endLiveSession = useMediaProjectionStore((state) => state.endLiveSession)
  const isProcessingRef = useRef(false)
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      currentLocation.pathname !== nextLocation.pathname &&
      (registry.hasUnsafeWork() || (currentLocation.pathname === '/media' && isMediaPresenting))
  )

  useBeforeUnload((event) => {
    if (!registry.hasUnsafeWork() && !isMediaPresenting) return
    event.preventDefault()
    event.returnValue = ''
  })

  useEffect(() => {
    if (blocker.state !== 'blocked' || isProcessingRef.current) return
    isProcessingRef.current = true
    const isLeavingMedia = location.pathname === '/media' && isMediaPresenting
    void (async () => {
      if (
        registry.hasUnsafeWork() &&
        !(await resolveUnsafePresentationWork(registry, requestCloseDecision))
      ) {
        blocker.reset()
        return
      }
      if (isLeavingMedia) {
        try {
          await closeProjectionAndMediaSession({
            closeProjection: stopProjection,
            endLiveSession
          })
        } catch {
          toast.danger(t('toast.projectionCloseFailed'))
          blocker.reset()
          return
        }
      }
      blocker.proceed()
    })()
      .catch(() => blocker.reset())
      .finally(() => {
        isProcessingRef.current = false
      })
  }, [
    blocker,
    endLiveSession,
    isMediaPresenting,
    location.pathname,
    registry,
    requestCloseDecision,
    stopProjection,
    t
  ])

  return null
}
