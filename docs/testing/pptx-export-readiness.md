# Editable PPTX export readiness

> Historical PR #96 design/evidence, retained from source `4eaa86b4`. Test counts and release gates below describe that earlier branch, not the integrated main. See [the integration record](/docs/reports/2026-10-30-pr96-integration.md) for current scope, validation and remaining acceptance.

## Scope and behavior

The editable workspace can download its current document as `.pptx` in browser and Electron. Export finalizes and flushes unsaved text first; `.lpdeck` saving remains available. Account changes, tab/session changes, close/reopen, unmount or active composition cancel a pending download. Export never changes projection ownership or its current slide.

Native/v1 documents generate a blank master/layout and explicit supported DrawingML. Validated source-backed v2 documents return the original bytes on a visual no-op; edited documents patch owned properties and retain unrelated package members, source relationships, metadata and inheritance. Ordinary PPTX import still writes v1. This batch does not enable v2 writes or deploy the companion API validator.

Supported content includes ordered slides, solid/linear-gradient backgrounds, text/run/paragraph formatting, lists, empty paragraphs, notes, rectangle/ellipse/line geometry, rotation/opacity, images with crop/border/known shadows, and PNG/JPEG/GIF/BMP bytes. WebP is bounded and converted to PNG. SVG currently fails the portable document contract and remains a later capability. Locked/unsupported content returns an error before download.

Source shapes with separate text/geometry roles can be moved, split, reordered or deleted independently. Copies/new objects receive independent identities. Frame edits preserve unmodified flips and opaque transform attributes. Editing a retained `normAutofit` text payload or its width/height freezes the model's effective run/empty-paragraph font sizes, avoiding Office recomputation; no-op and pure position edits preserve original autofit. Nonzero source line-spacing reduction or unknown autofit metadata returns a located conflict. Aggregate source notes with multiple contributing text shapes likewise remain unchanged or reject ambiguous edits.

Limits remain 209715200 portable bytes, 4000 archive entries, 32 MiB per expanded member, 256 MiB total expanded content, 192 MiB media, XML depth 128, and rasterization at most 8192 pixels per axis / 16777216 pixels total. Every completed archive is validated before creating the download Blob. No new production dependency was added; adapted DeckCraft v0.5.0 DrawingML ordering has pinned MIT attribution.

## Verification on 2026-10-12

- Repository lint passed without warnings; both typechecks, desktop build, web build and bundle checks passed.
- Full Vitest: 306 suites / 3665 tests passed. Source export regressions cover no-op bytes, unrelated-member equality, role ownership, fields, omitted inheritance, whitespace, media dependencies, note conflicts, fixed effective fonts and unmodified flips.
- Built browser: 25 affected E2Es passed (25.3 s), covering actual native/source downloads, edit/save/reopen, undo/redo, projection ownership, import/rendering and text editing. A source autofit fixture uses the normal toolbar and downloads a 50-point edit.
- Built macOS Electron: one isolated acceptance flow passed (7.2 s), covering native and source no-op/edited/projection-active downloads, local reopen and projection ownership. Its task-owned userData and download paths were removed; the user's profile/downloads were not used.
- LibreOfficeDev 26.8.0.0.alpha0 read the actual UI downloads in an isolated profile. Eight hymn exports retained 22 pages and exact expected text/line counts. Native maximum unchanged line-bound deviation was 0.057 points; retained-source unchanged pages deviated by 0. Actual PDF font families matched the original comparison baseline.
- The source font requested Noto Sans TC. A process-only fontconfig environment produced HiraginoSansGB-W6/HiraginoSans-W7; this is a relative comparison, not exact original-font acceptance. The edited autofit fixture rendered 50.003 points for a 50-point toolbar request, with both original text lines intact.
- Independent rendered/vector checks passed for image crop, picture border, medium shadow, linear gradient, rotated transparent rectangle, ellipse, line and empty text paragraph. Office read/write retained both focus-note lines.
- One fresh whole-branch reviewer found four issues, all fixed with RED/GREEN regressions and focused closure. Additional consumer evidence invalidated the initial inverse-scale approach; the fixed effective-font correction was reviewed and independently verified without relaxing the text/geometry bounds.

Durable evidence is at `/Users/rayselfs/.codex/visualizations/2026/10/11/01a12b4f-88d0-7980-82da-40c2abb5b65f/deckcraft-pptx-export-acceptance-20261012/`: actual downloads, PDFs, screenshots, input/output hashes, `consumer-results.json`, self-check script, fontconfig, logs and execution ledger.

## Remaining goal and deployment scope

This verifies the supported export foundation, not complete PowerPoint parity or the five-phase DeckCraft reference goal. Broader import diagnostics, advanced objects, editable masters/layouts, playback and platform verification remain. Ordinary import/API contracts remain unchanged. Remote CI, merge, deployment, release, Microsoft PowerPoint, physical Windows/projector/input-method and large-deck performance acceptance have not been performed for this batch.
