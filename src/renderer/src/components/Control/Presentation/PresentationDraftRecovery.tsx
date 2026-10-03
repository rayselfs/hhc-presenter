import { useEffect, useState } from 'react'
import { Button } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  listPresentationDrafts,
  type PresentationDraftRecord
} from '@renderer/lib/presentation-drafts'
import { getPresentationWorkspacePath } from '@renderer/lib/presentation-media'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'

export default function PresentationDraftRecovery(): React.JSX.Element | null {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const ownerId = usePersonalSyncStore((state) => state.activeOwnerId)
  const [drafts, setDrafts] = useState<PresentationDraftRecord[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    let cancelled = false
    void listPresentationDrafts()
      .then((records) => {
        if (!cancelled) setDrafts(records)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [ownerId])
  if (error)
    return (
      <p role="alert">
        {t('presentationWorkspace.recoveryFailed', 'Unable to load recovered presentations')}
      </p>
    )
  const visible = drafts.filter(
    (draft) => !draft.item.personalOwnerId || draft.item.personalOwnerId === ownerId
  )
  if (!visible.length) return null
  return (
    <aside
      className="m-3 flex flex-wrap items-center gap-2 rounded-lg border border-warning p-3"
      aria-label={t('presentationWorkspace.recoveredDrafts', 'Unsaved presentations')}
    >
      <span className="text-sm">
        {t('presentationWorkspace.recoveredDrafts', 'Unsaved presentations')}
      </span>
      {visible.map((draft) => (
        <Button
          key={draft.id}
          variant="tertiary"
          onPress={() => {
            usePresentationWorkspaceStore.getState().openDocument(draft.item)
            navigate(getPresentationWorkspacePath(draft.id))
          }}
        >
          {draft.item.name}
        </Button>
      ))}
    </aside>
  )
}
