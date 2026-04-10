---
name: dev_cycle
description: # Dev Cycle Protocol: Extension Sovereignty
---

> [!IMPORTANT]
> **THE PRIME DIRECTIVE**
> All agent-driven development cycles, verification tests, and UI simulations MUST occur exclusively within the **Extension Development Host** (v2.3.2 protocol). Accidental execution or discovery in the Main IDE is a critical failure.

## 1. Sovereignty Hierarchy
- **Tier 1 (Priority):** `[Extension Development Host]` — The authoritative environment for all verification.
- **Tier 2 (Fallback):** `[Main Editor]` — Never target for UI simulation unless explicitly requested.

## 2. Command Pipeline: Back to Basics
To prevent character interleaving and race conditions during UI simulation (v2.3.2 stabilization):
1. **Serial Execution:** Always send commands to the CDP shell one at a time, or ensure the shell implementation serializes them.
2. **Standard Interface:** Exclusively use the `exec <command>` interface for UI automation.
3. **Activation First:** Before sending extension-specific commands, ensure the extension is activated (e.g., by ensuring a Markdown file is open and focused in the Dev Host).
4. **Command Prefixing (Antigravity)**: All commands sent via the terminal to the Command Palette MUST be prefixed with `>` (e.g., `exec >Readme Preview: Play`). This is a v2.4.0 safety requirement for Antigravity compatibility.

## 3. Persistent CDP Shell Workflow
1. **Launch:** `npm run cdp:shell` (Ensure only ONE instance is running).
2. **Bootstrap:** `launch` to trigger the Dev Host.
3. **Verify:** `check-host` to confirm targeted discoverability.
4. **Iterate:** Modify code -> `watch` compiles -> `exec workbench.action.reloadWindow` -> `check-host`.

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
| **Antigravity Rule** | **Prefixing**: Mandatory `>` prefix for all Command Palette simulations. |

---

## 2. The Integrated Dev Cycle (The Holistic Path) ⭐

The primary workflow for an AI agent is the **Continuous Session**. We pay the startup tax once and iterate in seconds.

### Phase 1: High-Integrity Setup (Sovereignty Protocol)

The shell is a singleton. Parallel spawns lead to connection leakage and "Dead UI" symptoms.

1.  **Sovereignty Check (MANDATORY)**:
    -   **DETECTION**: BEFORE running `npm run cdp:shell`, you MUST run:
        `Get-Process node | Where-Object { $_.CommandLine -like "*cdp-controller.mjs shell*" }`
    -   **RESOLUTION**: 
        -   If found and you have the `CommandId`: Re-use it via `send_command_input`.
        -   If found but no `CommandId` (Orphaned): Use `Stop-Process -Id <PID> -Force` to clear it.
        -   If clean: Proceed to `npm run cdp:shell`.
    -   **HARDENING**: The script uses `.cdp_shell.lock` (in project root) as a secondary guard. Never ignore "Another shell instance is active" errors.
2.  **Initialize Dev Host (Conditional Launch)**: 
    -   **Step 1: Connection Audit**: Send `check-host` to the active shell.
    -   **Step 2: Conditional Launch**:
        -   If `Dev Host` is `❌ NOT FOUND`: Send `launch`.
        -   If `Dev Host` is `✅ Detected`: **Skip launch**. Proceed directly to the reload loop.
    -   **SAFETY**: The `cdp:shell` is hardened with **Main Workbench Protection**. It snapshots PIDs at startup and explicitly filters them out of any surgical kill operations.
    -   *Mechanics*: This triggers the `Extension (Dev)` entry in `launch.json`.
    -   *Automation*: The `preLaunchTask: "watch-dev"` automatically starts the `esbuild` watcher in the background.

### Phase 2: The Rapid-Reload Loop ⭐

Once initialized, **NEVER** close the Dev Host. Use the following cycle:

1.  **Code**: Save a fix in `src/`.
2.  **Build**: The `watch-dev` task rebuilds the `dist/` folder in milliseconds.
3.  **Reload**: Send `exec workbench.action.reloadWindow` to the **active** `cdp:shell`.
    -   *Persistence*: Reusing the shell preserves the connection state and prevents process leakage.
    -   *Duration*: ~1.5 seconds.
    -   *Effect*: The extension host reboots with the new code while the CDP session remains alive.

### Phase 3: Command-Driven Verification (The "Visible" Audit) ⭐

Verification must be **observable**. Never assume the extension is functional because a variable changed in memory.

1.  **Open the Eyes (MANDATORY)**: Run `show read-aloud` to ensure the sidebar is active and the webview frame is registered by CDP.
2.  **Discovery Audit (MANDATORY)**: 
    -   Run `find read-aloud` or `check-host` to verify the webview is detected.
    -   **CRITICAL**: If discovery fails, run `find-all` to inspect the frame tree and identify if hydration is stuck or if the target is mismatched.
    -   NEVER proceed to `eval` or state verification if the webview is `❌ NOT FOUND`.
3.  **Trigger Action (Exec-First)**: Instead of manually patching state, use `exec >Readme Preview: Play` (note the `>` prefix) to trigger the extension's logic through the official command pipeline.
3.  **Cross-Verify**:
    -   **Visual**: Use `find read-aloud` to confirm the webview exists.
    -   **State**: Use `eval window.__READ_ALOUD_STORE__.getState()` to confirm the side-effect.
    -   **Logs**: Audit `diagnostics.log` for the "Symmetrical Shorthand" trace.

### Phase 4: Symmetrical Audit (Optional)

Closing the loop is as important as opening it. NEVER kill the shell process directly if it is responsive.

1.  **The Gesture**: Dispatch `exit` via the shell's stdin.
2.  **The Validation (MANDATORY)**: Before issuing a `close` or `kill` command (especially if outside the interactive shell), the agent MUST run `find-dev-host` or equivalent to ensure the target exists and is NOT the main workbench.
3.  **The Verification**: Verify that `scripts/.cdp-shell.lock` is removed.
4.  **The Registry**: If the shell was launched for a specific release (e.g., v2.3.2), ensure all diagnostics are moved to the session walkthrough.

> [!NOTE]
> For detailed cleanup protocols, consult [session_lifecycle § Phase E](../../knowledge/session_lifecycle/artifacts/SKILL.md#L86).

---

## 3. Deployment & Packaging (Production Paths)

Only use these phases when finalizing a release or preparing for the **"Prestige"** pipeline.

### Phase A: Packaging (VSIX)
```powershell
npm run package
```
- Creates `readme-preview-read-aloud-<version>.vsix`.

### Phase B: Hot-Swap Installation
```powershell
& "antigravity.cmd" --install-extension <vsix_path> --force
```
- This modifies the "User-Facing" extension in the main editor. Requires **USER APPROVAL**.

---

## 4. Troubleshooting the Signal

- **Leaked Shells**: If you suspect multiple cdp shells running, run:
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*cdp-controller.mjs shell*" }`
  and surgically kill orphans. This should not be necessary with the PID lock hardened in v2.3.2.

---
- **Watcher STUCK**: Check the "Tasks" terminal in Antigravity. If you see errors, the `problemMatcher` in `tasks.json` will prevent `launch` from proceeding.
- **Reload Failed**: If `reloadWindow` doesn't pick up changes, verify that `esbuild.js` logged `✅ [watch] build finished` in the task terminal.

---

## 5. Summary of Primary Commands

| Goal | Command / Action | Standard Interface |
|---|---|---|
| **Start Everything** | `npm run cdp:shell` | CLI |
| **Start Dev Host** | `launch` | CDP Shell |
| **Apply Changes** | `exec workbench.action.reloadWindow` | CDP Shell |
| **Wake Webview** | `show read-aloud` | CDP Shell |
| **Verify Webview** | `find read-aloud` | CDP Shell |
| **Audit State** | `eval <expr>` | CDP Shell |
| **Package Release** | `npm run package` | CLI | 
| **Graceful Stop** | `exit` or `quit` | CDP Shell |

### Sidebar Discovery Protocol

Sidebar webviews in VS Code are **lazy-loaded**. They do not appear in the CDP target list until the sidebar is active.

1.  **Wake-on-Show**: Run `show read-aloud` (dispatches `readme-preview-read-aloud.show-dashboard`).
2.  **Verify**: Run `find read-aloud` to confirm the `fake.html` frame is active.
3.  **Command Discretion**: **EXEC-FIRST LAW**: Prefer `exec` to trigger extension commands over direct `eval` or state patching. This ensures the full VS Code → Extension → Webview pipeline is tested.

> [!TIP]
> **Checkbox Sovereignty**: Always verify build success in the "Tasks" terminal before running `reloadWindow`. If the builder is red, the reload will serve stale code.

### Command Simulation Requirement (Antigravity)
**CRITICAL**: When using `exec` to simulate a command palette entry, you MUST include the `>` prefix. 
*   **Correct**: `exec >Readme Preview: Play`
*   **Incorrect**: `exec Readme Preview: Play` (Will search files instead of commands).
