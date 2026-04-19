---
name: dev_cycle
description: # Dev Cycle Protocol: Extension Sovereignty & CDP Hardening
---

> [!IMPORTANT]
> **THE PRIME DIRECTIVE**
> All agent-driven development cycles, verification tests, and UI simulations MUST occur exclusively within the **Extension Development Host**. Accidental execution or discovery in the Main IDE is a critical failure.

## 1. Sovereignty Hierarchy
- **Tier 1 (Target Host):** `[Extension Development Host]` — The primary target for verification and project commands.
- **Tier 2 (Meta-Target):** `[Main Editor]` — **PROTECTED & READ-ONLY**. Authorized ONLY for meta-commands (`launch`).
- **Tier 3 (Webview Sovereign):** `[fake.html / index.html]` — The isolated execution context for Read Aloud. Often nested within Tier 1 and requires specific targeting.

### Sovereign Targeting Rules
1. **Nested Frame Isolation**: Playwright's `page.frames()` often misses Tier 3 due to VS Code's isolation. Use `targets` or `frames` to audit the tree and `eval <index>` to penetrate the correct context.
2. **Scoping Rule**: Any project command dispatched to Tier 2 is a protocol violation. The `cdp-controller` blocks these by default.

## 2. Command Pipeline: Discovery Ritual
To prevent cross-pollution of sessions, always audit the field before acting.

### 🛠 Graceful Instance Management
1. **Initialization**: `npm run cdp:shell`. The shell is a singleton.
2. **Discovery (`scan` / `targets`)**:
   - `scan`: Lists active [Extension Development Host] windows and their PIDs.
   - `targets`: Lists all pages across all contexts, including their frame counts. Essential for locating the active webview.
   - `frames`: Provides a recursive dump of all accessible frames. Use this if `find` fails.

### 🛠 Graceful Exit Ladder
When closing the dev host, the script follows a polite 3-tier ladder:
- **Tier 1 (UI Action)**: `workbench.action.closeWindow`. SAFEST way to exit.
- **Tier 2 (CDP Signal)**: `Target.closeTarget` fallback for unresponsive UI.
- **Tier 3 (OS Signal)**: `taskkill /T` (without `/F`) for clean process termination.

## 3. Persistent CDP Shell Workflow

### Phase 1: High-Integrity Setup
1. **Initialize**: Run `npm run cdp:shell`.
2. **The Wait-for-Ready Ritual**: Send `wait-for-ready`.
   - *Logic*: Combines `show read-aloud` with a non-blocking wait for `[VOICE_SCAN] SUCCESS`.
   - *Signal*: When the shell reports `✅ SYSTEM READY`, the UI is fully hydrated.

### Phase 2: The Rapid-Reload Loop ⭐
Once initialized, **NEVER** close the Dev Host unless necessary. Use this cycle:
1. **Code**: Save changes in `src/`.
2. **Build**: Verify `watch` completes the rebuild.
3. **Reload**: Send `refresh` to the active shell.
   - *Logic*: Performs `reloadWindow` + `wait-for-ready`.
4. **Audit (MANDATORY)**: 
   - **State Audit**: Run `verify-state` or `eval 1 window.__debug.store.getState()` to confirm hydration.

### Phase 3: The Audit-Audit Ritual
**EXEC-AUDIT MIRROR**: Every `exec` (command palette) action MUST be followed by a state verification.
- *Rationale*: Extension commands are asynchronous. The UI might confirm "OK" while the underlying state is still syncing.
- *Action*: `exec Readme Preview: Play` -> `wait-for-log "[STORE-SYNC-COMPLETE]"` -> `verify-state ...`

## 4. Troubleshooting the Signal
- **"NOT FOUND" (Webview)**: If `find read-aloud` fails, it is often a false negative due to nesting. Run `targets` and try `eval 1 window.frames.length`.
- **Leaked Shells**: If port 9222 is blocked, use `scan` to find the culprit PID and close it gracefully.
- **Garbled Logic**: Formatting corruption in the shell output usually indicates a race. Use `wait-for-log` to synchronize.

## 5. Summary of Primary Commands

| Goal | Command | Output / Expectation |
|---|---|---|
| **Initialize** | `npm run cdp:shell` | Singleton background shell |
| **Inventory** | `targets` / `pages` | List all pages and frame counts |
| **Deep Audit** | `frames` | Recursive frame URL dump |
| **Probe** | `find read-aloud` | Automated webview discovery |
| **Targeted Eval** | `eval [idx\|@frag] <js>` | Execute JS in a specific frame context |
| **Wake Host** | `launch` | Smart F5 launch protocol |
| **Wait for State** | `wait-for-log <str>` | Polls logs for a specific ASCII marker |
| **Full SitRep** | `status` | Full environment health check |
| **Cleanup** | `cleanup-all` | Gracefully closes all dev hosts |

## 6. Verification Rituals (v2.4.2+) ⭐
- **ASCII-First Policy**: Use explicit markers like `[STORE-SYNC-COMPLETE]` for all automation signals. Avoid emojis in scripts.
- **Intent Sovereignty**: `playbackIntentId` MUST be verified as `> 0` after hydration.
- **Recursion Guard**: If "Same State" logs flood the console, audit the Extension for redundant sync pulses.

> [!TIP]
> **Checkbox Sovereignty**: Always verify build success in the "Tasks" terminal before running `reloadWindow`. If the builder is red, the reload will serve stale code.
