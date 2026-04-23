---
name: cdp_dev_cycle
description: # Dev Cycle Protocol: CDP Shell Sovereignty (v2.5.1)
---

> [!IMPORTANT]
> **THE PRIME DIRECTIVE**
> All agent-driven development cycle verification MUST occur exclusively within the **Extension Development Host**. Accidental execution or discovery in the Main IDE is a critical failure.

## 0. Audit Pre-Flight Reflex (MANDATORY — AUTONOMOUS)

> [!CAUTION]
> **The agent MUST execute this reflex autonomously before ANY lifecycle audit session.**
> Do NOT wait for the user to prompt `restart`. Auditing against warm/stale boot state produces meaningless results.
> Skipping this pre-flight is a protocol violation equivalent to operating blind.

**Before any CDP-driven audit (T-009, T-010, T-011, T-012, or any future lifecycle observation):**

1. **Snapshot log cursor** (PowerShell):
   ```powershell
   $cursor = (Get-Item diagnostics_agent.log).Length
   ```
2. **Open CDP shell** (if not already open): `npm run cdp:shell`
   - *Smart Start*: shell auto-detects if Dev Host is open.
     - **Host found** → logs `🟢 Dev Host already open — connected.`
     - **No host** → auto-fires `launch` + `wait-for-ready` before dropping to prompt.
3. **Confirm `✅ SYSTEM READY`** before issuing any audit commands.
4. **All log reads MUST use `$cursor` as the start offset** — never read the full log.

> [!NOTE]
> For a true **cold-boot** audit window, send `restart` after the shell opens.
> `restart` is smart: if Dev Host is already open it closes it first, then re-launches.
> If no host is open it skips the close step and just launches fresh.

## 1. Sovereignty Hierarchy
- **Tier 1 (Host):** `[Extension Development Host]` — The primary target for verification.
- **Tier 2 (Meta):** `[Main Editor]` — **PROTECTED**. Authorized ONLY for meta-commands (`launch`).
- **Tier 3 (Webview):** `[readme-preview-read-aloud]` — The isolated execution context. Often nested and requires specific targeting.

## 2. The Persistent CDP Shell Workflow
To maintain high-integrity state awareness, the agent SHOULD keep a single `cdp:shell` open for the duration of the session.

### 🛠 Phase 1: High-Integrity Setup
1. **Initialize**: Run `npm run cdp:shell`.
2. **Launch Host**: Send `launch` (if host is not already open).
3. **The Wait-for-Ready Ritual**: Send `wait-for-ready`.
   - *Logic*: Combines `dispatch ...show-dashboard` with a poll for `isHydrated === true`.
   - *Signal*: When the shell reports `✅ SYSTEM READY`, the UI is fully hydrated and ready for commands.

### 🛠 Phase 2: The Rapid-Reload Loop ⭐
Once initialized, **NEVER** close the Dev Host unless necessary. Use this cycle:
1. **Code**: Save changes in `src/`.
2. **Build**: Verify `npm run watch` (or equivalent) completes the rebuild.
3. **Reload**: Send `dispatch workbench.action.reloadWindow` to the active shell — this fully restarts the extension host.
4. **Audit (MANDATORY)**: 
   - **State Audit**: Run `verify-state` to confirm Redux store hydration.
   - **Visual Audit**: Check for layout regressions or styling drift.

### 🛠 Phase 2b: Cold Restart (T-006 Boot Audit) ⭐
A **reload** restarts the extension in-place. For a true cold-boot audit (T-006), you need a full **process** restart:
1. Snapshot the log cursor: `(Get-Item diagnostics_agent.log).Length`
2. Send `restart` to the shell — this runs: `close-host` → 2s wait → `launch` → `wait-for-ready`.
3. Read the log slice from the cursor to capture all boot-window events.

> [!IMPORTANT]
> `exit` closes the **shell script AND the Dev Host** — it is a full cleanup ritual.
> It stops any running playback first, then gracefully closes the Dev Host, then exits.
> To close the Dev Host without exiting the shell: use `close-host`.

### 🛠 Phase 3: The Audit-Audit Ritual
**DISPATCH-AUDIT MIRROR**: Every `dispatch` (or `exec`) action MUST be followed by a state verification.
- *Rationale*: Extension commands are asynchronous. The UI might confirm "OK" while the underlying state is still syncing.
- *Action*: `dispatch Readme Preview: Play` -> `wait-for-ready` (or manual poll) -> `verify-state`.

### 🛠 Phase 4: Exit Ritual ⭐
> [!CAUTION]
> **Always use `exit` to terminate the shell — never Ctrl+C or kill the process.**
> `exit` is a full cleanup ritual: stop playback → close Dev Host → release lock → exit process.

**What `exit` does automatically:**
1. Clicks `btn-stop` in the webview (stops any running playback)
2. Calls `gracefulClose` to shut down the Extension Development Host
3. Releases the `.cdp_shell.lock` file
4. Exits the Node process cleanly

If the Dev Host is already closed (e.g. crashed), the exit ritual handles it gracefully and still exits cleanly.

## 3. Command Pipeline: Discovery Ritual
To prevent cross-pollution, always audit the field before acting.

### 🛠 Graceful Instance Management
- `status`: Full situation report (Host status, Webview hydration, Active PIDs).
- `targets`: Lists all active CDP pages and their frame counts. Essential for locating the active webview.
- `scan`: Quick list of active [Extension Development Host] windows and their PIDs.
- `frames`: Provides a recursive dump of all accessible frames. Use this if `find` fails.

### 🛠 Graceful Exit Ladder
When closing the dev host, the script follows a polite 3-tier ladder:
- **Tier 1 (UI Action)**: `workbench.action.closeWindow`. SAFEST way to exit.
- **Tier 2 (CDP Signal)**: `Target.closeTarget` fallback for unresponsive UI.
- **Tier 3 (OS Signal)**: `taskkill /T` (without `/F`) for clean process termination.

## 4. Summary of Primary Commands (v2.5.0)

| Goal | Command | Output / Expectation |
|---|---|---|
| **Inventory** | `targets` | List all pages and frame counts |
| **SitRep** | `status` | Full environment health check & PIDs |
| **Wake Host** | `launch` | Smart F5 launch protocol |
| **Ready Up** | `wait-for-ready` | Polls for system hydration signal |
| **Reload Ext** | `dispatch workbench.action.reloadWindow` | Restarts extension host in-place |
| **Close Host** | `close-host` | Gracefully closes Dev Host window + PIDs |
| **Smart Restart** | `restart` | close-host (if open) → launch → wait-for-ready |
| **State Dump** | `verify-state` | Dumps the current Redux store |
| **Dispatch** | `dispatch <cmd>` | Atomic command triggering |
| **Eval** | `eval <expr>` | JS execution in webview context |
| **Full Exit** | `exit` | Stop playback + close Dev Host + exit shell |

## 5. Troubleshooting the Signal
- **"NOT FOUND" (Webview)**: If `status` shows `Webview: ❌`, run `dispatch ...show-dashboard`. Webviews are lazily loaded.
- **Leaked Shells**: If port 9222 is blocked, run `scan` to find the culprit PID and close it gracefully.
- **Garbled Logic**: If shell output is corrupted, it usually indicates a race. Use `wait-for-ready` to synchronize.

> [!TIP]
> **Checkbox Sovereignty**: Always verify build success in the "Tasks" terminal before running `refresh`. If the builder is red, the reload will serve stale code.
