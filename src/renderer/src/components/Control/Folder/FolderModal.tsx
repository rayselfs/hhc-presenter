import React from 'react'
import { Button } from '@heroui/react/button'
import { Input } from '@heroui/react/input'
import { Modal } from '@heroui/react/modal'
import { TextField } from '@heroui/react/textfield'
import { Label } from '@heroui/react/label'
import { Select } from '@heroui/react/select'
import { ListBox } from '@heroui/react/list-box'
import { Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FolderDuration, FolderRecord } from '@shared/types/folder'
import { ShortcutScope } from '@renderer/contexts/ShortcutScopeContext'

export interface FolderModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: () => void | Promise<void>
  editingFolder: FolderRecord | null
  folderName: string
  onFolderNameChange: (name: string) => void
  folderDuration: FolderDuration
  onFolderDurationChange: (duration: FolderDuration) => void
  isSubmitting?: boolean
  isRetentionLocked?: boolean
  hideDuration?: boolean
  i18nPrefix?: string
}

const DEFAULT_I18N_PREFIX = 'folder'

export function FolderModal({
  isOpen,
  onClose,
  onSubmit,
  editingFolder,
  folderName,
  onFolderNameChange,
  folderDuration,
  onFolderDurationChange,
  isSubmitting = false,
  isRetentionLocked,
  hideDuration,
  i18nPrefix
}: FolderModalProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const p = i18nPrefix ?? DEFAULT_I18N_PREFIX

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tKey = (key: string, fallback?: string): string => (t as any)(`${p}.${key}`, fallback)

  if (!isOpen) return null

  return (
    <Modal>
      <Modal.Backdrop
        isOpen
        onOpenChange={() => {
          if (!isSubmitting) onClose()
        }}
        isDismissable={!isSubmitting}
        isKeyboardDismissDisabled={isSubmitting}
      >
        <Modal.Container size="sm">
          <Modal.Dialog className="p-3 pl-5 pt-5">
            <Modal.Header>
              <Modal.Heading>
                {editingFolder
                  ? tKey('editFolder', 'Edit Folder')
                  : tKey('createNewFolder', 'Create New Folder')}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body aria-busy={isSubmitting}>
              <ShortcutScope name="overlay">
                <div className="flex flex-col gap-3">
                  <TextField
                    autoFocus
                    isDisabled={isSubmitting}
                    value={folderName}
                    onChange={onFolderNameChange}
                    className="w-full p-1"
                    onKeyDown={(e) => {
                      if (!isSubmitting && e.key === 'Enter' && !e.nativeEvent.isComposing)
                        void onSubmit()
                    }}
                    onFocus={(e) => (e.target as HTMLInputElement).select()}
                  >
                    <Label>{tKey('folderName', 'Folder Name')}</Label>
                    <Input variant="secondary" />
                  </TextField>
                  {!hideDuration && (
                    <div className="p-1">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Label className="text-sm">{tKey('retention', 'Retention')}</Label>
                        {isRetentionLocked && <Lock size={12} className="text-default-400" />}
                      </div>
                      <Select
                        value={folderDuration}
                        onChange={(v) => onFolderDurationChange(v as FolderDuration)}
                        aria-label={tKey('retention', 'Retention')}
                        className="w-full"
                        variant="secondary"
                        isDisabled={isRetentionLocked || isSubmitting}
                      >
                        <Select.Trigger>
                          <Select.Value />
                          <Select.Indicator />
                        </Select.Trigger>
                        <Select.Popover>
                          <ListBox>
                            {(['1day', '1week', '1month', 'permanent'] as FolderDuration[]).map(
                              (d) => (
                                <ListBox.Item
                                  key={d}
                                  id={d}
                                  textValue={tKey(`duration.${d}`)}
                                  className="data-[hovered=true]:bg-accent data-[hovered=true]:text-accent-foreground"
                                >
                                  {tKey(`duration.${d}`)}
                                  <ListBox.ItemIndicator />
                                </ListBox.Item>
                              )
                            )}
                          </ListBox>
                        </Select.Popover>
                      </Select>
                    </div>
                  )}
                </div>
              </ShortcutScope>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" onPress={onClose} isDisabled={isSubmitting}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button variant="primary" onPress={() => void onSubmit()} isDisabled={isSubmitting}>
                {t('common.confirm', 'Confirm')}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
