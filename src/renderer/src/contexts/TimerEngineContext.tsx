import { createContext, useContext, useEffect, useState } from 'react'
import { createTimerAdapter, type TimerAdapter } from '@renderer/lib/timer-adapter'
import { bindTimerRuntimeClient } from '@renderer/lib/timer-runtime-client'
import {
  applyTimerRuntimeSnapshot,
  getTimerRuntimeConfiguration,
  useTimerConfigStore
} from '@renderer/stores/timer'
import { useSettingsStore } from '@renderer/stores/settings'
import type { TimerRuntimeSnapshot } from '@shared/types/timer'

const TimerEngineContext = createContext<TimerAdapter | null>(null)

export function TimerEngineProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [adapter, setAdapter] = useState<TimerAdapter | null>(null)
  useEffect(() => {
    const current = createTimerAdapter()
    let active = true
    let latest: TimerRuntimeSnapshot | null = null
    const unsubscribe = current.onSnapshot((snapshot) => {
      if (!active) return
      latest = snapshot
      applyTimerRuntimeSnapshot(snapshot)
    })
    const initialized = current.initialize(getTimerRuntimeConfiguration())
    const unbind = bindTimerRuntimeClient((command) => current.execute(command))
    const restoreAcceptedPreferences = (): void => {
      if (active && latest) applyTimerRuntimeSnapshot(latest)
    }
    const stopConfigHydration = useTimerConfigStore.persist.onFinishHydration(
      restoreAcceptedPreferences
    )
    const stopSettingsHydration = useSettingsStore.persist.onFinishHydration(
      restoreAcceptedPreferences
    )
    void initialized.then((result) => {
      if (active && result.status === 'rejected')
        console.error('[timer] Initialization rejected', result.reason)
    })
    // Expose the disposable resource created by this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAdapter(current)
    return () => {
      active = false
      unbind()
      unsubscribe()
      stopConfigHydration()
      stopSettingsHydration()
      current.dispose()
      setAdapter(null)
    }
  }, [])
  return <TimerEngineContext.Provider value={adapter}>{children}</TimerEngineContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTimerEngine(): TimerAdapter | null {
  return useContext(TimerEngineContext)
}
