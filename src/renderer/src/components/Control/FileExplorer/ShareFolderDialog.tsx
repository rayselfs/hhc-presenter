import { useEffect, useMemo, useState } from 'react'
import { Button } from '@heroui/react/button'
import { Input } from '@heroui/react/input'
import { Label } from '@heroui/react/label'
import { Modal } from '@heroui/react/modal'
import { TextField } from '@heroui/react/textfield'
import { Trash2 } from 'lucide-react'
import type { FolderRecord } from '@shared/types/folder'
import type { PersonalFolderGrant } from '@shared/personal-cloud'
import type { PresenterAccountLabel } from '@shared/hhc-auth'
import type { HhcLineCloudAuth } from '@renderer/lib/cloud-provider'
import { createPersonalCloudProvider } from '@renderer/lib/personal-cloud-provider'
import {
  resolvePersonalAccountLabels,
  resolvePersonalShareTarget
} from '@renderer/lib/personal-share-account'
import { useTranslation } from 'react-i18next'

export function ShareFolderDialog({
  folder,
  auth,
  onClose
}: {
  folder: FolderRecord | null
  auth: HhcLineCloudAuth
  onClose(): void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [target, setTarget] = useState<PresenterAccountLabel | null>(null)
  const [shares, setShares] = useState<PersonalFolderGrant[]>([])
  const [labels, setLabels] = useState<Record<string, PresenterAccountLabel>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ownerId = folder?.personalOwnerId
  const api = useMemo(
    () => (ownerId ? createPersonalCloudProvider(auth, ownerId) : null),
    [auth, ownerId]
  )

  useEffect(() => {
    if (!folder || !api) return
    let active = true
    void api
      .listFolderShares(folder.id)
      .then(async (next) => {
        if (!active) return
        setShares(next)
        if (!next.length) return
        const accounts = await resolvePersonalAccountLabels(
          auth,
          next.map((share) => share.granteeUserId)
        )
        if (active)
          setLabels(Object.fromEntries(accounts.map((account) => [account.userId, account])))
      })
      .catch(
        (reason) => active && setError(reason instanceof Error ? reason.message : String(reason))
      )
    return () => {
      active = false
    }
  }, [api, auth, folder])

  if (!folder || !api) return null

  const resolve = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setTarget(await resolvePersonalShareTarget(auth, email.trim()))
    } catch (reason) {
      setTarget(null)
      setError(
        reason && typeof reason === 'object' && 'status' in reason && reason.status === 404
          ? t('personalShare.notFound')
          : t('personalShare.failed')
      )
    } finally {
      setBusy(false)
    }
  }

  const share = async (): Promise<void> => {
    if (!target) return
    setBusy(true)
    setError('')
    try {
      const grant = await api.createFolderShare(folder.id, target.userId)
      setShares((current) => [...current.filter((item) => item.id !== grant.id), grant])
      setLabels((current) => ({ ...current, [target.userId]: target }))
      setEmail('')
      setTarget(null)
    } catch {
      setError(t('personalShare.failed'))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (grant: PersonalFolderGrant): Promise<void> => {
    setBusy(true)
    try {
      await api.revokeFolderShare(folder.id, grant.id)
      setShares((current) => current.filter((item) => item.id !== grant.id))
    } catch {
      setError(t('personalShare.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal>
      <Modal.Backdrop isOpen onOpenChange={onClose} isDismissable>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>{t('personalShare.title', { name: folder.name })}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <div className="flex items-end gap-2">
                <TextField value={email} onChange={setEmail} className="flex-1">
                  <Label>{t('personalShare.email')}</Label>
                  <Input type="email" variant="secondary" />
                </TextField>
                <Button
                  variant="secondary"
                  isDisabled={busy || !email.trim()}
                  onPress={() => void resolve()}
                >
                  {t('personalShare.find')}
                </Button>
              </div>
              {target && (
                <div className="flex items-center justify-between rounded-xl bg-default-100 p-3">
                  <div>
                    <div>{target.displayName}</div>
                    <div className="text-sm text-muted">{target.email}</div>
                  </div>
                  <Button variant="primary" isDisabled={busy} onPress={() => void share()}>
                    {t('personalShare.confirm')}
                  </Button>
                </div>
              )}
              {error && <p className="text-sm text-danger">{error}</p>}
              {shares.map((grant) => (
                <div
                  key={grant.id}
                  className="flex items-center justify-between border-t border-default-200 pt-3"
                >
                  <span>
                    {labels[grant.granteeUserId]?.displayName ?? t('personalShare.account')}
                  </span>
                  <Button
                    isIconOnly
                    variant="tertiary"
                    aria-label={t('personalShare.revoke')}
                    isDisabled={busy}
                    onPress={() => void revoke(grant)}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              ))}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" onPress={onClose}>
                {t('common.close')}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
