---
name: dev_cycle
description: Protocol for building, installing, and cycling the Read Aloud extension using Native VSC Task integration and a persistent CDP shell.
---

# Dev Cycle Protocol — Integrated Read Aloud Edition

This skill governs the high-speed, automated development lifecycle of the Read Aloud extension. It prioritizes the **Integrated Loop**, where watchers are automated and verification happens within a persistent debug session.

## 1. Environment Facts

| Property | Value |
|---|---|
| **Editor** | Antigravity (VS Code fork, Electron) |
| **CLI** | `C:\Users\Idan4\AppData\Local\Programs\Antigravity\bin\antigravity.cmd` |
| **CDP Endpoint** | `http://localhost:9222` (Active in both MAIN and DEV hosts) |
| **Build System** | `esbuild` with `[watch] build finished` signal plugin |

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
    -   **Step 1: Inspect targets**: Send `targets` to the active shell.
    -   **Step 2: Conditional Launch**:
        -   If `[DEV HOST]` is missing: Send `launch`.
        -   If `[DEV HOST]` exists: **Skip launch**. Proceed directly to the reload loop.
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

### Phase 3: Live Probing (The Symmetrical Audit)

Use the shell to inspect state across the bridge:

-   **Webview State**: `eval window.__READ_ALOUD_STORE__.getState()`
-   **Extension State**: Read `diagnostics.log` (populated via Symmetrical Shorthand Logging).

### Phase 4: Sovereign Exit Ritual (The Smooth Path) ⭐

Closing the loop is as important as opening it. NEVER kill the shell process directly if it is responsive.

1.  **The Gesture**: Dispatch `exit` via the shell's stdin.
2.  **The Verification**: Verify that `scripts/.cdp-shell.lock` is removed.
3.  **The Registry**: If the shell was launched for a specific release (e.g., v2.3.2), ensure all diagnostics are moved to the session walkthrough.

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
3.  **Command Discretion**: Prefer the shell-native `show read-aloud` over direct `exec` for better retry logic.

> [!TIP]
> **Checkbox Sovereignty**: Always verify build success in the "Tasks" terminal before running `reloadWindow`. If the builder is red, the reload will serve stale code.
