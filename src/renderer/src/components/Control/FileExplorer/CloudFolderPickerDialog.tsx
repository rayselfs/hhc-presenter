import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@heroui/react/button'
import { Modal } from '@heroui/react/modal'
import { ArrowLeft, Folder, Loader2 } from 'lucide-react'
import type {
  CloudFolderListing,
  CloudImportResult,
  CloudProviderId,
  CloudRemoteFolder
} from '@renderer/lib/cloud-provider'
import { ShortcutScope } from '@renderer/contexts/ShortcutScopeContext'

export interface CloudFolderPickerProvider {
  providerType: CloudProviderId
  displayName: string
  icon: ReactNode
  supportsFolderNavigation?: boolean
  listFolders(parentRemoteFolderId?: string): Promise<CloudFolderListing>
  importFolder(folder: CloudRemoteFolder): Promise<CloudImportResult>
}

interface FolderStackEntry {
  id: string
  name: string
}

export interface CloudFolderPickerDialogProps {
  provider: CloudFolderPickerProvider
  isOpen: boolean
  isImporting?: boolean
  onClose: () => void
  onImport: (folder: CloudRemoteFolder) => void
}

export default function CloudFolderPickerDialog({
  provider,
  isOpen,
  isImporting = false,
  onClose,
  onImport
}: CloudFolderPickerDialogProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [folderStack, setFolderStack] = useState<FolderStackEntry[]>([
    { id: 'root', name: provider.displayName }
  ])
  const [folders, setFolders] = useState<CloudRemoteFolder[]>([])
  const [selectedFolder, setSelectedFolder] = useState<CloudRemoteFolder | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [incomplete, setIncomplete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadGenerationRef = useRef(0)
  const currentFolder = folderStack[folderStack.length - 1]

  const loadFolders = useCallback(
    async (remoteFolderId: string): Promise<void> => {
      const generation = ++loadGenerationRef.current
      setIsLoading(true)
      setError(null)
      setIncomplete(false)
      setSelectedFolder(null)
      try {
        const nextFolders = await provider.listFolders(remoteFolderId)
        if (generation !== loadGenerationRef.current) return
        setFolders(Array.isArray(nextFolders) ? nextFolders : nextFolders.folders)
        setIncomplete(!Array.isArray(nextFolders) && nextFolders.incomplete)
      } catch (loadError) {
        if (generation !== loadGenerationRef.current) return
        console.warn('[cloud-sync] Failed to list folders', {
          providerType: provider.providerType,
          error: loadError
        })
        setFolders([])
        setError(
          t('fileExplorer.cloudFolderPicker.loadFailed', {
            provider: provider.displayName
          })
        )
      } finally {
        if (generation === loadGenerationRef.current) setIsLoading(false)
      }
    },
    [provider, t]
  )

  useEffect(() => {
    if (!isOpen) {
      loadGenerationRef.current += 1
      setFolders([])
      return
    }
    setFolderStack([{ id: 'root', name: provider.displayName }])
    setSelectedFolder(null)
    void loadFolders('root')
    return () => {
      loadGenerationRef.current += 1
    }
  }, [isOpen, loadFolders, provider.displayName])

  function openFolder(folder: CloudRemoteFolder): void {
    if (provider.supportsFolderNavigation === false) return
    setFolderStack((current) => [...current, { id: folder.remoteItemId, name: folder.name }])
    setSelectedFolder(null)
    void loadFolders(folder.remoteItemId)
  }

  function goBack(): void {
    if (folderStack.length <= 1) return
    const nextStack = folderStack.slice(0, -1)
    setFolderStack(nextStack)
    setSelectedFolder(null)
    void loadFolders(nextStack[nextStack.length - 1].id)
  }

  if (!isOpen) return null

  return (
    <Modal>
      <Modal.Backdrop isOpen onOpenChange={onClose} isDismissable>
        <Modal.Container size="sm">
          <Modal.Dialog className="p-5">
            <Modal.Header>
              <Modal.Heading>
                <span className="flex items-center gap-2">
                  {provider.icon}
                  {t('fileExplorer.cloudFolderPicker.title', {
                    provider: provider.displayName
                  })}
                </span>
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <ShortcutScope name="overlay">
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm text-muted">
                    {provider.supportsFolderNavigation !== false && (
                      <Button
                        size="sm"
                        variant="tertiary"
                        isDisabled={folderStack.length <= 1 || isLoading || isImporting}
                        onPress={goBack}
                        aria-label={t('fileExplorer.cloudFolderPicker.back')}
                      >
                        <ArrowLeft size={16} />
                      </Button>
                    )}
                    <span className="truncate">{currentFolder.name}</span>
                  </div>

                  {incomplete && (
                    <div role="status" className="text-sm text-muted">
                      {t('fileExplorer.cloudFolderPicker.incomplete')}
                      <Button
                        size="sm"
                        variant="tertiary"
                        isDisabled={isLoading || isImporting}
                        onPress={() => void loadFolders(currentFolder.id)}
                      >
                        {t('fileExplorer.cloudFolderPicker.retry')}
                      </Button>
                    </div>
                  )}
                  <div className="min-h-60 rounded-2xl bg-surface-secondary p-2">
                    {isLoading ? (
                      <div className="flex h-56 items-center justify-center text-muted">
                        <Loader2 size={20} className="animate-spin" />
                      </div>
                    ) : error ? (
                      <div className="flex h-56 items-center justify-center text-sm text-danger">
                        {error}
                      </div>
                    ) : folders.length === 0 ? (
                      <div className="flex h-56 items-center justify-center text-sm text-muted">
                        {t('fileExplorer.cloudFolderPicker.empty')}
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {folders.map((folder) => {
                          const isSelected = selectedFolder?.remoteItemId === folder.remoteItemId
                          return (
                            <button
                              key={folder.remoteItemId}
                              type="button"
                              className={[
                                'flex w-full min-w-0 items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm',
                                isSelected
                                  ? 'bg-accent text-accent-foreground'
                                  : 'hover:bg-accent hover:text-accent-foreground'
                              ].join(' ')}
                              onClick={() => setSelectedFolder(folder)}
                              onDoubleClick={() => openFolder(folder)}
                            >
                              <Folder size={16} className="shrink-0" />
                              <span className="truncate">{folder.name}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </ShortcutScope>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" isDisabled={isImporting} onPress={onClose}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                isDisabled={!selectedFolder || isLoading || isImporting}
                onPress={() => {
                  if (selectedFolder) onImport(selectedFolder)
                }}
              >
                {isImporting ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  t('fileExplorer.cloudFolderPicker.import')
                )}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
