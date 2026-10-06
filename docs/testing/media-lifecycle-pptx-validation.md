# PPTX browser rendering validation

Validated on 2026-10-06 with Chromium using `e2e/presentation-rendering-fidelity.spec.ts` and the built browser application.

The test derives a two-page real OOXML deck from the existing `text-placeholder-layout.pptx` fixture and adds an image and embedded MP4 with poster. It exercises file import, Open Presentation, projection popup, and presenter page navigation rather than injecting application state.

Observed and asserted:

- Chinese and English slide text renders; the requested CSS font stack includes Noto Sans TC. This does not prove that font is installed or that fallback glyph metrics match PowerPoint.
- The image decodes, is visible, and retains its requested 16:9 shape geometry.
- Page count is two; operator and audience advance to the same second-page content.
- The embedded-video fixture displays the same static poster/play symbol on operator and audience. It creates no video element in this imported presentation, and synchronized embedded-media playback is not supported by this evidence.
- The captured 1280×720 audience screenshots were visually inspected: text and image/poster remain within the slide; no diagnostic UI appears on the audience surface.

The test attaches both screenshots and a JSON observation record to the Playwright HTML report. It intentionally records the current static embedded-media boundary. Basic slide rendering does not establish PowerPoint-equivalent fonts, animation, transitions, or embedded audio/video transport. Use a separate video item when playback controls are needed. Native Windows/macOS and physical-projector acceptance remain separate checks.
