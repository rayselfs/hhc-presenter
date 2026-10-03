@echo off
setlocal
cd /d "%~dp0"
echo HHC Presenter Windows projection diagnostic
echo Close any other diagnostic instance before continuing.
echo 1. Baseline: fullscreen during construction, fixed size
echo 2. After show: fixed size, fullscreen after showInactive
echo 3. Resize after fullscreen: show, fullscreen, then fix size
choice /c 123 /n /m "Select mode [1-3]: "
if errorlevel 3 (set "DIAGNOSTIC_MODE=resize-after-fullscreen") else if errorlevel 2 (set "DIAGNOSTIC_MODE=after-show") else (set "DIAGNOSTIC_MODE=baseline")
echo Mode: %DIAGNOSTIC_MODE%
echo Logs: %APPDATA%\HHC Presenter Projection Diagnostic\projection-diagnostics
start "" /wait "%~dp0hhc-presenter.exe" --projection-diagnostic=%DIAGNOSTIC_MODE%
echo Please collect the JSONL logs and diagnostic-build.txt after all three modes.
pause
