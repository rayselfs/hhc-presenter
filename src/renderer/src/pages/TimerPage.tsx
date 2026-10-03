import React, { useEffect, useRef } from 'react'
import { useTimerStore, getDisplayValues } from '@renderer/stores/timer'
import { useTimerConfigStore } from '@renderer/stores/timer-config'
import { useStopwatchStore } from '@renderer/stores/stopwatch'
import { selectFormattedTime } from '@renderer/stores/selectors/stopwatch'
import TimerDisplay from '@renderer/components/Control/Timer/TimerDisplay'
import StopwatchDisplay from '@renderer/components/Control/Timer/StopwatchDisplay'
import TimerControls from '@renderer/components/Control/Timer/TimerControls'
import TimeAdjustment from '@renderer/components/Control/Timer/TimeAdjustment'
import PresetChips from '@renderer/components/Control/Timer/PresetChips'
import { useProjection } from '@renderer/contexts/ProjectionContext'
import { useKeyboardShortcuts } from '@renderer/hooks/useKeyboardShortcuts'
import { SHORTCUTS } from '@renderer/config/shortcuts'
import { getTimerProjectionPayloads, startTimerProjection } from '@renderer/lib/projection-actions'
import { toast } from '@heroui/react/toast'
import { useTranslation } from 'react-i18next'

export default function TimerPage(): React.JSX.Element {
  const { t } = useTranslation()
  const mode = useTimerStore((s) => s.mode)
  const phase = useTimerStore((s) => s.phase)
  const progress = useTimerStore((s) => s.progress)
  const remainingSeconds = useTimerStore((s) => s.remainingSeconds)
  const overtimeSeconds = useTimerStore((s) => s.overtimeSeconds)
  const totalDuration = useTimerStore((s) => s.totalDuration)
  const reminderEnabled = useTimerStore((s) => s.reminderEnabled)
  const reminderDuration = useTimerStore((s) => s.reminderDuration)
  const reminderColor = useTimerStore((s) => s.reminderColor)
  const timerStatus = useTimerStore((s) => s.status)
  const setDuration = useTimerStore((s) => s.setDuration)

  const swFormattedTime = useStopwatchStore(selectFormattedTime)

  const { claimProjection, isProjectionOpen, startProjection, send } = useProjection()

  const isTimerActive = timerStatus === 'running' || timerStatus === 'paused'
  const isTimerActiveRef = useRef(isTimerActive)
  useEffect(() => {
    isTimerActiveRef.current = isTimerActive
  })

  useEffect(() => {
    return useTimerConfigStore.subscribe((state, prevState) => {
      if (
        prevState.reminderEnabled &&
        !state.reminderEnabled &&
        state.totalDuration !== prevState.totalDuration
      ) {
        toast.danger(t('toast.reminderAutoDisabled'))
      }
    })
  }, [t])

  useEffect(() => {
    if (!isProjectionOpen) return
    claimProjection('timer', { unblank: isTimerActiveRef.current })
    for (const [channel, payload] of getTimerProjectionPayloads()) send(channel, payload)
  }, [isProjectionOpen, claimProjection, send])

  useKeyboardShortcuts([
    {
      config: SHORTCUTS.TIMER.TOGGLE,
      handler: () => {
        const { status, start, pause } = useTimerStore.getState()
        if (status === 'running') {
          pause()
          return
        }
        if (status === 'stopped' || status === 'paused') {
          startTimerProjection({ startProjection }).catch(() => {})
          start()
        }
      },
      preventDefault: true
    },
    {
      config: SHORTCUTS.TIMER.RESET,
      handler: () => {
        useTimerStore.getState().reset()
      },
      preventDefault: true
    }
  ])

  const displayValues = getDisplayValues({
    phase,
    remainingSeconds,
    reminderDuration,
    overtimeSeconds,
    totalDuration,
    reminderEnabled
  })

  const isTimerLike = mode === 'timer' || mode === 'clock' || mode === 'both'

  return (
    <div data-testid="timer-page" className="flex min-h-full gap-4">
      {isTimerLike && (
        <>
          <div className="w-18 shrink-0 max-lg:hidden" />
          <div className="flex flex-col items-center gap-4 flex-1">
            <div className="flex flex-col items-center gap-4 lg:scale-125 lg:origin-top">
              <TimerDisplay
                progress={progress}
                mainDisplay={displayValues.mainDisplay}
                subDisplay={displayValues.subDisplay}
                phase={phase}
                overtimeDisplay={displayValues.overtimeDisplay}
                warningColor={reminderEnabled ? reminderColor : null}
                canEditTime={timerStatus === 'stopped' && phase !== 'overtime'}
                onTimeConfirm={(seconds) => setDuration(seconds)}
                digitClassName="text-segment-foreground"
              />
              <TimerControls className="mb-3" mode={mode} />
              <TimeAdjustment />
            </div>
          </div>
          <PresetChips className="shrink-0 max-lg:hidden" />
        </>
      )}

      {mode === 'stopwatch' && (
        <div className="flex flex-col items-center gap-4 flex-1 w-full">
          <div className="flex flex-col items-center gap-4 lg:scale-125 lg:origin-top">
            <StopwatchDisplay formattedTime={swFormattedTime} />
            <TimerControls mode="stopwatch" />
          </div>
        </div>
      )}
    </div>
  )
}
