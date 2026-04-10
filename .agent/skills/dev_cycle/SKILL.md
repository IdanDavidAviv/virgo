---
name: dev_cycle
description: Protocol for building, installing, and cycling the Read Aloud extension in the Antigravity editor. Covers compile, package, VSIX install, and process kill/restart.
---

# Dev Cycle Protocol — Read Aloud Extension

## 1. Environment Facts

| Property | Value |
|---|---|
| **Editor** | Antigravity (VS Code fork, Electron) |
| **Editor EXE** | `C:\Users\Idan4\AppData\Local\Programs\Antigravity\Antigravity.exe` |
| **CLI** | `C:\Users\Idan4\AppData\Local\Programs\Antigravity\bin\antigravity.cmd` |
| **Extension install dir** | `~/.antigravity/extensions/idandavidaviv.readme-preview-read-aloud-<version>/` |
| **VSIX output name** | `readme-preview-read-aloud-<version>.vsix` (in project root) |
| **Process name** | `Antigravity` (multiple Electron sub-processes) |

> [!IMPORTANT]
> The agent can identify the **main window process** by filtering for `MainWindowTitle`.
> The correct PID for the editor window is always the one where `MainWindowTitle` contains `Antigravity`.

---

## 2. The Four-Phase Dev Cycle

### Phase 1 — Compile (Fast, Always Safe)

Rebuilds the extension JS without touching the installed copy.

```powershell
npm run compile
```

- Output: `dist/extension.js`, `dist/webview.js`, `dist/media/style.css`
- Duration: ~2–4 seconds
- Safe to auto-run: ✅ Yes

**When to use:** After any source code change. Validates TypeScript + bundles.

---

### Phase 1b — Extension Development Host (F5 Equivalent, Manual)

> [!NOTE]
> **Superseded by Phase 1c (CDP probe-cycle).** Phase 1b is only relevant when the user wants a debugger-attached session with breakpoints (only possible via manual F5).

---

### Phase 1c — CDP-Controlled Dev Host (Agent Automation) ⭐

The agent can run a full **F5 → observe → kill → read log** probe cycle autonomously using the Chrome DevTools Protocol (CDP).

#### Permanent Setup (DONE ✅ — no action needed)

Antigravity is permanently configured with `--remote-debugging-port=9222` via:
- `%APPDATA%\Antigravity\User\argv.json` — `{ "remote-debugging-port": 9222 }`
- Taskbar shortcut patched with `--remote-debugging-port=9222`

CDP endpoint is live at `http://localhost:9222` on every launch. **No launcher script needed.**

#### The Observe Cycle — Primary Agent Loop ⭐

```
npm run cdp:observe
```

This is the **primary agent command** for a live, interactive debug session:

```
[1/5] Pre-launch PID snapshot
[2/5] Launch dev host (F5 via command palette)
[3/5] Wait for full activation — PID delta + VOICE_SCAN log signal
[4/5] OBSERVE WINDOW (8s default) — live diagnostics.log stream + optional webview eval
[5/5] Graceful 3-tier close → final log snapshot
```

Loop diagram:
```
compile → cdp:observe → analyze live logs → fix → recompile
   ↑                                                   ↓
   └────────────────────────────────────────────────────┘
```

#### Graceful Shutdown Ladder (3-Tier)

Instead of immediately killing the process, `close-dev-host` and `observe-cycle` use:

```
Tier 1 (Polite):  Ctrl+Shift+P → workbench.action.closeWindow  → wait 3s
Tier 2 (Harder):  page.evaluate(() => window.close())           → wait 2s
Tier 3 (Nuclear): Stop-Process -Id <devHostPids> -Force         (last resort)
```

#### All CDP Commands

| Command | Action | Safe to Auto-Run |
|---|---|---|
| `npm run cdp:targets` | List all CDP page targets (debug) | ✅ Yes |
| `npm run cdp:shell` | **⭐ Interactive REPL**: persistent session for live `window.__debug` inspection | ✅ Yes |
| `npm run cdp:observe` | **Primary loop**: launch → signal → live tail → graceful close | ✅ Yes |
| `npm run cdp:eval-webview "<expr>"` | Evaluate JS expression in the live Read Aloud webview | ✅ Yes |
| `npm run cdp:close-dev-host` | Graceful 3-tier shutdown (polite → eval → kill) | ✅ Yes |
| `npm run cdp:launch-dev-host` | Launch dev host only | ✅ Yes |
| `npm run cdp:wait-for-devhost` | Block until dev host appears | ✅ Yes |
| `npm run cdp:kill-dev-host` | Surgical PID kill (legacy alias → now routes to graceful) | ✅ Yes |
| `npm run cdp:probe-cycle` | Legacy: launch → wait → kill → read log | ✅ Yes |
| `npm run dev:full-cycle` | Compile + launch dev host | ✅ Yes |

#### observe-cycle Flags

| Flag | Description | Default |
|---|---|---|
| `--duration <ms>` | How long to keep the dev host alive for observation | `8000` |
| `--eval "<expr>"` | JS expression to evaluate in the webview during the observe window | none |

#### Workbench Selector Law (CRITICAL)

> [!IMPORTANT]
> **NEVER select the workbench page by title alone.** Preview tabs, Launchpad panels, and agent windows all have "Antigravity" in their title but are NOT the workbench shell.
>
> **LAW:** The real workbench shell is the page where `url` contains `workbench.html`.
> Preview tabs use `about:blank`. Always filter on URL, not title.

```js
// CORRECT — URL-based selector in cdp-controller.mjs
const isRealShell = url.includes('workbench.html');
const isWorkbench = isRealShell && !isDevHost && !isWebview;
```

#### Dev Host Identification

The `[Extension Development Host]` window is identified by its **title** containing `Extension Development Host`. This is reliable — no URL filtering needed for the dev host target.

---

### Phase 2 — Package (Creates installable VSIX)

```powershell
npm run package
```

- Output: `readme-preview-read-aloud-<version>.vsix` in project root
- Removes old legacy `.vsix` files automatically
- Duration: ~5–10 seconds
- Safe to auto-run: ✅ Yes (no side effects outside project dir)

---

### Phase 3 — Install (Hot-swaps the extension)

```powershell
$vsix = Get-ChildItem "c:\Users\Idan4\Desktop\readme-preview-read-aloud" -Filter "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
& "C:\Users\Idan4\AppData\Local\Programs\Antigravity\bin\antigravity.cmd" --install-extension $vsix --force
```

- Installs into `~/.antigravity/extensions/`
- `--force` overwrites if same version already installed
- Duration: ~3–5 seconds
- Safe to auto-run: ❌ **No** — modifies installed extension state. Requires user approval.

> [!WARNING]
> After installation, the **extension DOES NOT auto-reload**. The editor must be restarted or the window reloaded manually (`Ctrl+Shift+P → Developer: Reload Window`).

---

### Phase 4 — Process Kill & Restart (Full Reload)

#### Option A — Targeted main-window kill (preferred)

Kills only the primary Antigravity editor window by PID. All sub-processes (extension host, workers) will terminate as children.

```powershell
# Step 1: Identify the main window PID
$mainPid = (Get-Process -Name "Antigravity" | Where-Object { $_.MainWindowTitle -ne "" } | Sort-Object CPU -Descending | Select-Object -First 1).Id

# Step 2: Kill it
Stop-Process -Id $mainPid -Force
```

> [!CAUTION]
> This closes the editor entirely. Unsaved files will be lost. Only use after the user explicitly approves or has saved their work.

#### Option B — Full process sweep (nuclear)

```powershell
Stop-Process -Name "Antigravity" -Force
```

Kills ALL Antigravity processes. Use only if Option A fails.

#### Restart after kill

```powershell
Start-Process "C:\Users\Idan4\AppData\Local\Programs\Antigravity\Antigravity.exe"
```

---

## 3. Full Hot-Deploy Sequence (Agent Protocol)

This is the complete compile → install → kill → restart cycle:

```
Phase 1: npm run compile              ← always safe, run first
Phase 2: npm run package              ← creates VSIX
Phase 3: antigravity --install-extension <vsix>  ← NEEDS USER APPROVAL
Phase 4: Kill main window + restart   ← NEEDS USER APPROVAL
```

> [!IMPORTANT]
> Phases 3 and 4 MUST be presented to the user for approval before execution.
> The agent MUST NOT auto-run `--install-extension` or `Stop-Process` without explicit user "GO".

### Recommended Agent Workflow

1. Run `npm run compile` (auto-safe) to verify build is clean.
2. Run `npm run test` (auto-safe) to verify no regressions.
3. Present Phases 3 & 4 as a single "deploy" proposal for user approval.
4. On "GO": run package → install → kill/restart in sequence.

---

## 4. Verification After Deploy

```powershell
# Confirm installed version matches
& "C:\Users\Idan4\AppData\Local\Programs\Antigravity\bin\antigravity.cmd" --list-extensions --show-versions | Select-String "readme-preview"
```

Expected output: `idandavidaviv.readme-preview-read-aloud@<version>`

---

## 5. Process Inspection

```powershell
# List all Antigravity processes (with window title for main process ID)
Get-Process -Name "Antigravity" | Select-Object Id, CPU, MainWindowTitle | Format-Table -AutoSize

# Find main editor window PID
(Get-Process -Name "Antigravity" | Where-Object { $_.MainWindowTitle -ne "" }).Id
```

---

## 6. Env Vars Used by Extension

| Variable | Purpose | Default |
|---|---|---|
| `READ_ALOUD_DATA_DIR` | Override MCP standalone sessions root | `~/.gemini/antigravity/read_aloud/sessions/` |
| `USERPROFILE` / `HOME` | Resolve `~` on Windows | Set by OS |

---

## 7. Known Limitations

| Limitation | Workaround |
|---|---|
| **No silent reload** — `--reload-window` not available as CLI flag | Kill + restart (Phase 4), or user manually runs `Developer: Reload Window` |
| **Extension host PID is a child** — cannot be killed independently without killing main window | Always target the main window PID (option A) |
| **`code` CLI not on PATH** | Always use full path: `C:\...\Antigravity\bin\antigravity.cmd` |
| **Multiple Antigravity processes** | Filter by `MainWindowTitle` to find the correct target |
