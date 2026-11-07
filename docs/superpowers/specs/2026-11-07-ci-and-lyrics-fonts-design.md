# CI efficiency and lyrics typography

Version: 2.8.3. Engineering issue: #204.

## Final behavior

- Reuse bundled Noto Sans TC/SC, Inter, Roboto and system fonts. Automatically enumerate installed desktop fonts; reuse browser permission or request access from the searchable picker. Permission failure retains bundled choices. Local font bytes are never uploaded.
- Persist bold on/off and crop preferences with migration preserving existing settings. Use identical font loading and weight for projected text and overflow measurements. Validate font names at the shared message boundary.
- Subtitle mode hides only the original camera editor. Keep source video and the blue recognition rectangle in the subtitle area. Recognition height defaults to the upper 40% and stays adjustable without restarting OCR; discard stale in-flight results after crop changes.
- Rely on automatic OCR. Show crop and typography controls directly, without manual text/hide actions or advanced disclosures. Reuse HeroUI controls and theme surfaces.
- The red page action explicitly claims camera projection from another owner. The header globally opens/closes projection. Visiting camera or changing subtitle mode does not claim projection; Timer retains its established navigation exception.

## CI and release

Run quality checks and builds concurrently, remove repeated typechecks, cancel superseded PR runs, and scope native speech jobs to relevant paths. Use two browser workers. Prepare verified OCR models once before parallel release checks and platform packaging. Security, checksum, packaged smoke and final publication gates remain mandatory.

No new font dependencies, binary cache system or validation bypass. Remote timings require actual Actions evidence; physical Windows/capture/projector acceptance is separate from automated checks.
