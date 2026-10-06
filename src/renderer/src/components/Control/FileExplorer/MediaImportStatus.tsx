import { Button } from '@heroui/react/button'
import { useTranslation } from 'react-i18next'
import { useMediaImportStore } from '@renderer/stores/media-import'
import { dismissImportResults, retryFailedImports } from '@renderer/lib/upload-utils'

export function MediaImportStatus(): React.JSX.Element | null {
  const { t } = useTranslation()
  const state = useMediaImportStore()
  if (!state.total) return null
  return (
    <section
      className="mx-3 mt-3 rounded-lg border border-divider p-3 text-sm"
      aria-label={t('fileExplorer.importProgress.title')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" className="mr-auto">
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
        </span>
        {state.running ? (
          <Button
            size="sm"
            variant="secondary"
            isDisabled={state.cancelRequested}
            onPress={state.cancel}
          >
            {t('fileExplorer.importProgress.cancel')}
          </Button>
        ) : (
          <>
            {state.failures.length > 0 && (
              <Button size="sm" variant="secondary" onPress={() => void retryFailedImports()}>
                {t('fileExplorer.importProgress.retry')}
              </Button>
            )}
            <Button size="sm" variant="tertiary" onPress={dismissImportResults}>
              {t('common.close')}
            </Button>
          </>
        )}
      </div>
      {state.destinationNames.length > 0 && (
        <p className="mt-1 truncate text-default-500">{state.destinationNames.join(', ')}</p>
      )}
      {state.currentNames.length > 0 && (
        <p className="mt-1 truncate text-default-500">{state.currentNames.join(', ')}</p>
      )}
      {state.running && (
        <p className="mt-1 text-xs text-default-500">
          {t('fileExplorer.importProgress.cancelHelp')}
        </p>
      )}
      {state.failures.length > 0 && (
        <ul
          className="mt-2 max-h-32 overflow-y-auto"
          aria-label={t('fileExplorer.importProgress.failures')}
        >
          {state.failures.map((failure, index) => (
            <li key={`${index}:${failure.name}`}>
              {failure.name}: {failure.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
