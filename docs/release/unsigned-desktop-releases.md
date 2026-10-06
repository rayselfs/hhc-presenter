# Unsigned Desktop Releases

HHC Presenter currently publishes unsigned desktop artifacts through GitHub
Releases. This keeps the release path practical while the project is still
early and avoids paying platform signing fees before distribution is stable.

## Current Policy

- macOS builds are not Apple-notarized.
- Windows builds are not Authenticode-signed.
- GitHub Actions must pass lint, typecheck, tests, and build before publishing.
- Packaged apps must include VLC/libVLC, FFmpeg poster runtime, and bundled
  license notices.
- Apple notarization and Windows code signing are future release phases.

## User-Facing OS Warnings

Unsigned artifacts can trigger normal operating-system warnings.

macOS:

- Gatekeeper can say the app cannot be opened because the developer cannot be
  verified.
- Users should only open releases downloaded from the official GitHub release
  page.
- Users can open the app through Finder's contextual Open action or the
  Privacy & Security allow flow. Do not ask users to disable Gatekeeper.

Windows:

- Microsoft Defender SmartScreen can show an unrecognized app warning.
- Users should only run releases downloaded from the official GitHub release
  page.
- Users can choose More info, then Run anyway, if they trust the release.

## Video Engine Runtime Archives

Runtime binaries are intentionally not committed to git. Release packaging gets
them from repository variables that point to verified archives.

Required repository variables:

```text
VIDEO_ENGINE_VLC_DARWIN_ARM64_URL
VIDEO_ENGINE_VLC_DARWIN_ARM64_SHA256
VIDEO_ENGINE_FFMPEG_DARWIN_ARM64_URL
VIDEO_ENGINE_FFMPEG_DARWIN_ARM64_SHA256
VIDEO_ENGINE_VLC_WIN32_X64_URL
VIDEO_ENGINE_VLC_WIN32_X64_SHA256
VIDEO_ENGINE_FFMPEG_WIN32_X64_URL
VIDEO_ENGINE_FFMPEG_WIN32_X64_SHA256
```

Archive rules:

- Each archive must contain the runtime files for exactly one target.
- VLC macOS archives must contain `libvlc.dylib` or `libvlc.5.dylib`.
- VLC Windows archives must contain `libvlc.dll`.
- FFmpeg macOS archives must contain `ffmpeg`.
- FFmpeg Windows archives must contain `ffmpeg.exe`.
- The release workflow verifies the SHA-256 before extracting.
- The unpacked package is checked again for runtime files and license notices.

For local packaging, place the same unpacked runtime layout under
`.local-runtimes/` and run:

```bash
npm run build:unpack
```

## Release Verification

Before publishing a tag release, the workflow runs:

```bash
npm run lint
npm run typecheck
npx vitest run
npm run build
npm run package:desktop
npm run check:packaged-runtime
```

`npm run check:packaged-runtime` verifies that the unpacked app contains:

- `resources/video-engine/vlc/<platform-arch>/...`
- `resources/video-engine/ffmpeg/<platform-arch>/...`
- `resources/licenses/vlc/**`
- `resources/licenses/ffmpeg/**`
- `resources/licenses/electron-vlc-player/**`

## Future Signing Phase

When the project is ready to pay for platform trust:

- Restore macOS signing and notarization in `electron-builder.yml`.
- Add Apple Developer ID certificate secrets to GitHub Actions.
- Add Windows code-signing certificate secrets to GitHub Actions.
- Update this document and release notes so users no longer expect unsigned
  warnings.

## Hosted runner and device coverage

Hosted macOS runners cannot create the OpenGL output required by the embedded VLC
player. Their packaged smoke explicitly skips only the live-frame/pause/seek image
step (`PACKAGED_VLC_LIVE_PREVIEW=0`). Window recovery, native storage, import,
transport-state acknowledgements, remux/cache reuse and failure/retry checks still
run. A transport-state pass does not establish that video pixels reached a display.
Windows runners retain the live-frame step. Audio-device absence is recorded
separately and does not establish physical audio acceptance.

Local packaged smoke runs all steps by default. Use a graphics-capable Mac for the
live-frame check and real devices for external display/DPI/audio acceptance. The
hosted runner limitation does not disable or alter the product's live preview.
