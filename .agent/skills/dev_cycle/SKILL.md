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

### Phase 1: Zero-Friction Setup

We use the native VS Code debugger which is pre-configured to handle the watcher automatically.

1.  **Start Home Base**: Run `npm run cdp:shell`.
2.  **Initialize Dev Host**: Type `launch` in the shell.
    -   *Mechanics*: This triggers the `Extension (Dev)` entry in `launch.json`.
    -   *Automation*: The `preLaunchTask: "watch-dev"` automatically starts the `esbuild` watcher in the background.

### Phase 2: The Rapid-Reload Loop ⭐

Once initialized, **NEVER** close the Dev Host. Use the following cycle:

1.  **Code**: Save a fix in `src/`.
2.  **Build**: The `watch-dev` task rebuilds the `dist/` folder in milliseconds.
3.  **Reload**: Type `exec workbench.action.reloadWindow` in the `cdp:shell`.
    -   *Duration*: ~1.5 seconds.
    -   *Effect*: The extension host reboots with the new code while the CDP session remains alive.

### Phase 3: Live Probing (The Symmetrical Audit)

Use the shell to inspect state across the bridge:

-   **Webview State**: `eval window.__READ_ALOUD_STORE__.getState()`
-   **Extension State**: Read `diagnostics.log` (populated via Symmetrical Shorthand Logging).

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

- **Watcher STUCK**: Check the "Tasks" terminal in Antigravity. If you see errors, the `problemMatcher` in `tasks.json` will prevent `launch` from proceeding.
- **Reload Failed**: If `reloadWindow` doesn't pick up changes, verify that `esbuild.js` logged `✅ [watch] build finished` in the task terminal.

---

## 5. Summary of Primary Commands

| Goal | Command / Action | Standard Interface |
|---|---|---|
| **Start Everything** | `npm run cdp:shell` | CLI |
| **Start Dev Host** | `launch` | CDP Shell |
| **Apply Changes** | `exec workbench.action.reloadWindow` | CDP Shell |
| **Audit State** | `eval <expr>` | CDP Shell |
| **Package Release** | `npm run package` | CLI |

> [!TIP]
> **Checkbox Sovereignty**: Always verify build success in the "Tasks" terminal before running `reloadWindow`. If the builder is red, the reload will serve stale code.
