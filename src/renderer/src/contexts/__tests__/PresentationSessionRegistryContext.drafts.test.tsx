import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { act, render } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import {
  PresentationSessionRegistryProvider,
  usePresentationSessionRegistry,
  type PresentationSessionRegistry
} from '../PresentationSessionRegistryContext'
import {
  createBlankEditablePresentationDocument,
  loadEditablePresentationSnapshot
} from '@renderer/lib/editable-presentation'
import { createPresentationDraft, getPresentationDraft } from '@renderer/lib/presentation-drafts'
import { resetFileExplorerDBForTests, openFileExplorerDB } from '@renderer/lib/file-explorer-db'
import { usePresentationWorkspaceStore } from '@renderer/stores/presentation-workspace'
import { usePersonalSyncStore } from '@renderer/stores/personal-sync'
import type { FileItemRecord } from '@shared/types/folder'

let registry: PresentationSessionRegistry
function Harness({
  onRegistry
}: {
  onRegistry: (value: PresentationSessionRegistry) => void
}): null {
  onRegistry(usePresentationSessionRegistry())
  return null
}
afterEach(() => vi.unstubAllGlobals())
beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  await resetFileExplorerDBForTests()
  usePersonalSyncStore.setState({ activeOwnerId: null })
  usePresentationWorkspaceStore.setState({ documents: [], activeItemId: null })
})
const source: FileItemRecord = {
  id: 'source',
  parentId: 'sync',
  type: 'file',
  name: 'Original.pptx',
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  url: 'blob:source',
  size: 1,
  sortIndex: 0,
  createdAt: 1,
  expiresAt: null
}

it('checkpoints and projects a draft without saving it, then resumes autosave after Save As', async () => {
  const item = await createPresentationDraft(
    source,
    createBlankEditablePresentationDocument('Copy')
  )
  usePresentationWorkspaceStore.getState().openDocument(item)
  render(
    <PresentationSessionRegistryProvider>
      <Harness
        onRegistry={(value) => {
          registry = value
        }}
      />
    </PresentationSessionRegistryProvider>
  )
  await act(async () => {
    const session = await registry.open(item)
    session.rename('Edited', 'Edited')
    await registry.checkpointAll?.()
    expect(await registry.finalizeAndFlush(item.id)).not.toBeNull()
    expect(await registry.close(item.id)).toBe(false)
    await expect(registry.flushAll()).rejects.toThrow(/destination/)
  })
  expect(usePresentationWorkspaceStore.getState().getActiveDocument()?.isUnsaved).toBe(true)
  expect((await getPresentationDraft(item.id))?.document.name).toBe('Edited')
  await act(async () => {
    await registry.saveDraft?.(item.id, 'file-root', 'Saved')
  })
  expect(usePresentationWorkspaceStore.getState().getActiveDocument()?.isUnsaved).toBe(false)
  expect(await getPresentationDraft(item.id)).toBeNull()
  await act(async () => {
    registry.get(item.id)!.rename('Updated', 'Updated')
    await registry.flushAll()
  })
  expect((await loadEditablePresentationSnapshot(item)).document.name).toBe('Updated')
})

it('requires a close decision even when the draft has never been edited; discard removes recovery', async () => {
  const item = await createPresentationDraft(
    source,
    createBlankEditablePresentationDocument('Copy')
  )
  usePresentationWorkspaceStore.getState().openDocument(item)
  render(
    <PresentationSessionRegistryProvider>
      <Harness
        onRegistry={(value) => {
          registry = value
        }}
      />
    </PresentationSessionRegistryProvider>
  )
  await act(async () => {
    await registry.open(item)
    expect(await registry.close(item.id)).toBe(false)
    expect(await registry.close(item.id, 'keep-editing')).toBe(false)
    expect(await registry.close(item.id, 'discard')).toBe(true)
  })
  expect(await getPresentationDraft(item.id)).toBeNull()
  expect(await (await openFileExplorerDB()).get('folder-items', item.id)).toBeUndefined()
})
