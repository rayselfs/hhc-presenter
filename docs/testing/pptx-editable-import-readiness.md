# Editable PPTX import readiness

## Scope

Local PPTX uploads become a single editable `.lpdeck` item. The external source
file is not modified. Editing does not require an extra copy. Existing raw PPTX
items and read-only synced sources retain their original-source workflow.

Primary acceptance corpus: song slides modified July–September 2026, especially
black backgrounds, white text and 標楷體. Preserve requested font names and allow
later editing; exact font rasterization is not an acceptance gate for this change.
The production target is Windows with 標楷體 installed.

## Findings and changes

| Failure | Cause | Change |
| --- | --- | --- |
| Persistent import panel under header | Page-local import summary lived beyond the operation | Existing bottom-right toast hosts progress/cancel, timed success, persistent retryable failure |
| Upload requires making an editable copy | Upload persisted only the raw PPTX | Validate and convert before publishing one editable item |
| F5 ignored while typing | Global shortcut dispatcher discarded editable targets | Explicit save/projection shortcuts finalize and flush the active text edit |
| First slide says projection ended | Next preview checked next file rather than next slide | Preview current deck's next slide; show loading before page count is known |
| Background/text layout changed | Incorrect background field and incomplete master/layout inheritance | Inherit background, color aliases, text styles, paragraph layout, insets, vertical alignment and autofit scaling |
| Old load erases new deck | Late viewer cleanup shared the same DOM container | Give each open its own abortable host |
| Retrying the same slide stays preparing | Ready callback did not depend on content revision | Acknowledge each revision; reopen failed viewers while reusing healthy viewers |
| Projection ready before resources | Editable surface acknowledged before fonts/images loaded | Wait for font readiness and image decode; discard stale acknowledgements |

PPTX/LPDECK projects as a single deck. Image/video/PDF projection excludes all
presentation items in the same folder. Page visits alone do not claim projection.

## Conversion boundary

Editable import rejects known unsupported content before creating a catalog item:
animations, transitions, embedded audio/video, unsupported shapes/fills, visible
unsupported inherited decorations, unsupported text directions/columns, and
meaningful unsupported slide color-map overrides. This avoids reporting success
while dropping known content. It is not a promise of full PowerPoint feature parity.
Use the original file in PowerPoint when conversion is rejected.

Parallel upload workers serialize name selection and item creation within their
renderer. This is not cross-window name locking. Local catalog/blob creation uses
the existing persistence transaction and rollback path.

## Evidence

- Private OneDrive corpus: 16 presentations, 187 slides imported, persisted and
  reopened. Source files and lyric contents are not committed to this repository.
- `npm run lint`, `npm run build:web`, and `npm run build` passed.
- Full unit run after correcting sidebar fixtures: 300 suites and 3,526 tests passed.
- Built Chromium application: 12 focused end-to-end tests passed, including
  direct editable import, focused F5, all 22 pages, save/reload, raw PPTX page
  navigation, popup recovery, and mixed-folder playlist separation.
- Full browser suite initially reported 60 passed, 2 skipped and 4 failures from
  stale import-banner / ambiguous Close locators. Updated those assertions for
  the real toast and dedicated media close control; all 4 affected tests passed
  in a scoped Chromium rerun, including progress across navigation, cancellation,
  success auto-dismiss, failure retry without duplicate files, and media cleanup.
- A real 13-page black/white sample was imported in the built browser, edited
  while focused, projected with F5 and advanced to page 13; the next preview
  showed slide 2 at the beginning and the end only on page 13.
- Local macOS Electron IPC smoke passed: import, focused F5, all 22 pages, stop,
  save and reopen. It used the built app with a local Electron executable, not a
  release package.
- Native PowerPoint exported temporary copies for reference; source files were
  untouched. This Mac substituted the requested font, so its export is not a
  Windows font-parity reference.

## Remaining release checks

Windows packaged smoke and physical-projector acceptance have not been performed
from this Mac session. The packaged regression is runnable on a built application:

```powershell
$env:PACKAGED_APP_PATH = 'C:\path\to\HHC Presenter.exe'
npm run test:e2e:packaged -- --grep 'PPTX editable import'
```

On the intended Windows machine, import a black/white song deck, edit/save/reopen,
press F5 while typing, advance through every slide, stop/restart projection, and
confirm the separate media playlist. No deployment or release is implied by this
local verification record.

## Release follow-up (2026-10-10)

The v2.6.8 Windows packaged smoke completed import, focused F5, all 22 slides and
save/reload, then failed when the test clicked a thumbnail hidden by the compact
layout. The failure screenshot showed the edited opening slide and slide 1 / 22.
The same failure was reproduced locally at a 1000 px viewport. The regression now
asserts the restored selection and visible edited content without clicking the
hidden navigator; the focused local Electron smoke passes at that viewport.
The v2.6.8 macOS packaged smoke passed, but the desktop release was not published
because the Windows gate failed. The immutable tag is retained; v2.6.9 repeats
all CI and packaged release gates with the corrected regression.
