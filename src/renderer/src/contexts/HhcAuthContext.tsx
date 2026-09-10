import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { hasPresenterCloudAccess, type HhcAuthAdapter, type HhcSession } from '@shared/hhc-auth'
import { createHhcAuthAdapter, registerHhcSessionOwner } from '@renderer/lib/hhc-auth'

export type HhcAuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'unavailable'
export type HhcSignInStatus = 'idle' | 'pending' | 'cancelled' | 'expired'

type HhcAuthContextValue = {
  status: HhcAuthStatus
  session: HhcSession | null
  signInStatus: HhcSignInStatus
  pendingSignInExpiresAt: number | null
  signIn(): Promise<void>
  cancelSignIn(): Promise<void>
  signOut(): Promise<void>
  endSession(): Promise<void>
  getAuthGeneration(): number
  getAccessToken(): Promise<string | null>
  refreshAccessToken(): Promise<string | null>
}

const HhcAuthContext = createContext<HhcAuthContextValue | null>(null)

export function HhcAuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<HhcAuthStatus>('loading')
  const [session, setSession] = useState<HhcSession | null>(null)
  const [signInStatus, setSignInStatus] = useState<HhcSignInStatus>('idle')
  const [pendingSignInExpiresAt, setPendingSignInExpiresAt] = useState<number | null>(null)
  const adapterRef = useRef<HhcAuthAdapter | null>(null)
  const sessionRef = useRef<HhcSession | null>(null)
  const sessionEpochRef = useRef(0)
  const authGenerationRef = useRef(0)
  const signInAttemptRef = useRef(0)
  const signOutPendingRef = useRef(false)
  const accessTokenPromiseRef = useRef<Promise<string | null> | null>(null)
  const refreshTokenPromiseRef = useRef<Promise<string | null> | null>(null)
  const sessionTransitionPromiseRef = useRef<Promise<void>>(Promise.resolve())
  const departingAccountCleanupRef = useRef(new Map<string, Promise<void>>())

  useLayoutEffect(
    () => registerHhcSessionOwner(() => (signOutPendingRef.current ? null : sessionRef.current)),
    []
  )

  const sessionUserId = session?.userId
  const cloudAllowed = hasPresenterCloudAccess(session?.permissions)
  useLayoutEffect(() => {
    usePersonalSyncStore.getState().setAccount(status, sessionUserId, cloudAllowed)
  }, [status, sessionUserId, cloudAllowed])

  const invalidateTokenRequests = useCallback((): void => {
    sessionEpochRef.current += 1
    accessTokenPromiseRef.current = null
    refreshTokenPromiseRef.current = null
  }, [])

  const getAuthGeneration = useCallback((): number => authGenerationRef.current, [])

  const cleanupDepartingAccount = useCallback(async (accountUserId: string): Promise<void> => {
    const existing = departingAccountCleanupRef.current.get(accountUserId)
    if (existing) return existing
    const cleanup = (async () => {
      const { cleanupHhcLineAccountAccess } = await import('@renderer/lib/hhc-line-access')
      await Promise.all([
        window.api?.hhcAssets?.clearContentLeases?.() ?? Promise.resolve(),
        cleanupHhcLineAccountAccess(accountUserId)
      ])
    })().finally(() => {
      if (departingAccountCleanupRef.current.get(accountUserId) === cleanup) {
        departingAccountCleanupRef.current.delete(accountUserId)
      }
    })
    departingAccountCleanupRef.current.set(accountUserId, cleanup)
    return cleanup
  }, [])

  useEffect(() => {
    let active = true
    let adapter: HhcAuthAdapter | null = null
    let unsubscribe: (() => void) | null = null
    let retryBootstrap = (): void => {}
    const retry = (): void => retryBootstrap()
    let activityTimer: number | null = null
    const revalidate = (): void => {
      if (!adapter?.revalidateOnPageActivity || activityTimer !== null) return
      activityTimer = window.setTimeout(() => {
        activityTimer = null
        retryBootstrap()
      }, 0)
    }
    const revalidateFocus = (): void => {
      if (adapter?.revalidateOnPageActivity) revalidate()
      else retry()
    }
    const revalidateVisible = (): void => {
      if (document.visibilityState === 'visible') revalidate()
    }
    const revalidateRestored = (event: PageTransitionEvent): void => {
      if (event.persisted) revalidate()
    }
    window.addEventListener('online', retry)
    window.addEventListener('focus', revalidateFocus)
    window.addEventListener('pageshow', revalidateRestored)
    document.addEventListener('visibilitychange', revalidateVisible)

    void createHhcAuthAdapter()
      .then(async (createdAdapter) => {
        adapter = createdAdapter
        if (!active) {
          createdAdapter.dispose()
          return
        }

        adapterRef.current = createdAdapter
        let bootstrapUnavailable = false
        let bootstrapRunning = false
        let sessionNotificationVersion = 0
        let cleanupUserId: string | null = null
        let cleanupInFlight = false
        let pendingSession: HhcSession | null = null

        const publishSession = (
          nextSession: HhcSession | null,
          resetSignOutPending: boolean
        ): void => {
          sessionRef.current = nextSession
          if (resetSignOutPending) signOutPendingRef.current = false
          setSession(nextSession)
          setStatus(nextSession ? 'authenticated' : 'anonymous')
        }

        const beginCleanup = (previousUserId: string): void => {
          cleanupInFlight = true
          const transition = cleanupDepartingAccount(previousUserId)
            .then(() => {
              if (!active || cleanupUserId !== previousUserId) return
              cleanupUserId = null
              const target = pendingSession
              pendingSession = null
              publishSession(target, true)
            })
            .catch(() => {
              if (!active || cleanupUserId !== previousUserId) return
              sessionRef.current = null
              setSession(null)
              setStatus('unavailable')
            })
            .finally(() => {
              cleanupInFlight = false
            })
          sessionTransitionPromiseRef.current = transition
        }

        const applySession = (nextSession: HhcSession | null): void => {
          if (!active) return
          bootstrapUnavailable = false
          if (nextSession) {
            signInAttemptRef.current += 1
            setSignInStatus('idle')
            setPendingSignInExpiresAt(null)
          }
          if (cleanupUserId) {
            pendingSession = nextSession
            if (!cleanupInFlight) beginCleanup(cleanupUserId)
            return
          }
          const previousUserId = sessionRef.current?.userId
          const nextUserId = nextSession?.userId
          if (previousUserId !== nextUserId) {
            authGenerationRef.current += 1
            usePersonalSyncStore.getState().setAccount(previousUserId ? 'anonymous' : 'loading')
          }
          if (!nextSession || previousUserId !== nextUserId) invalidateTokenRequests()
          if (previousUserId && previousUserId !== nextUserId) {
            cleanupUserId = previousUserId
            pendingSession = nextSession
            sessionRef.current = null
            setSession(null)
            setStatus('loading')
            beginCleanup(previousUserId)
            return
          }
          publishSession(nextSession, !nextSession || previousUserId !== nextUserId)
        }

        unsubscribe = createdAdapter.subscribe((nextSession) => {
          sessionNotificationVersion += 1
          applySession(nextSession)
        })

        const bootstrap = async (): Promise<void> => {
          if (bootstrapRunning) return
          bootstrapRunning = true
          const requestEpoch = sessionEpochRef.current
          const requestNotificationVersion = sessionNotificationVersion
          try {
            const nextSession = await createdAdapter.getSession()
            if (!active) return
            if (
              sessionEpochRef.current === requestEpoch &&
              sessionNotificationVersion === requestNotificationVersion
            )
              applySession(nextSession)
            if (!nextSession) await createdAdapter.attemptPassiveSignIn?.()
          } catch {
            if (
              !active ||
              sessionEpochRef.current !== requestEpoch ||
              sessionNotificationVersion !== requestNotificationVersion
            )
              return
            bootstrapUnavailable = true
            if (sessionRef.current) return
            sessionRef.current = null
            setSession(null)
            setStatus('unavailable')
          } finally {
            bootstrapRunning = false
          }
        }
        retryBootstrap = () => {
          if (
            active &&
            !signOutPendingRef.current &&
            (bootstrapUnavailable || createdAdapter.revalidateOnPageActivity)
          )
            void bootstrap()
        }
        await bootstrap()
      })
      .catch(() => {
        if (!active) return
        setSession(null)
        setStatus('unavailable')
      })

    return () => {
      active = false
      window.removeEventListener('online', retry)
      window.removeEventListener('focus', revalidateFocus)
      window.removeEventListener('pageshow', revalidateRestored)
      document.removeEventListener('visibilitychange', revalidateVisible)
      if (activityTimer !== null) window.clearTimeout(activityTimer)
      unsubscribe?.()
      if (adapterRef.current === adapter) adapterRef.current = null
      sessionRef.current = null
      signInAttemptRef.current += 1
      signOutPendingRef.current = false
      sessionTransitionPromiseRef.current = Promise.resolve()
      invalidateTokenRequests()
      adapter?.dispose()
    }
  }, [cleanupDepartingAccount, invalidateTokenRequests])

  const signIn = useCallback(async (): Promise<void> => {
    const adapter = adapterRef.current
    if (!adapter) throw new Error('HHC account is unavailable')
    const previousSession = sessionRef.current
    const attempt = ++signInAttemptRef.current
    setSignInStatus('pending')
    setPendingSignInExpiresAt(null)
    sessionRef.current = null
    signOutPendingRef.current = false
    invalidateTokenRequests()
    try {
      const generation = authGenerationRef.current
      const pending = await adapter.signIn()
      if (adapterRef.current === adapter && signInAttemptRef.current === attempt) {
        setPendingSignInExpiresAt(pending.expiresAt)
      }
      if (
        adapterRef.current === adapter &&
        signInAttemptRef.current === attempt &&
        authGenerationRef.current === generation
      ) {
        authGenerationRef.current += 1
      }
    } catch (error) {
      if (adapterRef.current !== adapter || signInAttemptRef.current !== attempt) return
      setSignInStatus('idle')
      setPendingSignInExpiresAt(null)
      if (!sessionRef.current) {
        sessionRef.current = previousSession
      }
      throw error
    }
  }, [invalidateTokenRequests])

  const cancelSignIn = useCallback(async (): Promise<void> => {
    const adapter = adapterRef.current
    if (!adapter) throw new Error('HHC account is unavailable')
    const attempt = ++signInAttemptRef.current
    await adapter.cancelSignIn()
    if (adapterRef.current === adapter && signInAttemptRef.current === attempt) {
      setSignInStatus('cancelled')
      setPendingSignInExpiresAt(null)
    }
  }, [])

  useEffect(() => {
    if (signInStatus !== 'pending' || pendingSignInExpiresAt === null) return
    const attempt = signInAttemptRef.current
    const timer = window.setTimeout(
      () => {
        const adapter = adapterRef.current
        if (!adapter || signInAttemptRef.current !== attempt) return
        signInAttemptRef.current += 1
        setPendingSignInExpiresAt(null)
        void adapter
          .cancelSignIn()
          .catch(() => undefined)
          .finally(() => {
            if (adapterRef.current === adapter && signInAttemptRef.current === attempt + 1) {
              setSignInStatus('expired')
            }
          })
      },
      Math.max(0, pendingSignInExpiresAt - Date.now())
    )
    return () => window.clearTimeout(timer)
  }, [pendingSignInExpiresAt, signInStatus])

  const signOut = useCallback(async (): Promise<void> => {
    const adapter = adapterRef.current
    if (!adapter) throw new Error('HHC account is unavailable')
    const departingUserId = sessionRef.current?.userId
    signInAttemptRef.current += 1
    setSignInStatus('idle')
    setPendingSignInExpiresAt(null)
    signOutPendingRef.current = true
    usePersonalSyncStore.getState().setAccount('anonymous')
    invalidateTokenRequests()
    try {
      const generation = authGenerationRef.current
      await adapter.signOut()
      if (departingUserId) await cleanupDepartingAccount(departingUserId)
      await sessionTransitionPromiseRef.current
      if (adapterRef.current === adapter && authGenerationRef.current === generation) {
        authGenerationRef.current += 1
      }
    } catch (error) {
      if (adapterRef.current === adapter) {
        signOutPendingRef.current = false
        const current = sessionRef.current
        usePersonalSyncStore
          .getState()
          .setAccount(
            current ? 'authenticated' : 'anonymous',
            current?.userId,
            hasPresenterCloudAccess(current?.permissions)
          )
      }
      throw error
    }
  }, [cleanupDepartingAccount, invalidateTokenRequests])

  const getAccessToken = useCallback((): Promise<string | null> => {
    const adapter = adapterRef.current
    const expectedUserId = sessionRef.current?.userId
    if (!adapter || !expectedUserId || signOutPendingRef.current) return Promise.resolve(null)
    if (accessTokenPromiseRef.current) return accessTokenPromiseRef.current

    const epoch = sessionEpochRef.current
    const request = adapter
      .getAccessToken()
      .then((token) =>
        adapterRef.current === adapter &&
        sessionEpochRef.current === epoch &&
        !signOutPendingRef.current &&
        sessionRef.current?.userId === expectedUserId
          ? token
          : null
      )
      .catch((error: unknown) => {
        if (
          adapterRef.current === adapter &&
          sessionEpochRef.current === epoch &&
          sessionRef.current?.userId === expectedUserId
        ) {
          invalidateTokenRequests()
          sessionRef.current = null
          setSession(null)
          setStatus('unavailable')
        }
        throw error
      })
    accessTokenPromiseRef.current = request
    request.then(
      () => {
        if (accessTokenPromiseRef.current === request) accessTokenPromiseRef.current = null
      },
      () => {
        if (accessTokenPromiseRef.current === request) accessTokenPromiseRef.current = null
      }
    )
    return request
  }, [invalidateTokenRequests])

  const refreshAccessToken = useCallback((): Promise<string | null> => {
    const adapter = adapterRef.current
    const expectedUserId = sessionRef.current?.userId
    if (!adapter || !expectedUserId || signOutPendingRef.current) return Promise.resolve(null)
    if (refreshTokenPromiseRef.current) return refreshTokenPromiseRef.current

    const epoch = sessionEpochRef.current
    const request = adapter
      .refreshAccessToken()
      .then((token) =>
        adapterRef.current === adapter &&
        sessionEpochRef.current === epoch &&
        !signOutPendingRef.current &&
        sessionRef.current?.userId === expectedUserId
          ? token
          : null
      )
    refreshTokenPromiseRef.current = request
    request.then(
      () => {
        if (refreshTokenPromiseRef.current === request) refreshTokenPromiseRef.current = null
      },
      () => {
        if (refreshTokenPromiseRef.current === request) refreshTokenPromiseRef.current = null
      }
    )
    return request
  }, [])

  const value = useMemo(
    () => ({
      status,
      session,
      signInStatus,
      pendingSignInExpiresAt,
      signIn,
      cancelSignIn,
      signOut,
      endSession: signOut,
      getAuthGeneration,
      getAccessToken,
      refreshAccessToken
    }),
    [
      cancelSignIn,
      getAccessToken,
      getAuthGeneration,
      pendingSignInExpiresAt,
      refreshAccessToken,
      session,
      signIn,
      signInStatus,
      signOut,
      status
    ]
  )

  return <HhcAuthContext.Provider value={value}>{children}</HhcAuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useHhcAuth(): HhcAuthContextValue {
  const context = useContext(HhcAuthContext)
  if (!context) throw new Error('useHhcAuth must be used within HhcAuthProvider')
  return context
}
