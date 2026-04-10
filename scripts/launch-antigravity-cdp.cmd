@echo off
:: ─────────────────────────────────────────────────────────────────────────────
:: launch-antigravity-cdp.cmd
:: Double-clickable wrapper for launch-antigravity-cdp.ps1
:: ─────────────────────────────────────────────────────────────────────────────
echo [CDP] Starting Antigravity with remote debugging on port 9222...
powershell -ExecutionPolicy Bypass -File "%~dp0launch-antigravity-cdp.ps1"
echo.
echo [CDP] Press any key to close this window.
pause >nul
