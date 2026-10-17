import { useEffect } from 'react'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import { isElectron } from '@renderer/lib/env'
import {
  createLanRemoteSnapshot,
  executeLanRemoteCommand
} from '@renderer/lib/lan-remote-command-gateway'
import { useSettingsStore } from '@renderer/stores/settings'

const SNAPSHOT_INTERVAL_MS = 1000

export default function LanRemoteBridge(): null {
  const { isProjectionOpen } = useProjection()
  const enabled = useSettingsStore((state) => state.lanRemote.enabled)

  useEffect(() => {
    if (!enabled || !isElectron() || !window.api?.lanRemote) return
    return window.api.lanRemote.onCommand((command) => {
      void executeLanRemoteCommand(command)
        .then(async (ack) => {
          if (ack.status === 'accepted')
            await window.api.lanRemote.publishState(createLanRemoteSnapshot(isProjectionOpen))
          await window.api.lanRemote.publishAck(ack)
        })
        .catch((error) => console.error('[lan-remote] Command publication failed', error))
    })
  }, [enabled, isProjectionOpen])

  useEffect(() => {
    if (!enabled || !isElectron() || !window.api?.lanRemote) return
    void window.api.lanRemote.publishState(createLanRemoteSnapshot(isProjectionOpen))
    const intervalId = window.setInterval(() => {
      void window.api.lanRemote.publishState(createLanRemoteSnapshot(isProjectionOpen))
    }, SNAPSHOT_INTERVAL_MS)
    return () => window.clearInterval(intervalId)
  }, [enabled, isProjectionOpen])

  return null
}
