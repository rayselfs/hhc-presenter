# PPTX theme line readiness

> Historical PR #96 design/evidence, retained from source `4eaa86b4`. Test counts and release gates below describe that earlier branch, not the integrated main. See [the integration record](/docs/reports/2026-10-30-pr96-integration.md) for current scope, validation and remaining acceptance.

## Scope and selection

This bounded improvement fixes inherited solid outlines in existing editable PPTX import. DeckCraft v0.5.0 line inheritance is a reference; feature parity is not the target. Local paint, width and other line properties override theme properties independently. Admission and conversion share the renamed `pptx-shape-style.ts` resolver. Unsupported effective gradients, dashes, endpoints and unrepresentable line styles produce located compatibility errors.

Normal v1 and explicit v3 conversion use the correction. Retained-source v2 behavior, default writers, schemas and Asset API are unchanged. No dependency was added. Already gated work remains gated. The user's 2026-10-13 scope correction in the main design supersedes historical expansion queues: improve existing workflows and add only small capabilities with demonstrated value. Full table/chart editors, master designers, complex animation, more presets and a dedicated hairline model are deferred.

## Local verification

- Final corrected product: 310 suites / 3950 tests passed (170.39 seconds); focused import suite 111/111. Node/web typechecks and full lint passed.
- Web and desktop builds and bundle checks passed.
- Browser: eight import, source, export and projection flows passed (17.4 seconds), including the original 22-slide hymn and solid-fill/line fixtures.
- Isolated macOS Electron: two flows passed (12.0 seconds), covering hymn downloads and both theme fixtures through import, saved reopen and projection. Owned userData profiles were verified and removed after application exit.
- After the onboarding helper correction, both browser theme flows passed again (2/2, 3.7 seconds); scoped E2E lint passed.
- The first Electron run exposed a test lifecycle error: onboarding was called again for the second fixture. Onboarding now runs once per application session. Product code was unchanged; the failed log is retained.
- Independent LibreOffice: five supported original/native pairs (theme-only, local width, local color, no fill and alpha) have matching PDF line widths, colors and alpha.

LibreOffice expresses LineWidth in integer 1/100 mm units, so expected PDF width is `round(cssPx * 2540 / 96) * 72 / 2540`, with the original 0.01 pt residual tolerance. Source/native measurements must still match exactly. See [official LineProperties documentation](https://api.libreoffice.org/docs/idl/ref/servicecom_1_1sun_1_1star_1_1drawing_1_1LineProperties.html).

## Known limitation discovered during acceptance

A painted OOXML width of zero is a visible device hairline, while the existing HHC zero-width model means no stroke. Independent Office comparison exposed this loss. Strict editable admission now rejects painted zero-width lines, including local and inherited cases. Explicit noFill remains supported. The original source PDF, initial lossy native output and initial measurement failure are retained; this is five positive consumer cases plus one explicit unsupported case, not six parity passes.

## Fixture and evidence

Synthetic fixture `src/renderer/src/lib/__fixtures__/pptx/theme-solid-line.pptx` contains a red rectangle with a referenced red 10 px outline and no local line. SHA-256: `7f147cc98b930c1d5973ea46a18764ecfdb0baf22fefc5008c4c12881839c886`.

Logs, probes, original/native PPTX/PDF files and this report are archived with a SHA-256 manifest at `/Users/rayselfs/.codex/visualizations/2026/10/11/01a12b4f-88d0-7980-82da-40c2abb5b65f/deckcraft-pptx-theme-line-20261013`.

No push, PR, merge, deployment or release was performed. Microsoft PowerPoint, physical Windows/projector and authenticated deployed cloud acceptance remain unverified. Both isolated worktrees are retained.
