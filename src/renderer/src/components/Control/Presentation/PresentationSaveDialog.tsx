import { useEffect, useState } from 'react'
import { AlertDialog, Button } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import type { FolderRecord } from '@shared/types/folder'
import { openFileExplorerDB } from '@renderer/lib/file-explorer-db'
import { assertWritablePresentationFolder } from '@renderer/lib/presentation-drafts'
import { usePresentationSessionRegistry } from '@renderer/contexts/PresentationSessionRegistryContext'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'

export default function PresentationSaveDialog({
  itemId,
  onSaved,
  onCancel
}: {
  itemId: string
  onSaved: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const registry = usePresentationSessionRegistry()
  const owner = usePersonalSyncStore((state) => state.activeOwnerId)
  const [name, setName] = useState(
    () =>
      usePresentationWorkspaceStore.getState().documents.find((entry) => entry.itemId === itemId)
        ?.name ?? ''
  )
  const [parentId, setParentId] = useState('file-root')
  const [folders, setFolders] = useState<FolderRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    void openFileExplorerDB()
      .then((db) => db.getAll('folder-records'))
      .then((all) => {
        if (cancelled) return
        setFolders(
          all.filter((folder) => {
            try {
              assertWritablePresentationFolder(folder.id, all, owner)
              return true
            } catch {
              return false
            }
          })
        )
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [owner])
  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (!registry.saveDraft) throw new Error('Presentation save is unavailable')
      await registry.saveDraft(itemId, parentId, name)
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const folderPath = (folder: FolderRecord): string => {
    const parts = [folder.name]
    let parent = folders.find((entry) => entry.id === folder.parentId)
    const visited = new Set([folder.id])
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id)
      parts.unshift(parent.name)
      parent = folders.find((entry) => entry.id === parent?.parentId)
    }
    return parts.join(' / ')
  }
  return (
    <AlertDialog.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
      isDismissable={false}
      isKeyboardDismissDisabled={busy}
    >
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Heading>
              {t('presentationWorkspace.saveDraftTitle', 'Save presentation')}
            </AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <div className="grid gap-3">
              <label className="grid gap-1">
                {t('presentationWorkspace.draftName', 'Name')}
                <input
                  className="rounded border border-border bg-background p-2"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="grid gap-1">
                {t('presentationWorkspace.draftLocation', 'Location')}
                <select
                  className="rounded border border-border bg-background p-2"
                  value={parentId}
                  onChange={(event) => setParentId(event.target.value)}
                  disabled={busy}
                >
                  <option value="file-root">
                    {t('presentationWorkspace.localFiles', 'Local files')}
                  </option>
                  {folders
                    .filter((folder) => folder.id !== 'file-root')
                    .map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folderPath(folder)}
                      </option>
                    ))}
                </select>
              </label>
              {error && (
                <p role="alert" className="text-danger">
                  {error}
                </p>
              )}
            </div>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="tertiary" isDisabled={busy} onPress={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" isDisabled={busy || !name.trim()} onPress={() => void save()}>
              {t('common.save', 'Save')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  )
}
