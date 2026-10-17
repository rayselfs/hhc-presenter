import { useTranslation } from 'react-i18next'
import { FolderPersistenceStatus } from '@renderer/components/Common/FolderPersistenceStatus'
import { useFileExplorerStore } from '@renderer/stores/file-explorer'
import { useBibleFolderStore } from '@renderer/stores/folder'
import AppLoadingScreen from './AppLoadingScreen'

export default function AppInitializationScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const files = useFileExplorerStore()
  const bible = useBibleFolderStore()
  if (files.persistenceStatus !== 'degraded' && bible.persistenceStatus !== 'degraded') {
    return <AppLoadingScreen />
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-foreground p-6">
      <div className="flex w-full max-w-xl flex-col gap-4">
        {(
          [
            ['nav.files', files],
            ['nav.bible', bible]
          ] as const
        ).map(([label, store]) => (
          <section key={label} aria-label={t(label)}>
            <h2 className="mb-2 font-semibold">{t(label)}</h2>
            <FolderPersistenceStatus
              status={store.persistenceStatus}
              error={store.persistenceError}
              isInitialized={store.isInitialized}
              onRetryInitialization={store.retryInitialization}
              onRetryPersistence={store.retryPersistence}
            />
          </section>
        ))}
      </div>
    </main>
  )
}
