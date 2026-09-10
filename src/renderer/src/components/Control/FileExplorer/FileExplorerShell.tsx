import React from 'react'
import { useTranslation } from 'react-i18next'
import GlassDivider from '@renderer/components/Common/GlassDivider'

export interface FileExplorerShellProps {
  children: React.ReactNode
  itemCount: number
  selectedCount: number
  endContent?: React.ReactNode
}

export default function FileExplorerShell({
  children,
  itemCount,
  selectedCount,
  endContent
}: FileExplorerShellProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="relative flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>

      <GlassDivider />
      <div className="flex items-center px-3 py-1.5 shrink-0 text-xs text-foreground/50">
        {t('fileExplorer.status.itemCount', {
          count: itemCount,
          defaultValue: `${itemCount} item(s)`
        })}
        {selectedCount > 0 && (
          <>
            <span className="mx-1">·</span>
            {t('fileExplorer.status.selectedCount', {
              count: selectedCount,
              defaultValue: `${selectedCount} selected`
            })}
          </>
        )}
        {endContent && <div className="ml-auto">{endContent}</div>}
      </div>
    </div>
  )
}
