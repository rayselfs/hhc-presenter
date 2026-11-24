import { useCallback, useEffect, useRef } from 'react'
import { create } from 'zustand'
import { useHhcAuth } from '@renderer/contexts/HhcAuthContext'
import type { WeeklyEdition } from '@shared/weekly-reader'

type Access = {
  owner: string | null
  editions: WeeklyEdition[]
  status: 'idle' | 'ready' | 'error'
}

const empty: Access = { owner: null, editions: [], status: 'idle' }
let invalidation = 0
const useAccess = create<Access>(() => empty)

export function invalidateWeeklyAccess(): void {
  invalidation++
  useAccess.setState({ ...empty, status: 'error' })
}

export function useWeeklyAccess(): Access {
  const auth = useHhcAuth()
  const snapshot = useAccess()
  return auth.status === 'authenticated' &&
    auth.session?.permissionAvailability?.status !== 'unavailable' &&
    (snapshot.owner === null || snapshot.owner === auth.session?.userId)
    ? snapshot
    : empty
}

export function useRefreshWeeklyAccess(): void {
  const auth = useHhcAuth()
  const authRef = useRef(auth)
  authRef.current = auth
  const owner =
    auth.status === 'authenticated' &&
    auth.session?.permissionAvailability?.status !== 'unavailable'
      ? auth.session?.userId
      : null
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (!owner) return
      const initialInvalidation = invalidation
      const generation = authRef.current.getAuthGeneration()
      const current = (): boolean =>
        !signal.aborted &&
        initialInvalidation === invalidation &&
        authRef.current.getAuthGeneration() === generation &&
        authRef.current.session?.userId === owner
      try {
        const { fetchWeeklyEditions } = await import('@renderer/lib/weekly-reader')
        const editions = await fetchWeeklyEditions(authRef.current, signal)
        if (!current()) return
        const previous = useAccess.getState()
        if (
          previous.owner === owner &&
          previous.status === 'ready' &&
          previous.editions.length === editions.length &&
          previous.editions.every(
            (entry, i) => entry.series === editions[i].series && entry.locale === editions[i].locale
          )
        )
          return
        useAccess.setState({ owner, editions, status: 'ready' })
      } catch {
        if (current()) useAccess.setState({ owner, editions: [], status: 'error' })
      }
    },
    [owner]
  )

  useEffect(() => {
    useAccess.setState(empty)
    if (!owner) return
    let active: AbortController | null = null
    const update = (): void => {
      active?.abort()
      active = new AbortController()
      void refresh(active.signal)
    }
    update()
    const timer = window.setInterval(update, 60000)
    window.addEventListener('focus', update)
    window.addEventListener('online', update)
    return () => {
      active?.abort()
      clearInterval(timer)
      window.removeEventListener('focus', update)
      window.removeEventListener('online', update)
      useAccess.setState(empty)
    }
  }, [owner, refresh])
}
