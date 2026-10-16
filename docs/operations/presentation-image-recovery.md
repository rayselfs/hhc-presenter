# Preserving a presentation rejected by image validation

The editor accepts PNG, JPEG, GIF, BMP and WebP images up to 20 MiB per asset. Insertion and every document write use the same policy as the loader. Rejection must leave the previous saved body, revision and recoverable draft intact. This change does not rewrite older documents or restore bytes already overwritten by an older version.

## Preserve evidence before recovery

1. Keep the original PPTX and any known-good presentation backup. Do not delete the failing item, clear app data, unlink its source, or run storage cleanup as a recovery step.
2. Back up the complete Electron application data directory while the app is closed, or export the affected Browser origin's IndexedDB data with the browser's storage tools. Include `hhc-file-explorer` and native media files when applicable. Do not copy only catalog metadata: it references separately stored bytes.
3. For a targeted local export, an operator can run the following in the affected control window's DevTools after replacing `itemId`. It only reads storage and downloads a copy; it does not edit the catalog, draft or source. Keep the exported file private because it contains the document's embedded content.

```js
const itemId = 'REPLACE_WITH_AFFECTED_ITEM_ID'
const result = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})
const db = await result(indexedDB.open('hhc-file-explorer'))
let backup
try {
  const tx = db.transaction(['folder-items', 'file-blobs', 'presentation-drafts'], 'readonly')
  const item = await result(tx.objectStore('folder-items').get(itemId))
  if (item) {
    if (!item.url.startsWith('blob:')) throw new Error('Unsupported source URL')
    const record = await result(tx.objectStore('file-blobs').get(item.url.slice(5)))
    if (!record) throw new Error('Source record is missing; preserve the full profile backup')
    if (record.storage === 'native-fs') {
      const response = await fetch(window.api.nativeFs.getUrl(record.id, item.mimeType))
      if (!response.ok) throw new Error('Native source could not be read')
      backup = await response.blob()
    } else {
      backup = record.blob
    }
  } else {
    const draft = await result(tx.objectStore('presentation-drafts').get(itemId))
    if (!draft) throw new Error('No saved item or draft found')
    backup = new Blob([JSON.stringify(draft.document)], { type: 'application/json' })
  }
} finally {
  db.close()
}
if (!backup) throw new Error('Source bytes are unavailable')
const url = URL.createObjectURL(backup)
const link = document.createElement('a')
link.href = url
link.download = `${itemId}.original.presenter.json`
link.click()
setTimeout(() => URL.revokeObjectURL(url), 60000)
```

## Recover a separate document

Prefer reopening a known-good backup or creating a new editable copy from the retained original PPTX. Replace unsupported source images with PNG/JPEG/WebP within the limit before conversion. Verify all slides and image placements, save, close and reopen the new document before retiring any original.

If the only surviving document is the rejected JSON, repair a copy under engineering supervision: preserve all slide/element/asset IDs, replace each rejected asset with an approved raster equivalent, and run `validatePortablePresentation` on the complete document. Do not merely relabel SVG/AVIF bytes as PNG or relax the loader. Persist the repaired copy through `createEditablePresentationItem` with a new document ID and a distinct name; never write directly over the original Blob ID. Verify save/reload and visual fidelity before considering recovery complete. Unrecoverable source bytes or missing originals must remain explicitly reported; this fix cannot reconstruct them.
