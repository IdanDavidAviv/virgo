# ------------------------------------------------------------------------------
# launch-antigravity-cdp.ps1
# Antigravity CDP Launcher -- One-time setup for agent-controlled dev cycles.
#
# What this does:
#   1. Stops any running Antigravity instances
#   2. Relaunches Antigravity with --remote-debugging-port=9222
#
# After this runs, the agent can connect via:
#   node scripts/cdp-controller.mjs list-targets
# ------------------------------------------------------------------------------

$ANTIGRAVITY_EXE = "C:\Users\Idan4\AppData\Local\Programs\Antigravity\Antigravity.exe"
$CDP_PORT = 9222
$PROJECT_DIR = $PSScriptRoot | Split-Path -Parent

Write-Host ""
Write-Host "================================================"
Write-Host "  Antigravity CDP Launcher"
Write-Host "  Remote Debugging Port: $CDP_PORT"
Write-Host "================================================"
Write-Host ""

# Step 1: Stop existing Antigravity processes
$existing = Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[1/3] Stopping $($existing.Count) Antigravity process(es)..."
    Stop-Process -Name "Antigravity" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-Host "      Done."
} else {
    Write-Host "[1/3] No existing Antigravity processes found."
}

# Step 2: Launch with CDP flag
Write-Host "[2/3] Launching Antigravity with --remote-debugging-port=$CDP_PORT..."
Start-Process $ANTIGRAVITY_EXE -ArgumentList "--remote-debugging-port=$CDP_PORT" -WorkingDirectory $PROJECT_DIR

# Step 3: Wait and confirm
Write-Host "[3/3] Waiting for boot (~5s)..."
Start-Sleep -Seconds 5

Write-Host ""
Write-Host "[OK] CDP endpoint ready at: http://localhost:$CDP_PORT"
Write-Host ""
Write-Host "     Agent commands:"
Write-Host "       node scripts/cdp-controller.mjs list-targets"
Write-Host "       node scripts/cdp-controller.mjs launch-dev-host"
Write-Host "       node scripts/cdp-controller.mjs kill-dev-host"
Write-Host ""
