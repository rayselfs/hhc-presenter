# Windows projection diagnostic

This portable diagnostic uses the actual Presenter window lifecycle and Electron runtime. It does not install over 2.6.4 or publish an updater release. Use **Start-diagnostic.cmd**: directly opening the EXE without the diagnostic argument uses the normal app profile.

1. Extract the entire downloaded artifact into a new folder. Stop projection and close the installed Presenter before the test; no settings or files need to be deleted.
2. Run **Start-diagnostic.cmd**, choose **1**, complete onboarding if shown, and use the Timer clock to start projection on the external display. No account sign-in is needed.
3. Wait at least two seconds. Record whether the projection covers the display. Stop and reopen projection once, then record coverage again. Close the entire diagnostic app.
4. Repeat with **2** and then **3**, closing the diagnostic app between modes. Keep monitor arrangement, resolution and scaling unchanged during this comparison.
5. Collect **diagnostic-build.txt** and the JSONL files in `%APPDATA%\HHC Presenter Projection Diagnostic\projection-diagnostics`. Repeat the existing read-only Win32 measurement for each mode if possible.

Modes:

- **baseline**: the 2.6.4 construction/show order, with geometry logging.
- **after-show**: retain `resizable: false`, but request fullscreen only after `showInactive()`.
- **resize-after-fullscreen**: start resizable, show inactive, request fullscreen, then set resizable to false.

Each file is named by mode and process ID. Records contain timestamps, versions, display IDs/bounds/work areas/scales, requested target, window/content bounds, min/max sizes, native handle, and fullscreen/visibility/focus states. Electron rectangles are in DIP; compare them with Win32 physical pixels only after accounting for display scaling. The native handle is logged as little-endian hexadecimal bytes.

The diagnostic uses a separate profile at `%APPDATA%\HHC Presenter Projection Diagnostic`; automatic updates and protocol registration are disabled in diagnostic mode. Logs remain local and contain no account tokens or media contents. No production fullscreen fix has been selected yet: compare the measurements first. A green CI smoke on a single virtual display is not dual-monitor acceptance.
