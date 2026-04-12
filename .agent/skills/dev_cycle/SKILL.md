---
name: dev_cycle
description: # Dev Cycle Protocol: Extension Sovereignty
---


> [!IMPORTANT]
> **THE PRIME DIRECTIVE**
> All agent-driven development cycles, verification tests, and UI simulations MUST occur exclusively within the **Extension Development Host**. Accidental execution or discovery in the Main IDE is a critical failure.

## 1. Sovereignty Hierarchy
- **Tier 1 (Target):** `[Extension Development Host]` — The ONLY target for verification, UI simulation, and project commands.
- **Tier 2 (Meta-Target):** `[Main Editor]` — **PROTECTED & READ-ONLY**. Authorized ONLY for meta-commands (`launch-dev-host`).
- **Sovereign Scoping Rule**: Any project command (`readme-preview-read-aloud.*`) dispatched to Tier 2 is a protocol violation. The `cdp-controller` will block these actions by default.

## 2. Command Pipeline: Back to Basics
To prevent cross-pollution of sessions, always use the automated discovery ritual.

## 🛠 Graceful Instance Management
The Antigravity dev loop prioritization **Graceful Existence**.
- [x] Reimplement Graceful Termination in `cdp-controller.mjs`
  - [x] Revert aggressive `/F` (Force) from `surgicalPidKill`
  - [x] Implement `shellScanDevHosts()` for multi-instance discovery
  - [x] Update `exit` command to use parallel graceful ladders
- [x] Add New Shell Commands
  - [x] Add `scan` command to list all dev host PIDs and titles
  - [x] Add `status` command for quick environment audit
- [x] Update Documentation
  - [x] Update `dev_cycle/SKILL.md` with new graceful ritual
- [/] Verification
  - [ ] Test `scan` with multiple open dev hosts
  - [ ] Verify `exit` performs graceful closure without force

### 1. Discovery Ritual (`scan` / `status`)
Before acting, audit the field to see what's actually open.
- `scan`: Lists all active [Extension Development Host] windows and their PIDs.
- `status`: Provides a full sitrep of CDP connectivity, Protected PIDs, and active dev hosts.

### 2. Graceful Exit Ladder
When closing the dev host, the script follows a 3-tier polite ladder:
- **Tier 1 (UI Action)**: Sends `workbench.action.closeWindow`. This is the SAFEST way to exit, allowing the editor to handle unsaved changes.
- **Tier 2 (CDP Signal)**: `Target.closeTarget` fallback for unresponsive UI.
- **Tier 3 (OS Signal)**: `taskkill /T` (without `/F`) to request a clean OS-level shutdown.

### 3. Cleanup Ritual
If you encounter a port conflict (9222), use `scan` to find the culprit PID and close it gracefully from the shell.
`>` is a protocol violation.

## 3. Persistent CDP Shell Workflow
1. **Initialize:** `npm run cdp:shell`.
   - *Logic*: The shell handles singleton locking automatically.
2. **The "Wait-for-Ready" Ritual:** `wait-for-ready`.
   - *Logic*: Automatically triggers the "Show" command and blocks until `VOICE_SCAN SUCCESS` is detected in the log stream.
3. **Iterate:** Modify code -> `watch` compiles -> `refresh`.
   - *Macro*: `refresh` performs `reloadWindow` followed by a silent `wait-for-ready`.

## 4. Troubleshooting
- **Garbled Text:** Usually a race condition. Restart the CDP shell and ensure commands are sent sequentially.
- **Discovery Failed:** Verify the Sidebar View or a relevant document is open to trigger activation.


---

## 1. Environment Facts

| Property | Value |
|---|---|
| **Editor** | Antigravity (VS Code fork, Electron) |
| **CLI** | `C:\Users\Idan4\AppData\Local\Programs\Antigravity\bin\antigravity.cmd` |
| **CDP Endpoint** | `http://localhost:9222` (Active in both MAIN and DEV hosts) |
| **Build System** | `esbuild` with `[watch] build finished` signal plugin |
| **Integrity Rule** | **Shell-First**: Prefer shell commands over raw `eval` if possible. |
| **Safety Rule** | **Validation**: Never `close` or `kill` without verifying Target via CDP. |
| **Sovereignty** | **Dev-First**: All verification MUST target the Extension Development Host. |
| **Antigravity Rule** | **Resiliency**: The shell automatically handles `>` and palette clearing. |
| **Log Policy** | **Internal Forensic Stream**: Logs are aggregated in memory AND written to `scripts/forensics.log`. |
| **Noise Control** | **Smart Aggregator**: Noise (e.g. Focus syncs) is collapsed (xN). |
| **Cleanup Protocol** | **Sovereign Cleanup**: Use `cleanup-all` to gracefully close all active dev hosts. |

---

## 2. The Integrated Dev Cycle (The Holistic Path) ⭐

The primary workflow for an AI agent is the **Continuous Session**. We pay the startup tax once and iterate in seconds.

### Phase 1: High-Integrity Setup (Sovereignty Protocol)

The shell is a singleton. Parallel spawns lead to connection leakage and "Dead UI" symptoms.

1.  **Shell Initialization**:
    -   **ACTION**: Run `npm run cdp:shell`.
    -   **ERROR HANDLING**: 
        -   If "Another instance is active": Verify if you have an active background `CommandId`. 
        -   If yes: use `send_command_input`. 
        -   If no (orphaned): Clear the lock file and relaunch (Or use `Stop-Process` if you have the PID from the error).
2.  **The Wait-for-Ready Ritual**: 
    -   **ACTION**: Send `wait-for-ready` to the active shell.
    -   **EFFECT**: This combines `open read-aloud` with a non-blocking wait for `VOICE_SCAN SUCCESS`.
    -   **SIGNAL**: When the shell reports `✅ SYSTEM READY`, the UI is fully hydrated and interactive.

### Phase 2: The Rapid-Reload Loop ⭐

Once initialized, **NEVER** close the Dev Host. Use the following cycle:

1.  **Code**: Save a fix in `src/`.
2.  **Build**: The `watch-dev` task rebuilds the `dist/` folder.
3.  **Reload**: Send `refresh` to the active shell.
    -   *Logic*: Performs `reloadWindow` + `wait-for-ready`.
    -   *Effect*:### 2. The Dev Environment SitRep
Before starting new work, audit the environment to prevent port conflicts:
- **Scan**: Run `scan` in the CDP shell to identify existing [Extension Development Host] windows.
- **Status**: Run `status` for a full environment health check (Protected PIDs, CDP connection, active hosts).

### 3. Graceful Existence (Closure Protocol)
We avoid aggressive process termination (`/F`) to protect editor state.
- **Exit Ritual**: Type `exit` or `quit` in the the CDP shell.
- **The Ladder**: The system will attempt Tier 1 (Keyboard: closeWindow) -> Tier 2 (CDP: closeTarget) -> Tier 3 (OS: tree termination).
- **Manual Intervention**: If a window stays open (e.g. due to "Save Changes?"), use `scan` to find the PID and handle it manually.

### 4. Forensic Monitoring
- **Forensic History**: Use `history [n]` to see the last `n` aggressive/ritual logs from memory.
- **Live Tail**: Use `tail` to toggle real-time log streaming (Tier 1/2 messages only).
- **Diagnostic Audit**: Use `log [n]` to read the physical `diagnostics.log` file.
4.  **Confirm & Verify (MANDATORY)**:
    -   **Response Audit**: Wait for the shell to report verification status.
    -   **State Audit**: Run `sitrep` or `verify-state` to confirm side-effects.

### Phase 4: Symmetrical Audit (Optional)

Closing the loop is as important as opening it. NEVER kill the shell process directly if it is responsive.

1.  **The Gesture**: Dispatch `exit` via the shell's stdin.
    - *Note*: Hit `Ctrl+C` if the shell is hung; the `SIGINT` handler will trigger a full cleanup.
2.  **The Validation (MANDATORY)**: Before issuing a `close` or `nuke` command, the agent MUST run `find-dev-host` or equivalent to ensure the target exists and is NOT the main workbench.
3.  **The Verification**: Verify that `scripts/.cdp-shell.lock` is removed.
4.  **The Registry**: Use `scripts/forensics.log` for deep post-mortem analysis across multiple sessions.


## 4. Troubleshooting the Signal

- **Leaked Shells**: If you suspect multiple cdp shells running, run:
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*cdp-controller.mjs shell*" }`
  and surgically kill orphans. This should not be necessary with the PID lock hardened in v2.3.2.

---
## 5. Verification Rituals (v2.4.2 Protocol) ⭐

To achieve deterministic playback automation and solve state synchronization races:

### A. The "Act-Wait-Verify" Chain
NEVER issue a `sitrep` or `verify-state` immediately after an `exec` command. State transitions are asynchronous across the Extension-Webview bridge.

1.  **Trigger**: `exec Readme Preview: Play`
2.  **Wait (Log Signal)**: Use the CDP shell's `wait-for-log "[STORE-SYNC-COMPLETE]"` command.
    -   **Rationale**: The Webview emits this specific ASCII marker ONLY after its internal store has hydrated the latest sync packet from the Extension.
3.  **Verify**: `verify-state window.__WEBVIEW_STORE__.getState().isPlaying === true`

### B. ASCII-First Logging Policy
To prevent log corruption in the terminal (especially on Windows relay):
- **Rule**: Use explicit ASCII markers for all automation signals.
- **Markers**:
    - `[STORE-SYNC-COMPLETE]` -> Webview store hydration finished.
    - `[RELAY] 📦 Assembled Packet` -> Extension relay heartbeat.
- **Prohibition**: Avoid using emojis or non-ASCII characters in automated verification strings.

### C. Intent ID Sovereignty (The "Start-at-1" Rule)
The Extension is the global source of truth for `playbackIntentId` and `batchIntentId`.
- **Baseline**: These counters MUST start at `1`.
- **Sync Rule**: The Webview adopts these IDs from the `UI_SYNC` pulse. It never increments them locally.
- **Validation**: If `verify-state` returns `0` for intent IDs after hydration, it is a protocol violation.

### D. Recursion Guard
The Webview Store implements a `patchState` recursion guard. 
- **Behavior**: It ignores packets that are identical to the current local state.
- **Audit**: If you see high-frequency "Same State" logs, verify that the Extension isn't sending redundant pulses with no diffs.

---

## 4. Summary of Primary Commands

| Goal | Command / Action | Output / Expectation |
|---|---|---|
| **Initialize** | `npm run cdp:shell` | CLI-Launched Background Shell |
| **Wake Host** | `launch` | Triggers F5 (Smart Launch Protocol) |
| **Wait-for-Ready** | `wait-for-ready` | Combines `open` + `find` + `hydration-wait` |
| **Full Refresh** | `refresh` | Macro for `reloadWindow` + `wait-for-ready` |
| **Forensics** | `history` | Dumps the in-memory aggregated logs |
| **Cleanup** | `cleanup-all` | Gracefully closes all active [Extension Development Host] windows |
| **State Check** | `sitrep` or `verify-state` | Confirms cross-bridge integrity |

### Sidebar Discovery Protocol

Sidebar webviews in VS Code are **lazy-loaded**. They do not appear in the CDP target list until the sidebar is active.

1.  **Wake-on-Show**: Run `show read-aloud` (dispatches `readme-preview-read-aloud.show-dashboard`).
2.  **Verify**: Run `find read-aloud` to confirm the `fake.html` frame is active.
3.  **Command Discretion**: **EXEC-FIRST LAW**: Prefer `exec` to trigger extension commands over direct `eval` or state patching. This ensures the full VS Code → Extension → Webview pipeline is tested.

> [!TIP]
> **Checkbox Sovereignty**: Always verify build success in the "Tasks" terminal before running `reloadWindow`. If the builder is red, the reload will serve stale code.

### Command Simulation Requirement (Antigravity)
**CRITICAL**: The `exec` command implementation in `cdp-controller.mjs` handles the command palette simulation resiliently. 
*   **Correct**: `exec Readme Preview: Play`
*   **Incorrect**: `exec >Readme Preview: Play` (Avoid manual prefixing).
