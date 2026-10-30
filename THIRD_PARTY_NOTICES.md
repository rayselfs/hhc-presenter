# Third-Party Notices

HHC Presenter includes and depends on open-source software. This file is a
summary; bundled license texts and source/build metadata live under
`resources/licenses/`.

## Desktop Video Engine

### VLC / libVLC

Desktop video playback is powered by VLC/libVLC. VLC is developed by the
VideoLAN project. VLC and libVLC components are distributed under GPL and LGPL
licenses depending on the component.

Bundled notices:

- `resources/licenses/vlc/LICENSE.GPL-2.0`
- `resources/licenses/vlc/LICENSE.LGPL-2.1`
- `resources/licenses/vlc/source-url.txt`
- `resources/licenses/vlc/build-info.json`

### FFmpeg

Desktop video poster generation uses FFmpeg. HHC Presenter uses FFmpeg only to
extract still-image posters; it is not exposed as a user-configurable transcoder.

Bundled notices:

- `resources/licenses/ffmpeg/LICENSE.LGPL-2.1`
- `resources/licenses/ffmpeg/source-url.txt`
- `resources/licenses/ffmpeg/build-info.json`

### electron-vlc-player

HHC Presenter embeds libVLC through `electron-vlc-player`.

Bundled notices:

- `resources/licenses/electron-vlc-player/LICENSE.MIT`
- `resources/licenses/electron-vlc-player/source-url.txt`
- `resources/licenses/electron-vlc-player/build-info.json`

## Runtime Dependencies

### @aiden0z/pptx-renderer

Web-compatible PPTX preview and projection rendering uses
`@aiden0z/pptx-renderer`, distributed under Apache-2.0.

Bundled notices:

- `resources/licenses/pptx-renderer/LICENSE.Apache-2.0`
- `resources/licenses/pptx-renderer/source-url.txt`
- `resources/licenses/pptx-renderer/build-info.json`

The app also uses Electron, React, Vite, pdfjs-dist, HeroUI, i18next, Zustand,
and other npm dependencies. Their exact package versions are tracked in
`package-lock.json`.

VLC/libVLC and FFmpeg binaries are supplied to release packaging through
verified runtime archives, not committed to git. Exact binary source, version,
and checksum details should be recorded with each published release.

Before publishing a release, run the package license check and ensure this file
and bundled binary notices are included in the packaged app.

## DeckCraft reference implementation

PPTX DrawingML property serialization references DeckCraft v0.5.0
(`crates/pptx/src/write/dml.rs`, especially `rpr`). Adapted code is identified
in the TypeScript source. Preset adjustment defaults and geometry reference
`crates/geom/src/preset.rs`. Theme fill selection and ordered color transforms reference
`crates/model/src/resolve.rs` and `crates/color/src/lib.rs`. Original source: https://github.com/storytold/deckcraft/tree/v0.5.0.

Copyright (c) 2026 ArtCraft Team and the DeckCraft contributors.
Used under the MIT license; full text: `resources/licenses/deckcraft/LICENSE-MIT`.
