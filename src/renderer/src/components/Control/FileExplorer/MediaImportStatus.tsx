import { useEffect, useRef } from 'react'
import { Button } from '@heroui/react/button'
import { toast } from '@heroui/react/toast'
import { useTranslation } from 'react-i18next'
import { useMediaImportStore } from '@renderer/stores/media-import'
import { dismissImportResults, retryFailedImports } from '@renderer/lib/upload-utils'

function ImportTitle(): React.JSX.Element {
  const { t } = useTranslation()
  const state = useMediaImportStore()
  return (
    <>
      {t(
        `fileExplorer.importProgress.${state.running ? (state.cancelRequested ? 'cancelling' : 'working') : 'complete'}`,
        {
          completed: state.completed,
          total: state.total,
          succeeded: state.succeeded,
          failed: state.failures.length,
          cancelled: state.total - state.completed
        }
      )}
    </>
  )
}

function ImportDescription(): React.JSX.Element {
  const { t } = useTranslation()
  const state = useMediaImportStore()
  return (
    <span className="flex min-w-0 flex-col gap-2">
      {state.currentNames.length > 0 && (
        <span className="line-clamp-2 break-all">{state.currentNames.join(', ')}</span>
      )}
      {state.running ? (
        <>
          <span>{t('fileExplorer.importProgress.cancelHelp')}</span>
          <Button
            className="self-start"
            size="sm"
            variant="secondary"
            isDisabled={state.cancelRequested}
            onPress={state.cancel}
          >
            {t('fileExplorer.importProgress.cancel')}
          </Button>
        </>
      ) : state.failures.length > 0 ? (
        <>
          <span
            className="flex max-h-32 flex-col overflow-y-auto break-all"
            aria-label={t('fileExplorer.importProgress.failures')}
          >
            {state.failures.map((failure, index) => (
              <span key={`${index}:${failure.name}`}>
                {failure.name}: {failure.reason}
              </span>
            ))}
          </span>
          <Button
            className="self-start"
            size="sm"
            variant="secondary"
            onPress={() => void retryFailedImports()}
          >
            {t('fileExplorer.importProgress.retry')}
          </Button>
        </>
      ) : null}
    </span>
  )
}

export function MediaImportStatus(): null {
  const current = useRef<{ key?: string; running: boolean; initialized: boolean }>({
    running: false,
    initialized: false
  })

  useEffect(() => {
    const sync = (): void => {
      const state = useMediaImportStore.getState()
      const previous = current.current
      const started = state.running && !previous.running
      const finished = !state.running && previous.running
      const initialResult = !previous.initialized && state.total > 0
      previous.initialized = true
      previous.running = state.running

      if (!started && !finished && !initialResult && state.total > 0) return
      // A dismissed progress toast stays dismissed until the next import session.
      if (finished && !previous.key) return
      if (previous.key) {
        const key = previous.key
        previous.key = undefined
        toast.close(key)
      }
      if (!state.total) return

      const key = toast(<ImportTitle />, {
        description: <ImportDescription />,
        isLoading: state.running,
        variant: state.running ? 'default' : state.failures.length ? 'danger' : 'success',
        timeout: state.running || state.failures.length > 0 ? 0 : 6000,
        onClose: () => {
          if (current.current.key !== key) return
          current.current.key = undefined
          if (!useMediaImportStore.getState().running) dismissImportResults()
        }
      })
      previous.key = key
    }
    sync()
    return useMediaImportStore.subscribe(sync)
  }, [])

  return null
}
