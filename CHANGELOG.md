# Change Log

All notable changes to the "Virgo" extension will be documented in this file.

## [2.8.1] - 2026-04-26

### Added
- **MCP 3-State Liveness Badge**: The footer MCP badge now has three states — 🔴 unconfigured, 🔵 configured (JSON present), and 🟢 alive (server binary responds). On extension boot, if the MCP config is found, a one-shot `npx virgo-mcp --ping` probe is fired. If the binary responds with `VIRGO_MCP_OK` within 3 seconds, the badge flips green. Also fires after manual MCP install via the `Virgo: Manage MCP` command.
- **`--ping` flag on `virgo-mcp`**: The standalone MCP server now supports a `--ping` argument that prints `VIRGO_MCP_OK` and exits 0 immediately, without booting the full stdio transport. Used exclusively by the extension's liveness probe.

### Fixed
- **Plain-English Permissions Error**: Removed raw `err.message` interpolation from the data-directory write error toast. Now shows a clean path-only message without ENOENT noise.

## [2.8.0] - 2026-04-26

### Added
- **MCP Autonomous Playback Path**: The MCP `say_this_loud` tool now lifts both playback gates without any user interaction. The extension calls `authorizePlayback()` before `requestSync()` in the `onSnippetLoaded` handler, ensuring the UI_SYNC packet carries `playbackAuthorized:true`. The webview's Sovereignty Bridge auto-primes the AudioContext and sets `_userHasInteracted`, allowing MCP-injected audio to play the moment a snippet lands — even on a cold-start session with no prior user clicks.
- **Hover-Based Audio Unlock**: A one-shot `mouseenter` listener on the webview primes the AudioContext and marks the user as interacted on the very first hover. The listener self-unregisters after firing — zero overhead for all subsequent hovers. This provides a zero-click path to audio: simply glancing at the Virgo panel is enough.
- **First-Run UX Guard**: `play()` now surfaces a friendly toast instead of silently doing nothing when no content is loaded. Shows `"Open a file in VS Code to get started"` for unfocused files and `"This file type is not supported for reading"` for unsupported types.
- **Toast Dismiss Button**: All toasts now include a `✕` ghost dismiss button. Click propagation is guarded with `stopPropagation()` / `preventDefault()` to prevent the global click handler from triggering an audio context re-init that would wipe the toast container.

### Fixed
- **Neural-First Resilience**: Increased `_retryAttempts` from 3 to 5 in the playback engine, providing ~8 seconds of silent exponential backoff before surfacing an error. The `isBuffering` state is now wired to the webview store, enabling spinner feedback during retry cycles.
- **User-Facing Error Messages**: Replaced raw stack-trace error emissions in `CommandDispatcher.ts` with sanitized messages (`"Voice unavailable — please try again"`), eliminating technical noise from the user-facing toast system.
- **Toast Auto-Dismiss Timing**: Standardized auto-dismiss duration to 8 seconds across all toast types.

## [2.7.3] - 2026-04-25

### Changed
- **Full Brand Rename — `read-aloud` → `virgo`**: Eliminated all legacy `read-aloud`, `Read Aloud`, `READ_ALOUD`, `read_aloud`, and `readme-preview-read-aloud` identifiers from the source code, MCP protocol surface, and test suite.
  - **MCP Server Identity**: Registered server name changed from `"read-aloud"` to `"virgo"`. All resource URI schemes migrated from `read-aloud://` to `virgo://` (logs, session state, snippets).
  - **Exported Symbol**: `READ_ALOUD_PROTOCOLS` renamed to `VIRGO_PROTOCOLS` in `protocolHydrator.ts` and all consuming tests.
  - **Environment Variable**: `READ_ALOUD_DATA_DIR` superseded by `VIRGO_DATA_DIR` (old var kept as backward-compat fallback).
  - **Storage Key**: VS Code workspace persistence key updated from `read-aloud.active-context` to `virgo.active-context`.
  - **Internal Cleanup**: JSDoc comments, log headers (`[VIRGO LOGS START]`), test fixture workspace paths, and setup script updated to Virgo branding throughout.

## [2.7.2] - 2026-04-25

### Fixed
- **Snippet History Live-State Parity**: Resolved a three-part synchronization failure where the extension's snippet history sidebar would not reflect the live session state.
  - **MCP Root Alignment**: The standalone Virgo MCP server was writing snippets to `custom_namespace/sessions/` while the extension watched `virgo/sessions/`. Aligned `VIRGO_ROOT` so both actors use the same root directory.
  - **Active Session Sentinel**: Added `_ensureActiveSession()` to `speechProvider.ts` — the current session is now always prepended to the snippet history list even when it has zero injected snippets, mirroring the "Focused File" live-tracking UX. CDP-verified: active session `06c024f7` (title: "New session - to be named") correctly appears at the top of the list on boot.
  - **Stale Index Purge**: Removed a poisoned `sessions_index.json` containing ghost `read_aloud/...` paths left over from the pre-rename era. The index now rebuilds cleanly from a fresh disk scan on the next boot.
- **Autoplay Integrity**: Hardened the playback dispatcher to honor the MCP authorization flag, allowing MCP-driven audio to launch without requiring a prior user interaction.
- **Tab-Switch Fix**: Fixed a bug where switching tabs would incorrectly trigger a document reload and override the active snippet view.

## [2.7.1] - 2026-04-25

### Added
- **Global NPM Pre-Warming**: The MCP Configurator (`virgo.manageMcp`) now actively spawns a background `npm install -g virgo-mcp@latest` process with a native VS Code progress UI indicator. This guarantees that the target IDE has the absolute latest binary locally available the second it initializes the server, bypassing any `npx` cold-start delays.

## [2.7.0] - 2026-04-25
### Changed
- **MCP Auto-Configurator Cache Guard**: Hardened the IDE integration script (`mcpConfigurator.ts`) to explicitly inject `virgo-mcp@latest` instead of just `virgo-mcp`. This prevents `npx` from silently defaulting to stale globally-cached versions across AI IDEs, ensuring all users receive the most up-to-date server environment on initialization.
- **Publish Pipeline Isolation**: Ignored `dist-npm-mcp` and `.cdp_shell.lock` artifacts to prevent repository pollution.

## [2.6.9] - 2026-04-25
### Fixed
- **Publish Pipeline Isolation**: Fixed a race condition where an old `npm run watch` process overwrote the minified MCP script during publishing. The `mcp_publisher` skill now explicitly forces the Node hashbang (`#!/usr/bin/env node`) during the copy step, guaranteeing that the `virgo-mcp` package will execute properly on Windows via `npx` regardless of esbuild's internal state.

## [2.6.8] - 2026-04-25
### Fixed
- **MCP Auto-Execution Hardening**: Resolved an `EOF` initialization failure on Windows when connecting the standalone MCP server via Claude Desktop. Corrected an esbuild configuration issue that caused the `virgo-mcp` NPX package to be bundled without a Node hashbang (`#!/usr/bin/env node`). `npx -y virgo-mcp` now correctly executes the server instead of opening the script in an external editor.

## [2.6.7] - 2026-04-25

### Changed
- **Snippet UX Hardening**: Implemented a safe diff-update mechanism during UI refreshes to preserve session caches while scanning for missing snippets, preventing destructive cache wipes on manual refresh.
- **Configurable Root Directory**: Introduced the `virgo.system.rootDirectory` setting (default: `virgo`) and `VIRGO_ROOT` environment variable support, enabling cleaner deployments and user-partitioned project environments.

## [2.6.6] - 2026-04-25

### Added
- **MCP Auto-Configurator**: Added the `Virgo: Manage MCP` command — a one-click QuickPick menu that automatically injects Virgo's MCP server configuration into Claude Desktop, Cursor, and Cline.
- **Dynamic MCP Status Badge**: Introduced a real-time status indicator in the webview footer. The badge dynamically highlights active agent environments (e.g., "MCP Configured: Antigravity, Cursor") by scanning local persistence records, providing immediate onboarding feedback.

## [2.6.5] - 2026-04-24

### Changed
- **Brand Evolution**: Officially rebranded the extension from "Read Aloud" to "Virgo", shifting focus towards agent-driven narration and task handoffs.
- **Documentation Overhaul**: Completely rewrote the `README.md` to highlight the Agent Narrator capabilities and formally pledge a Zero-Telemetry privacy standard.
- **Development Stability**: Fixed F5 debugging collisions in `launch.json` caused by legacy namespace overlaps, ensuring a clean development loop.

## [2.6.4] - 2026-04-24

### Added
- **Instant Session History** ([#42](https://github.com/IdanDavidAviv/virgo/issues/42)): Replaced a slow per-session filesystem scan with an atomic index file, eliminating I/O stalls and title-flicker when opening the snippet history sidebar at scale.
- **Release Pipeline Optimization**: Added `release:patch:fast`, `release:minor:fast`, `release:major:fast` npm scripts. These skip the full gate re-run (lint + typecheck + test + build) when gates have already passed in the same agent session, reducing release time from ~45 s to ~7 s. `release:verify` (version sentinel) always runs.

## [2.6.3] - 2026-04-24

### Added
- **Live File Change Detection** ([#56](https://github.com/IdanDavidAviv/virgo/issues/56)): The extension now watches the focused file for external disk changes and automatically rehydrates the reader when content is modified externally.
- **Document mtime Enrichment**: Added `lastStatMtime?: number` to `DocumentMetadata` in `DocumentLoadController`, captured via `fs.statSync().mtimeMs` on load. Provides the foundation for future stale-load detection (T-035).

## [2.6.2] - 2026-04-24

### Fixed
- **Snippet History Fix — 3-Part Fix**: Resolved a compounded failure that caused the Snippet History sidebar to show zero sessions when switching to snippet mode, despite sessions existing on disk.
  - **Stat Crash Hardening** (`speechProvider.ts`): `vscode.workspace.fs.stat()` was called inside a `Promise.all` with no `try/catch`. A single failing stat (e.g., a metadata file with a locked handle) silently resolved the entire session's file collection to `null`, zeroing the snippet count and excluding the session from the UI. Each file stat is now individually guarded.
  - **Filename Parsing Fix** (`speechProvider.ts`): The snippet name extractor used a legacy `firstUnderscore` strategy that was incompatible with the current `<timestamp>.<name>.md` format (dot-separated, introduced in v2.5.9). All snippets were parsed as raw timestamp strings. Fixed with `f.replace(/^\d+\./, '')`.
  - **SyncManager Dedup Bypass** (`SyncManager.ts`): `_calculateStateHash()` did not include `snippetHistory.length` or `activeSessionId`. When `setHistory()` was called after the IPC scan, the state change emitted a hash identical to the last flush — and was silently absorbed as a no-op. The webview store was never updated. Added both fields to the hash to guarantee every `setHistory()` call reaches the webview.


## [2.6.1] - 2026-04-24

### Added
- **Shift+Arrow Chapter Navigation**: `Shift+ArrowLeft` jumps to the previous chapter; `Shift+ArrowRight` jumps to the next chapter. Plain `ArrowLeft`/`ArrowRight` continue to navigate sentences as before. Implemented in `InteractionManager.ts` via a `shiftKey` branch in the existing keyboard handler. Closes [#39](https://github.com/IdanDavidAviv/readme-preview-read-aloud/issues/39).

## [2.6.0] - 2026-04-24

> **Cumulative Milestone Release — MCP Sovereignty Arc (v2.5.1 → v2.5.12)**
> This entry retroactively marks the boundary between the foundational 2.5.x stabilization cycle and the 2.6.x feature track. No new code — this is a summary of everything shipped across the arc.

### Hardened
- **Sovereign Reactive Core** (`v2.5.1`): Refactored the entire webview runtime into a reactive state machine. Eliminated phantom priming, IPC deduplication, pause intent tracking, and UI_SYNC lock guard. `WebviewStore`, `PlaybackController`, and `CommandDispatcher` rebuilt as SSOT components.
- **Neural Prefetch Cache Sovereignty** (`v2.5.2`): Eliminated cache-poisoning regression where `AudioBridge.synthesize()` resolved text from HEAD state instead of the request payload. Added position-based deduping and a play-once backstop gate.
- **Snippet Storage Unification — MP-001** (`v2.5.3`): Migrated all MCP snippet storage from flat `read_aloud/<session>/` to canonical `read_aloud/sessions/<session>/` root. `McpWatcher` updated with pivot-aware session detection. Fixed focused-file area freezing on tab switch.
- **MCP Architecture Stabilization** (`v2.5.4`): Stabilized the MCP factory, renamed the primary tool to `say_this_loud`, hardened `TurnSentinel` sovereignty, and cleaned the `TurnManager` IPC contract.
- **StreamableHTTP Migration** (`v2.5.6`): Eliminated a 60-second agent hang caused by SSE connection backpressure. Migrated MCP transport from SSE to StreamableHTTP. Silenced `/mcp` keepalive log spam.
- **Multi-IDE Gate** (`v2.5.7`): Replaced PID-based gating with workspace-name tagging in `McpWatcher`. Added `[WS:<name>]` filename stamps to prevent cross-IDE playback contamination between sibling VS Code windows.
- **Workspace Claim Gate** (`v2.5.9` / `v2.5.10`): Introduced `.workspace_claim` file-based ownership for multi-IDE isolation. Prevented sibling windows from stomping each other's claim on construction (non-destructive write; first-window-wins).
- **CDP Shell Lifecycle** (`v2.5.11`): Pre-flight HTTP probe before CDP WebSocket upgrade. Smart Start (auto-detects open Dev Host), Smart Restart (skips close if nothing open), Exit Ritual (stops playback → closes host → releases lock).
- **Playback Latency Elimination** (`v2.5.11`): Removed `_warmUpTts()` pre-warming that caused Azure to silently drop the WebSocket, producing a 10-second hang on first synthesis. TTS now initializes lazily. CDP-verified: handshake Delta = 0ms.
- **HTTP Bridge Removed** (`v2.5.11`): Deleted the legacy HTTP server layer and removed `express`/`cors` dependencies. The extension now runs the MCP server exclusively via stdio — simpler, faster, no port conflicts.
- **Release Pipeline Unification**: Consolidated all release tooling into a single entry point for consistent, repeatable version management.

### Fixed
- **XOR Window Sovereignty** (`v2.5.12`): Closed a "first-window-wins" leak in `McpWatcher._isSessionOwnedByMe` where any sibling IDE watching the Antigravity root would auto-claim and process foreign unclaimed sessions. `allowClaim=false` now enforced for any session that is not the watcher's own `_currentSessionId`. Foreign windows are completely silent — no sidebar, no context save, no playback.

## [2.5.12] - 2026-04-23


### Fixed
- **XOR Window Sovereignty — Complete Isolation**: Closed a gap in the workspace claim gate where a sibling VS Code window (window4) would silently process and load snippets intended for another window's session. Root cause: `_isSessionOwnedByMe` applied "first-window-wins" auto-claim logic to *all* unclaimed sessions, including foreign ones it had no business touching. Fix: the call site now passes `allowClaim=false` for any session that is not the watcher's own `_currentSessionId`. Foreign unclaimed sessions are now hard-rejected at the gate — no sidebar update, no context save, no playback. Sibling windows remain completely silent.



## [2.5.11] - 2026-04-23

### Fixed
- **Playback Latency Regression (10-Second Hang)**: Eliminated a dead-socket race condition introduced in v2.5.10 where `PlaybackEngine._warmUpTts()` pre-initialized the MsEdgeTTS WebSocket too early, causing Azure to silently drop the connection. On first real synthesis, the engine hit a 10-second watchdog timeout before recovering. Fix: removed `_warmUpTts` entirely. The TTS client now initializes lazily on the first `toStream()` call. CDP-verified: TTS handshake `[DELTA]` is now 0ms, audio execution Delta is ~10ms.

### Hardened
- **Neural Synthesis Latency Telemetry**: Injected permanent `[DELTA] Xms` timestamping into `_getNeuralAudio` to surface TTS handshake duration on every synthesis request, preventing silent regressions.
- **CDP Controller — Pre-Flight Probe Logging**: Added HTTP pre-flight probe to `connectToCDP` that validates port 9222 is a live CDP host (not a dead socket from an Electron child process) before attempting Playwright WebSocket upgrade. Dead sockets now report actionable errors instead of silent hangs.
- **CDP Shell — Smart Start**: Shell now detects whether the Extension Development Host is already open on launch. If found, connects immediately. If not found, auto-fires `launch` + `wait-for-ready` before dropping to the prompt.
- **CDP Shell — Smart Restart**: `restart` command now checks if a Dev Host is actually running before attempting to close it, eliminating noise from blind `gracefulClose` calls on an empty environment.
- **CDP Shell — Exit Ritual**: `exit` is now a full cleanup ritual: stops playback (btn-stop click), gracefully closes the Dev Host, releases the `.cdp_shell.lock` file, then exits the Node process. Dev Host no longer leaks on shell exit.



## [2.5.10] - 2026-04-23

### Fixed
- **Non-Destructive Workspace Claim Write**: Fixed a race condition where a later-starting VS Code window sharing the same session ID would overwrite the first window's `.workspace_claim` file at construction time. Both windows then briefly passed the ownership check, causing both to start audio simultaneously before one stopped. `_writeWorkspaceClaim` now reads the existing claim before writing — if a foreign workspace path already owns the session, it backs off silently and respects the established ownership. First-window-wins is preserved for genuinely unclaimed sessions.

### Hardened
- **Claim Gate Tests**: Added 2 `[NON-DESTRUCTIVE]` test cases — one for `pivot()` backing off on a foreign claim, one for the constructor backing off. 392/392 tests passing.

## [2.5.9] - 2026-04-23

### Refactored
- **Workspace Claim Gate (Multi-IDE Playback Sovereignty)**: Replaced the stateful PID-based injection gate (`_knownMcpPid` + cold-start learning logic) and the subsequent workspace-tag-in-filename approach with a clean, deterministic `.workspace_claim` file protocol. At construction and at every session pivot, `McpWatcher` writes its VS Code workspace folder path to `sessions/<id>/.workspace_claim`. On every incoming snippet, it reads the claim — if the claim matches this window's workspace path, process; if not, reject as sibling IDE traffic. First-window-wins: unclaimed sessions are claimed and processed atomically. This is correct-by-design because VS Code physically enforces that no two windows can share the same workspace folder path, making it a self-enforcing, zero-configuration, per-instance discriminator. Removes all stateful PID learning, cold-start logic, and the hardcoded `READ_ALOUD_WORKSPACE` global env var from `mcp_config.json`.
- **MCP Filename Format Simplified**: Snippet filenames reverted to clean `<timestamp>.<name>.md` — no workspace tag slot. Ownership is entirely determined by the claim file, not by filename contents. The gate is format-agnostic.

### Removed
- **PID Gate Eradicated**: `_knownMcpPid` field, cold-start learning branch, MCP-restart re-learning branch — all deleted from `McpWatcher.ts`. Zero stateful cross-process tracking remains.
- **`READ_ALOUD_WORKSPACE` env var**: Removed from `mcp_config.json`. The MCP standalone process no longer attempts to embed workspace identity into filenames — it has no per-window awareness and cannot do so reliably.
- **Test Cleanup**: Removed dead HTTP bridge import from the integration test suite.

### Hardened
- **Release Pipeline**: Added confirmation gates to prevent accidental version bumps.

## [2.5.7] - 2026-04-23

### Fixed
- **Multi-IDE Gate: Eliminated Cross-IDE Playback Contamination**: Resolved a critical regression where two open VS Code windows would both play audio when only one IDE's agent injected a snippet. Root cause: `McpWatcher` auto-pivoted (`SNEAKY_PIVOT`) to any detected session regardless of origin. Fix: `PendingInjectionStore` now embeds the MCP server's `process.pid` as slot 2 of the snippet filename (`<timestamp>_<pid>_<name>.md`). `McpWatcher` reads this PID on every injection and maintains a `_knownMcpPid` registry. Injections from a different PID in a different session are hard-rejected as sibling IDE traffic. Same PID with a new session triggers an authorized pivot. Zero filesystem writes — pure in-flight check.

## [2.5.6] - 2026-04-23

### Fixed
- **MCP Transport: Eliminated 60-Second Agent Hang (StreamableHTTP Migration)**: Replaced the legacy `SSEServerTransport` with `StreamableHTTPServerTransport` (stateless mode) in `mcpBridge.ts`. The root cause was an architectural mismatch — the MCP SSE client discards the POST response body (`await response.body?.cancel()`) and waits for results on a persistent SSE stream. When that stream was evicted or stale, the agent hung for the full 60-second timeout. StreamableHTTP is stateless: every POST contains the full request and the response body contains the full result. No sessions, no eviction, no hangs.
- **MCP Proxy: Matched Transport to Bridge**: Updated `mcp-stdio-proxy.mjs` to use `StreamableHTTPClientTransport` instead of `SSEClientTransport`, completing the end-to-end transport upgrade. The proxy now connects to `/mcp` instead of `/sse`.
- **Removed Session Management Complexity**: Deleted the `_transports` session map, the handshake gate (`_isHandshaking`), the handshake timeout, and the absorbed-probe counter from `mcpBridge.ts`. ~120 lines of session churn logic eliminated.

## [2.5.5] - 2026-04-23

### Fixed
- **MCP Bridge Audio Engine Hang**: Fixed a critical race condition where the `mcpBridge` direct-execution fallback double-emitted the `injected` event, causing the Webview engine to stall during session-less tool calls.
- **Release Prestige Pipeline (Double Bumping)**: Re-architected the `package.json` release scripts so that Quality Gates (`lint`, `test`, `build`) run *before* the version is bumped. This prevents the version from incrementing if tests fail, allowing safe retries with `npm run release:patch`.

## [2.5.4] - 2026-04-23

### Changed
- **Renamed `inject_markdown` → `say_this_loud`**: The primary MCP tool has been renamed to better reflect its purpose — surfacing agent narration in the Read Aloud sidebar. All call sites, tests, and documentation updated.
- **Renamed `brainRoot` → `sessionsRoot` in `McpConfig`**: Eliminated conceptual drift — the field always pointed to the sessions root, not the brain governance directory. Updated in `mcpFactory.ts`, `mcpBridge.ts`, and `mcpStandalone.ts`.

### Removed
- **`registerPrompts()` and all MCP Prompts**: Removed the `read_aloud_boot` prompt and its registration logic. MCP prompts are not auto-executed by Gemini agents; behavioral governance is now enforced exclusively via `GEMINI.md` §12 directives.
- **`protocols` resource**: Deleted the `read_aloud://protocols/...` resource serving pipeline. Protocol files remain on disk for reference but are no longer registered as MCP resources.
- **`_injections` in-memory array**: Removed `PendingInjectionStore._injections[]` — a leaky, redundant in-memory cache. Replaced with `countOnDisk()` which reads directly from the filesystem, eliminating the source of truth split.
- **`_activeServers: Set<McpServer>`**: Collapsed the aspirational multi-instance server set into a single `_server: McpServer | null` field. The MCP bridge always hosts exactly one server instance.
- **`_instanceCounter` and monkey-patching**: Removed `McpBridge._instanceCounter` and the `(server as any)._readAloudInstanceId` property assignment — dead code with no callers.
- **100ms SSE storm debounce (`[Gate 3]`)**: Removed the artificial `setTimeout(resolve, 100)` delay on every SSE connection. The `_isHandshaking` 204-gate already provides storm protection without adding latency.
- **`hydrateProtocols()` side-effect in factory**: Removed the call to `hydrateProtocols()` inside `createReadAloudMcpServer`. This was a boot-time side-effect with no callers in the production path.
- **`sendPromptListChanged()` from `reinitialize()`**: Removed prompt list broadcast since prompts are no longer registered.

### Fixed
- **Dynamic version in `McpBridge`**: The `/health` endpoint and server metadata previously reported a hardcoded `"2.4.5"`. Version is now sourced from `context.extension.packageJSON.version` at runtime and passed via the `McpBridge` constructor.
- **Dynamic version in `mcpStandalone.ts`**: Replaced `require('../../../package.json')` (incompatible with esbuild bundling) with a build-time `__APP_VERSION__` constant injected via `esbuild.js` `define`.
- **`TurnSentinel` blocking on index drift**: The turn manager previously threw a hard exception when detecting a non-sequential turn index, silently breaking injection recovery. Downgraded to a non-blocking warning with auto-increment, preserving injection continuity.
- **`get_injection_status` memory leak**: The tool previously relied on the (now-removed) in-memory `_injections` array for its count. Now reads from `countOnDisk()` — filesystem-authoritative and always accurate.

### Documentation
- **Enriched `say_this_loud` tool description**: The tool definition now contains a comprehensive behavioral mandate, ensuring connected agents understand session ID discovery, verbatim parity rules, and turn-index semantics without requiring separate skill files.
- **`GEMINI.md` §12 — Read Aloud MCP Narration Mandate**: Formalized a "Boot Ritual" (diagnostic + state read) and "Per-Turn Narration Loop" as mandatory agent directives, replacing the unreliable MCP Prompts boot mechanism.

## [2.5.3] - 2026-04-23

### Fixed
- **Orphaned Snippet Regression (Root Fix — MP-001)**: MCP injections were writing to `brain/<sessionId>/` while `McpWatcher` and `_getSnippetHistory()` scanned `read_aloud/sessions/<sessionId>/` — a path mismatch that caused all AI-injected snippets to silently disappear from the sidebar. Unified the canonical storage root to `read_aloud/sessions/<id>/` across the full pipeline (`extension.ts`, `speechProvider.ts`, `mcpStandalone.ts`).
- **Double Path Concatenation in `updateSessionContext()`**: `SpeechProvider.updateSessionContext()` was appending `read_aloud` to an already-resolved root, producing malformed paths like `sessions/<id>/read_aloud/<id>/`. Fixed by passing the pre-resolved `sessionsRoot` directly from the extension bootstrap.
- **Metadata File Leakage in Sidebar**: `extension_state.json` and other non-snippet metadata files were appearing as playable items in the Snippet History sidebar. Added a strict `.md`/`.markdown`-only filter in `_getSnippetHistory()`.
- **`injected` Event Orphaned**: The `mcpBridge.on('injected')` listener was silently decommissioned in a previous refactor, breaking real-time sidebar refresh on injection. Re-wired to call `speechProvider.refreshView()` — a lightweight history-only sync that does not interrupt active playback.
- **Focused File Area Frozen on Tab Switch**: `SyncManager._calculateStateHash()` did not include `focusedFileName` or `focusedVersionSalt`. Tab switches mutated focused file state but produced an identical dedup hash → sync was silently absorbed → Focused File area never updated. Fixed by adding both fields to the hash.

### Refactored
- **Canonical Session Root (`sessions/`)**: All session-scoped data (snippets, `extension_state.json`) now lives exclusively under `read_aloud/sessions/<sessionId>/`. The `read_aloud/` root contains only non-session shared resources (`protocols/`, `tempmediaStorage/`, `active_servers.json`).
- **Renamed `antigravityRoot` → `readAloudRoot`**: Clarified internal variable naming in `extension.ts` and `SpeechProvider` to accurately reflect what the path points to.
- **Cleared `EXCLUDED_DIRS`**: The now-empty exclusion set in `_getSnippetHistory()` is correct — system directories are no longer reachable from `sessions/`, making the filter redundant. Retained as an empty typed set for future extensibility.

### Migration
- **Idempotent Data Migration**: Executed a PowerShell migration script (`migrate_sessions.ps1`) consolidating 22 legacy flat `read_aloud/<id>/` session directories into `read_aloud/sessions/<id>/`. Result: 20 moved, 2 merged (duplicate-safe), 0 data loss, 0 errors.


## [2.5.2] - 2026-04-23

### Fixed
- **Cache-Poisoned Prefetch (Root Fix)**: `synthesize()` was always resolving sentence text from `state.currentSentenceIndex` (HEAD=0) regardless of the `cacheKey` received. All three concurrent prefetch calls for N+1, N+2, N+3 therefore stored HEAD audio under wrong keys — user heard the first sentence 4 times before the document advanced. Fixed by passing `text` alongside `cacheKey` in `REQUEST_SYNTHESIS` from `_processQueue()` and using it directly in `synthesize()`.
- **Prefetch `playAudio` Flooding**: Prefetch synthesis completions in `_speakNeural()` were emitting `playAudio` unconditionally regardless of `isPriority`. All N+1/N+2/N+3 completions triggered simultaneous audio — causing the "audio mess" regression. Fixed with an `if (!isPriority) return` guard: non-priority paths now push to cache only and never emit `playAudio`.
- **Head-Exclusion Enforcement (RC-1)**: `_processQueue()` included the HEAD sentence (N+0) in its prefetch candidate window, creating dual synthesis authority with `audioBridge.start()`. Fixed by advancing the window to `slice(currIdx + 1)`.
- **Cache Key Schema Mismatch (RC-2)**: `_processQueue()` did not pass the `isNeural` flag to `generateCacheKey()`, producing a different hash than the extension and bypassing all dedup guards. Fixed by explicitly passing `isNeural`.

### Hardened
- **AudioBridge Play-Once Backstop Gate**: Added `_lastPlayAudioCacheKey` tracking to `_emitWithIntent()`. Suppresses any duplicate `playAudio` emission for the same cache key (defense-in-depth after root fixes). Resets on intent change and `stop()`.
- **CDP Dev Cycle — Mandatory Stop Before Exit**: Codified a Phase 4 protocol in `cdp_dev_cycle` SKILL.md requiring playback to be stopped before `exit` to prevent log pollution from free-running audio.

## [2.5.1] - 2026-04-22

### Fixed
- **Phantom Sovereign Events (Intent 0)**: Replaced the in-place `_audio.play()` priming call with a throwaway `Audio` element, isolating the silent prime from the main audio element's event stream and eliminating ghost `PLAYING`/`PAUSED` Sovereign Events before the first user interaction.
- **Double-Fired IPC Handlers**: Removed duplicate `SYNTHESIS_READY`, `DATA_PUSH`, `CLEAR_CACHE_WIPE`, and `PURGE_MEMORY` listeners from `PlaybackController.setupListeners()`. These were already exclusively registered by `CommandDispatcher.mount()`, causing 2× `FETCH_AUDIO` per synthesis and double `canplay` events.
- **Pause Intent Corruption**: Refactored `PlaybackController.pause()` to read `store.getState().playbackIntentId` instead of calling `store.resetPlaybackIntent()`. Pause is a continuation, not a cancellation — bumping the intent counter caused in-flight `PLAY_AUDIO` packets to be rejected mid-sentence.
- **UI_SYNC Lock Destruction**: Added a guard in `PlaybackController.handleSync()` to only call `releaseLock()` when the engine is not actively playing. Previously, every 2-second `UI_SYNC` heartbeat unconditionally released the `isAwaitingSync` protection, flipping the play button back to ▶ during live synthesis.

### Hardened
- **CDP Audit Pre-Flight**: Added `close-host` and `restart` shell commands to `cdp-controller.mjs`, enabling a fully autonomous cold-boot sequence (close → wait → launch → wait-for-ready) as a mandatory pre-flight reflex before all lifecycle audit sessions.



## [2.5.0] - 2026-04-20

### Fixed
- **Neural Synthesis Stall**: Resolved a silent-playback regression caused by a deferred initialization bug inside `PlaybackEngine`, forcing immediate WebSocket disposal and re-initialization during corrupted state retry loops.

### Hardened
- **State Sovereignty (Split-Brain Prevention)**: Hardened `WebviewStore` to safely filter `playbackIntent` and intent IDs from stale `UI_SYNC` packets, entirely eliminating UI state oscillation and "Play/Stop loops".
- **Dynamic Baked Rate Sync**: Refactored the Neural Synthesis pipeline to synchronize the relative "baked rate" directly into the `WebviewAudioEngine` (`setRate` / `setVolume`).
- **Seamless Audio Control**: Real-time volume and speed adjustments now natively modify HTML media element properties instantly without stopping or re-triggering playback.
- **Protocol Parity**: Fortified the diagnostic testing suite, bringing it to a flawless 100% pass rate (386/386) across rigorous Webview and Core unit tests.

## [2.4.6] - 2026-04-20

### Fixed
- **Playback Sync Loop**: Resolved a critical UI oscillation bug by refactoring `PlaybackController.play()` to use atomic intent updates.
- **Silent Stop Protocol**: Hardened `PlaybackEngine.stop()` to suppress transient state emissions during rapid audio initialization sequences, preventing optimistic UI listeners from creating intent loops.
- **Test Integrity**: Resolved Promise resolution timeouts and DOM event listener race conditions across the Webview and Core test suites to align with the new optimistic playback architecture.

## [2.4.5] - 2026-04-19

### Fixed
- **Neural Synthesis Deadlock**: Resolved a state deadlock where the engine could become permanently `STALLED` after network failures.
- **Autoradiant Routing**: Hardened the AudioBridge to automatically fallback to local synthesis when neural health is compromised, verified via new unit tests.
- **Voice Mapping & State Locks**: Resolved race conditions in `CommandDispatcher` that caused loading state deadlocks during rapid voice changes.
- **Playback De-duplication**: Eliminated redundant event emissions in the Push-on-Hit path to prevent double-playback and audio corruption.

### Improved
- **Webview Reactivity**: Hardened state transitions in `WebviewStore` for more accurate tracking of synthesis and playback intent.
- **MCP Bridge Stability**: Enhanced connectivity logic and error handling for the standalone MCP bridge.
- **Forensic Visibility**: Updated CDP controller scripts and added decision matrix logging to `AudioBridge` for clearer routing transparency.

### Added
- **Manual Health Recovery**: The UI "Refresh" button now explicitly resets neural engine health to break persistent stalls.
- **Self-Healing Probes**: Implemented a 5-minute automatic probe window to allow the engine to attempt recovery from stalled states without user intervention.

## [2.4.4] - 2026-04-19

### Fixed
- **MCP Handshake Stability**: Implemented 100ms storm-debounce and `204 No Content` logic for parallel SSE probes to eliminate `429 Too Many Requests` retry loops.
- **Autoplay Recovery**: Redirected `PLAYBACK_BLOCKED` events to a recoverable `PAUSED` state instead of engine reset, enabling browser-level policy recovery via the UI.
- **Library Corruption False-Positives**: Decoupled `stop()` from automatic TTS re-initialization to prevent misleading corruption diagnostics during normal playback termination.

### Hardened
- **Shell Sovereignty**: Enforced a mandatory `.cdp_shell.lock` mechanism in the CDP controller to prevent parallel bridge contention and process leakage.

## [2.4.3] - 2026-04-19

### Fixed
- **UI Integrity Restoration**: Reverted unauthorized styling and string changes to maintain design consistency.
- **Action Alignment**: Restored high-fidelity alignment for settings action buttons.

### Hardened
- **CDP Diagnostic Pipeline**: Optimized lifecycle controller for robust webview discovery and reliable character transmission.
- **Neural Voice Discovery**: Stabilized `VoiceManager` via exponential backoff and `PlaybackEngine` handshake gating to prevent cold-boot race conditions.

## [2.4.2] - 2026-04-12

### Added
- **Premium Settings Popover**: Migrated audio settings from a static card to a footer-anchored, glassmorphism-enhanced popover (`backdrop-filter: 28px blur`).
- **Engine-Aware Pill Trigger**: Repurposed the V/R indicator as an interactive status pill that provides real-time visual feedback (Cyber Blue for Local, Amber Gold for Neural) and toggles the settings overlay.
- **Dynamic Exit Rituals**: Implemented bouncy `cubic-bezier` entry/exit animations for the settings popover to ensure a fluid, high-integrity interaction model.

### Changed
- **UI Footprint Optimization**: Decommissioned the legacy "AUDIO SETTINGS" card, significantly reclaiming vertical space in the dashboard for the chapter list.
- **Unified State Mapping**: Refactored `SettingsDrawer` to directly bind to the new popover DOM structure, simplifying the component registry and cross-context synchronization.

## [2.4.1] - 2026-04-11

### Added
- **Internal Log Sovereignty**: Removed all external `forensics.log` dependencies in favor of high-density internal memory buffers.
- **Noise-Filtered Observation**: Implemented automatic Tier 3 noise suppression (renders, sync signals) in the CDP controller to ensure signal-heavy diagnostics.

### Fixed
- **Stability Exit Ladder**: Hardened Tier 1 and Tier 2 exit rituals to distinguish between "already clean" transitions and actual process failures.
- **Store Signal Hardening**: Injected `[STORE-SYNC-COMPLETE]` markers to provide deterministic visibility for automated UI validation.

## [2.4.0] - 2026-04-10

### Hardened
- **Sovereign Dev-Host Protocol**: All automated UI simulations are now strictly isolated to the Extension Development Host. Implemented a `Promise`-based sequential execution queue in the CDP controller to prevent character scrambling and race conditions during developer loops.
- **Discovery Heuristics**: Refactored webview discovery logic to prioritize the "Extension Development Host" targets and implemented strict URL-based exclusion (`vscode-webview://`) of system webviews (e.g., Media Preview).
- **Command Palette Reliability**: Automated mandatory `>` prefix injection for terminal-driven UI simulation, ensuring VS Code always interprets inputs as commands.

### Added
- **Immediate Auditory Sampling**: Voice selection now triggers an immediate synthesis of the current sentence, providing real-time auditory feedback for the selected identity.
- **Selection Mode Sovereignty**: Introduced `isSelectingVoice` state flag to suppress automatic sentence advancement while the user is sampling voices.
- **Authoritative Committal**: Implemented "Batch-Intent Reset" upon committing to a new voice, ensuring all future prefetch tasks use the newly selected identity.

### Improved
- **Neural Rate Traceability**: Standardized neural rate scale calculations and added high-density logging for relative rate patching (`[NEURAL_RATE]`).
- **Initialization Parity**: Added `inspect()` mocks to VS Code settings tests to prevent runtime errors during configuration discovery.

## [2.3.2] - 2026-04-10

### Hardened
- **State Reset Logic**: Fixed a regression where the `isBuffering` state remained stuck after stopping playback. `CommandDispatcher` now atomically resets all loading states on `STOP`.
- **Initialization Gate (Ghost Focus)**: Implemented a "Dual-Precondition Gate" in `SpeechProvider` to prevent redundant document extraction calls during passive tab switching.
- **Diagnostic Infrastructure**: Fixed reference errors in `cdp-controller.mjs` to enable reliable webview state verification via CDP.

## [2.2.2] - 2026-04-07

### Stabilized
- **Webview State Management**: Hardened `WebviewStore` to automatically hydrate on the first remote sync, resolving initialization test failures.
- **Race Condition Resolution**: Optimized `isAwaitingSync` reset timing to eliminate UI flicker and ensure engine handshake completion before dismissing loading states.
- **Testing Integrity**: Integrated `WebviewStore.resetInstance()` across all suites to prevent cross-test state pollution, achieving 100% (191/191) pass rate.

## [2.2.1] - 2026-04-07

### Stabilized MCP Infrastructure & Audio Mutex
This patch addresses critical race conditions in the synthesis pipeline and hardens the MCP discovery architecture for improved reliability in multi-session environments.

#### 1. MCP Discovery Hardening
- **Unified Logging Layer**: Introduced `LogReporter` in `src/common/mcp/logReporter.ts` to centralize diagnostic telemetry and eliminate redundant filesystem lookups.
- **Secure URI Parsing**: Added robust `sessionId` and `protocol` guards in `mcpFactory.ts` to prevent runtime errors during tool-injected text discovery.
- **Isolated Core Strategy**: Refactored `sharedStore` and `mcpStandalone` into the `@mcp-core` domain to prevent alias collisions with the extension's main `@core` business logic.

#### 2. Audio Stability (Race Condition Prevention)
- **Playback Mutex (playbackLock)**: Implemented a mandatory `playbackLock` in both `NeuralAudioStrategy` and `LocalAudioStrategy` to ensure atomic blob ingestion and prevent "Ghost Audio" collisions during rapid navigation.
- **Proactive Blob Revocation**: Hardened the audio teardown sequence to guarantee `URL.revokeObjectURL` is called for every active stream, eliminating memory pressure.

#### 3. Maintenance & Developer Experience
- **Test Suite Restoration (100% Pass Rate)**: Restored 16 broken test suites by consolidating `vitest.config.ts` and correcting system-wide path aliases (`@mcp`, `@mcp-core`).
- **E2E Verification**: Integrated `mcp_injection_e2e.test.ts` for full-spectrum validation of the "Vocal Sync" injection mechanism.

## [2.2.0] - 2026-04-07

### Added
- **Dual-Environment Isolation**: Implemented `extensionMode` tagging in the MCP registry, allowing concurrent Development and Production instances to operate without resource collisions.
- **"Stealing" Singleton Protocol**: Re-engineered the MCP proxy to allow latest-spawned instances (Antigravity Host) to reclaim the lock from stale background processes, ensuring 100% startup reliability.
- **Resource Pruning (Performance)**: Capped dynamic MCP resources (Sessions/Snippets) to the 10 most recent items to prevent discovery timeouts in large project histories.
- **Atomic Registry Pattern**: Migrated to a Rename-based atomic write protocol for the MCP registry, preventing file corruption during high-frequency concurrent teardowns.
- **PID-Hardenend Diagnostics**: Injected Process IDs (PIDs) into log streams and handshake diagnostics for absolute instance traceability.

### Changed
- **Dev-First Prioritization**: The MCP Stdiod Proxy now automatically prioritizes Development hosts over Production ones, with seamless failover logic.
- **Consolidated Resource Discovery**: Refactored the internal `McpBridge` to use in-memory constructor injection for log paths, eliminating redundant filesystem lookups.

## [2.1.3] - 2026-04-06

### Changed
- **Decoupled Audio Strategy**: Finalized the separation of `LocalAudioStrategy` and `NeuralAudioStrategy`. `WebviewAudioEngine` now acts as a clean orchestrator, drastically reducing monolithic complexity.
- **Legacy Decommissioning**: Removed the legacy compatibility proxy layer in `WebviewAudioEngine` (`base64ToBlob` and `sovereignUrl` bindings) following the strategy refactor.
- **Ghost Audio Guard**: Hardened the cache-wipe protocol (`CacheWipeSovereignty`). The engine now guarantees `URL.revokeObjectURL` is executed *before* IndexedDB clearing, eliminating memory leaks and transient "ghost" audio playback.
- **Intent Sovereignty**: Updated backend `PlaybackController` logic to properly prime `intent-gating`, bypassing the `ZombieGuard` block during rapid initialization tests.
- **Test Suite Robustness (100% Pass Rate)**: Achieved a green 330-test suite by formalizing the **Reset-Initialize-Spy** pattern across singleton-based tests (`WebviewStore`, `WebviewAudioEngine`, `CommandDispatcher`) to eliminate state leakage between parallel executions, and refined JSDOM mocks for stable audio tracking.
## [2.1.2] - 2026-04-06

### Added
- **Architectural Modularization (Service Layer Parity)**: Decommissioned the monolithic `SpeechProvider` in favor of a lean orchestrator pattern supported by dedicated micro-services for improved testability and isolation.
- **SettingsManager**: Extracted all configuration loading, legacy migration, and document progress persistence logic.
- **VoiceManager**: Centralized voice discovery, caching, and broadcasting protocols.
- **McpWatcher**: Dedicated service for tracking and synchronizing MCP-specific configurations.
- **Optimistic State Updates**: Implemented immediate `StateStore` hydration in `SettingsManager` to ensure zero-latency UI responsiveness during background persistence cycles.
- **Hardened Lifecycle Protocol**: Integrated cascading `dispose()` calls across all services, ensuring absolute resource cleanliness and zero memory leaks upon extension deactivation.
- **Atomic Handshake Recovery**: Stabilized the dashboard initialization handshake to proactively sync voices before the initial state broadcast.

## [2.1.1] - 2026-04-06

### Silent Physics & Zero-Interrupt Audio
This patch decommissions the intrusive "Audio System Locked" shield introduced in the previous iteration and replaces it with a **Silent Prime** strategy. This ensures high-fidelity playback parity with browser safety protocols without obstructing the user interface.

- **Silent Context Priming**: Implemented a background "warm-up" mechanism that blesses the `AudioContext` on the first user interaction (click or keypress) without needing an overlay.
- **Zero-Interrupt UI**: Completely removed the glassmorphic shield components, animations, and associated state logic for a 100% unobstructed experience.
- **NotAllowedError Resilience**: Hardened the `WebviewAudioEngine` to silently manage browser-enforced autoplay blocks, ensuring the system is "always ready" for subsequent automated injections.
- **Structural Integrity**: Repaired critical syntax corruption in the core audio engine resulting from previous multi-file sync operations.

## [2.1.0] - 2026-04-05

### Added


### Sovereign Playback & Hierarchical Audit
This release formalizes the **Prestige Release Protocol** with the introduction of the **Hierarchical Audit**, providing full-spectrum visibility into the extension's architectural trajectory. It also marks the debut of the **Sovereign Playback Engine**, a hardened synchronization layer that eliminates "Ghost Audio" and ensures absolute intent-aware synthesis parity.

#### 1. Hierarchical Audit Protocol
- **Trajectory Discovery**: Enhanced `version_sentinel` with flag-driven auditing (`--patch`, `--minor`, `--major`) to capture deep architectural shifts across release cycles.
- **Surgical Diff Analysis**: Automated the sanitization and grouping of commit deltas for high-context changelog generation.
- **Release Prestige**: Automated the "Burn" pipeline to ensure 100% synchronized versioning across `package.json`, `CHANGELOG.md`, and VSIX metadata.

#### 2. Sovereign Playback (Intent-Aware)
- **Monotonic Intent IDs**: Introduced `playbackIntentId` in `PlaybackEngine` to provide authoritative rejection of stagnant audio buffers from previous navigation intents.
- **Resource-Strict Mapping**: Updated the `WebviewAudioEngine` to bind audio streams strictly to their originating resource URIs, preventing "Zombie" playback across file transitions.
- **Telemetry Hardening**: Added `Number.isFinite` and composite object guards in the `WebviewStore` to prevent state corruption during high-frequency synchronization.

#### 3. MCP Bridge Hardening
- **Turn Manager Architecture**: Refactored `TurnManager` into a high-integrity singleton for centralized turn-index tracking and sequence validation.
- **Protocol Hydration**: Automated the generation of oral and visual turn headers (`# [Turn XXX]`) for virtual document injections via the MCP bridge.
- **Multi-Root Workspace Parity**: Standardized path-agnostic metadata resolution to ensure persistent session history across complex VS Code workspaces.

## [2.0.8] - 2026-04-05

### Added
- **Store Hydration Sovereignty**: Hardened `WebviewStore` against premature asynchronous syncing. UI and Cache updates are now rejected until a fully formed `UI_SYNC` handshake establishes the baseline.
- **Cache Statistical Parity**: Enforced strict `updateState` object alignment so the webview mirrors the exact `{ count, size }` composite data structures sent by the extension.
- **Control System Audit**: Stabilized the `control_system_audit` tests by enforcing proper asynchronous dispatching and accurate backend object modeling.

### Fixed
- **Neural Buffer Ghost Wipe**: Resolved a test-environment regression in `NeuralCache.test.ts` where delayed promise resolution from async memory wipes (`AudioEngine`) would silently overwrite the state of sibling test suites.

## [2.0.7] - 2026-04-05

### Added
- **IPC Protocol Hardening**: Decoupled `availableVoices` from the high-frequency `UI_SYNC` packet, significantly reducing routine synchronization bandwidth.
- **Log Level Parity**: Synchronized `readAloud.logging.level` from the extension host to the webview, enabling consistent diagnostic telemetry across the bridge.
- **Shorthand Log Sanitization**: Implemented payload truncation for massive IPC commands (Voices, Sync) in `Standard` logging mode to eliminate console bloat.
- **Turn Sentinel Sovereignty**: Added TDD-backed logic to reject stale or out-of-order text injections in the MCP bridge.
- **Cache Wipe Integrity**: Implemented proactive memory purging and blob URL revocation before cache clearing to prevent audio "ghosting."

### Fixed
- **Sync Signature mismatch**: Resolved a TypeScript lint error in `SpeechProvider.ts` caused by outdated `_syncUI` parameters.

## [2.0.6] - 2026-04-05

### Added
- **Brain-Sensitive Pivoting**: Integrated a `FileSystemWatcher` on the Antigravity root to detect new session directories in real-time and trigger automatic session pivots in the extension.
- **Identity Bootstrapping**: Automated the creation of a default "New session - to be named" title in `state.json` for every new bridge session, ensuring a premium first impression in the sidebar history.
- **Protocol Reinforcement**: Formalized mandatory **Genesis** and **SITREP** text injections to maintain 1:1 parity between agent-led sessions and the portable Read Aloud history.
- **Hardened Release Integrity**: Re-engineered the Prestige Audit to capture uncommitted changes and strictly separated Discovery from Execution in the release pipeline.

### Fixed
- **Invisible Session Bug**: Resolved a critical UI bug where the currently active session would disappear from the "Snippet History" sidebar if it contained zero snippets. Active sessions are now always visible.

## [2.0.5] - 2026-04-05

### Added
- **Critical UI_SYNC Command**: Promoted synchronization to a critical IPC command, ensuring background injections hydrate the webview state even when hidden.
- **Visibility-Aware Sync**: Implemented a "Full Sync" trigger for the sidepanel to immediately re-hydrate snippet history upon sidebar reveal.
- **Verbatim Parity Protocol**: Standardized 1:1 parity between conversational summaries and auditory injections for high-integrity vocal sync.

### Fixed
- **Snippet UI Latency**: Resolved an issue where snippet history would only update after a manual toggle or playback event.

## [2.0.4] - 2026-04-05

### Added
- **Humanized Session Titles**: Refactored the "Snippet History" sidebar to resolve and display human-readable session names instead of UUIDs.
- **Local Metadata Persistence**: Migrated session `state.json` storage from core agent directories to the extension-local `read_aloud` data store for absolute architectural decoupling.
- **MCP Title Injection**: Updated Antigravity MCP servers to accept and persist an optional `session_title` parameter, allowing for seamless narrative context during text injection.
- **Premium Glassmorphism**: Enhanced the `SnippetLookup` component with vibrant background blurs and optimized list haptics.
- **Automated Metadata Migration**: Implemented a transition layer to bulk-migrate historical session titles to the new local persistence model.

### Fixed
- **UI State Flickering**: Resolved a race condition where snippet titles would momentarily reset to UUIDs during high-frequency synchronization events.

## [2.0.3] - 2026-04-04

### Vocal Sync & UI Persistence
This release formalizes the **Vocal Sync Protocol** by automating turn-index management in the MCP bridge and standalone servers. It also resolves a critical UI bug where the snippet history list would flicker or disappear during high-frequency playback updates.

#### 1. Automated Turn Management
- **Persistent Indexing**: Implemented an atomic turn-state tracking mechanism per session using a local `state.json` store.
- **Turn Index Feedback**: New injections now automatically prepend a `# [Turn XXX]` header to the markdown content, providing oral and visual serialization context.
- **Session-Aware Watcher**: Refactored the Antigravity root watcher to handle automated session-id pivoting and conditional auto-play based on user settings.

#### 2. UI Synchronization & Stability
- **Sync Guardian Protocol**: Hardened `WebviewStore.ts` delta-sync logic to preserve `snippetHistory` and `activeSessionId` during partial state updates.
- **Improved Performance**: Refactored `SnippetLookup` to use stabilized history arrays, reducing redundant renders and layout shifts.
- **Autoplay Control**: Exposed `playback.autoPlayOnInjection` in settings to allow user-controlled immediate playback of tool-injected content.

## [2.0.2] - 2026-04-04

### Stable Sovereignty & Navigation
This release addresses critical UI state regressions by implementing the **Mode Sovereignty Protocol**. By establishing a 500ms immunity window on the `activeMode` intent, the extension now reliably protects user navigation from stale `UI_SYNC` packets during heavy document parsing. Additionally, the Antigravity navigation has been refactored into a high-density, 2nd-layer drill-down system with reactive "Premium Glow" indicators to ensure seamless visual parity between file and snippet sources.

## [2.0.1] - 2026-04-04

### Antigravity Bridge Genesis
- **Antigravity Stream Protocol**: Establishing the `ReadAloud-Bridge`, allowing external AI agents to stream and inject Markdown content directly into the neural synthesis pipeline.
- **Virtual Document Sovereignty**: Implemented atomic `activeMode` transitions ('FILE' vs 'SNIPPET') to ensure the webview dashboard correctly hydrates and tracks virtual content injected via the MCP bridge.
- **Persistent Injection Store**: Integrated a file-backed persistence layer for external snippets, ensuring that injected AI content survives VS Code session restarts with full navigation parity.

## [2.0.0] - 2026-04-04

### Major System Re-architecture
This release marks the baseline transition to a modernized, reactive architecture designed for scalability and reduced latency. The system has been restructured into a domain-driven model to ensure strict separation of concerns and improved maintainability.

#### Domain-Driven Architecture Implementation
- **Structural Decoupling**: Segregated the monolithic legacy extension logic into distinct `@core` (business logic), `@vscode` (host integration), and `@webview` (interface layer) domains.
- **Reactive State Management**: Implementation of a centralized `WebviewStore` based on a predictable state container pattern to eliminate synchronization errors common in the legacy monolithic bridge.
- **Enhanced Inter-Process Communication (IPC)**: Standardized messaging using an enum-driven `MessageClient` bridge, improving the reliability of commands between the extension host and the webview renderer.

#### Neural Synthesis and Performance Optimizations
- **Direct Variable-Length Audio Distribution**: Optimized binary transmission to push audio data directly into the webview's internal cache, reducing the overhead associated with redundant IPC handshakes.
- **Predictive Prefetching Engine**: Integrated an asynchronous look-ahead processor with a five-sentence circular buffer to provide continuous playback and eliminate gaps between segments.
- **State Sovereignty and Synchronization Guardians**: Introduced isolation windows and synchronization watchdogs (3.5s and 4.0s timeout thresholds) to resolve race conditions and recycle stalled synthesis threads.

#### Componentized Interface and User Experience
- **Functional Component Migration**: Extracted all dashboard UI logic into isolated, reactive ESM modules for improved lifecycle management.
- **Integrated Voice Discovery**: Implemented a filtered voice selection mechanism with real-time feedback and support for specialized high-fidelity neural voices.
- **Context-Aware Document Parsing**: Added specialized processing for technical artifacts, including markdown code blocks (with language metadata detection) and statistical summaries for tabular data.

#### Quality Engineering and Verification
- **Automated Regression Suite**: Expanded test coverage (+4,400 lines) with a high-integrity verification pipeline, achieving full pass rates across 250 test cases.
- **Deterministic State Persistence**: Migrated configuration state to the standard `settings.json` format and implemented MD5-based content hashing to track reading progress across file modifications.

---

## [1.6.4] - 2026-04-04

### Added
- **Delta Sync Protocol**: Introduced partial state synchronization to optimize IPC bandwidth; moved `availableVoices` to an explicit handshake phase.
- **Throttled Synchronization**: Implemented 50ms sync-throttling in `SpeechProvider` to prevent command saturation.
- **Haptic Prefetch Alignment**: Synchronized `AudioBridge` look-ahead logic with the new 200ms debounce architecture.

### Fixed
- **Test Suite Isolation**: Eliminated non-deterministic regressions in `audioBridge` and `RaceCondition` tests via strict `afterEach` cleanup protocols.
- **TypeScript Type Integrity**: Resolved "unknown" type diagnostic errors in the voice discovery integration tests.

## [1.6.3] - 2026-04-04

### Added
- **Unified Playback Controller**: Restored `src/webview/playbackController.ts` based on stable `dashboard.js` logic to ensure architectural parity across modern components.
- **Fail-Safe Synchronization**: Implemented a 3.5s "Sync Watchdog" to prevent UI hanging during non-deterministic extension-to-webview handshakes.
- **Atomic Intent Logic**: Standardized `CONTINUE` vs `LOAD_AND_PLAY` actions within the singleton controller for predictable playback transitions.

## [1.6.2] - 2026-04-03

### Added
- **Document Loading Sovereignty**: Implemented a 2000ms "Sovereignty Window" for the `LOAD_DOCUMENT` action to protect the UI from stale synchronization data during heavy parsing.
- **Isolated Loading Feedback**: Redirected "Loading Document..." feedback exclusively to the **Reader (Active File)** slot; the **Focused File** context now remains stable and evidence-based.

### Fixed
- **Stuck Loading Button**: Resolved a UI state bug where the "Load File" button became non-interactive after a single click. Replaced the invasive `.is-loading` spinner with a lightweight `.pulse` gesture and native sync-locking.

## [1.6.1] - 2026-04-03

### Added
- **Intent Sovereignty Guard**: Implemented a 500ms immunity window in `WebviewStore` to prioritize local user intent over stale `UI_SYNC` packets from the Extension Host.

### Fixed
- **Optimistic Loading Slot**: Corrected `FileContext` routing; the "Loading Document..." feedback now correctly appears in the **Reader (Active File)** slot instead of the Focused context.
- **Modularization Finalized**: Fully decommissioned the legacy `dashboard.js` monolith, transitioning all UI logic to reactive ESM components.

### Changed
- **Baseline Parity**: Reverted default `rate` value to `0` to maintain synchronization with the integration test suite.

## [1.6.0] - 2026-04-03

### Added
- **Production-Hardened Reliability (Integration v3)**:
    - Expanded the test suite by **+4,400 lines**, introducing comprehensive E2E and integration-first validation.
    - Implemented a rigid **Singleton Lifecycle Protocol** to eliminate memory leaks and "zombie state" contamination between sessions.
    - Achieved a **100% Pass Rate** (250 tests) across the entire component architecture.
- **Intent Sovereignty Architecture**:
    - Integrated high-performance **Optimistic UI Patching** via `WebviewStore.optimisticPatch`, ensuring zero perceived latency for user actions.
    - Synchronized playback intent (Play/Pause/Stop) with immediate visual feedback, bypassing extension host handshake delays.
- **Elite Visual Haptics**:
    - Integrated a global `.pulse` animation layer for transport buttons.
    - Synchronized `statusDot` engine feedback with real-time user intent.
    - Re-engineered `.is-loading` CSS for mathematically perfect alignment and layout stability during state transitions.

### Fixed
- **Defensive Event Handling**: Resolved runtime crashes in virtual/test environments by standardizing `(e?.currentTarget || element)` guards.
- **UI_SYNC State Regression**: Corrected a critical settings hydration failure in the `WebviewCore` layer.
- **State Cleansing**: Refined `readerSlot` clearing semantics to guarantee a zero-stale-state implementation.

### Changed
- **Webview Infrastructure Refactoring**: Promoted `MessageClient` and `WebviewStore` to high-integrity singletons with authoritative lifecycle hooks.

## [1.5.3] - 2026-04-02

### Added
- **Chapter List "Link-First" Priority**:
    - Re-engineered the chapter navigation to support interactive, style-embedded file links (`[label](file:///...)`) within titles.
    - Implemented an **Event Propagation Guard** that prioritizes file link interactions, preventing unwanted chapter jumps when interacting with document citations.
    - Refined visual hierarchy with mathematical multi-level indentation (H1/H2/H3 depth normalization).
- **Keyboard Navigation Hardware Guard**:
    - Implemented a low-latency (100ms) hardware debounce for all navigation keys (`ArrowUp/Down/Left/Right`).
    - Eliminates extension host command flooding and audio stutter during rapid-repeat key events.
- **Neural SSML Integrity Layer (Issue #36)**:
    - Introduced a centralized XML-safe sanitization protocol in the `speechProcessor.ts` core.
    - Guarantees fail-safe delivery to the Neural TTS engine by automatically escaping ampersands, tag delimiters, and quotes.

## [1.5.2] - 2026-04-02

### Added
- **Premium UI Restoration**:
    - Restored **Glassmorphism** effects and deep transparency to the settings drawer with refined CSS haptics.
    - Implemented a custom, searchable **Voice Selector** with neural voice indicators (✨).
    - Added real-time numeric feedback for speed and volume sliders.
- **Testing Stability Infrastructure**:
    - Introduced explicit `dispose()` protocols for `MessageClient`, `WebviewStore`, and `ToastManager` to guarantee zero memory leakage in test environments.
    - Unified the test runner with a global `vitest.setup.ts` providing authoritative `indexedDB` and `scrollIntoView` mocks for the JSDOM environment.

### Fixed
- **Testing Memory Leaks**: Resolved systemic event listener accumulation and pending timer leaks in the webview components.
- **Audio Defaults**: Enforced safe startup defaults (`rate: 0`, `volume: 50%`) to prevent audio clipping and playback drift.

## [1.5.0] - 2026-04-02

### Added
- **The Great Modularization (Phase 5.4)**: Successfully decommissioned the monolithic `dashboard.js`, extracting all remaining UI logic into strictly-typed, reactive ESM components (`PlaybackControls`, `SettingsDrawer`, `VoiceSelector`, `ToastManager`).
- **Surgical IPC Protocol**: Introduced `WebviewStore.patchState()`, enabling high-performance, incremental UI updates that bypass the overhead of full `UI_SYNC` cycles.
- **Regression Logic Hardening**: Expanded the test suite with specialized validation for `PlaybackControls` (status-dot lifecycle) and `utils.test.ts` (XSS/Link-rendering guards).
- **Log Sanitization v2**: Ported high-density `logSafeMessage` logic to provide truncated, human-readable IPC telemetry while protecting privacy.

### Fixed
- **Status-Dot Engine Indicator**: Restored the `#status-dot` engine health indicator in `PlaybackControls`, toggling `online`/`stalled`/idle classes to match legacy behaviour.
- **Voices IPC Handler**: Restored the `voices` command handler in `dashboard.js` using `store.patchState()` to surgically update `availableVoices` without a full `UI_SYNC` cycle.
- **Slider Drag Guard**: Added `isDraggingSlider` flag in `SettingsDrawer` — `oninput` sets the flag, `onchange` clears it; `WebviewStore` subscriptions skip slider updates while dragging to prevent snap-back.
- **Live Rate Preview**: Rate slider `oninput` now directly updates `neuralPlayer.playbackRate` for instant audio speed feedback during drag.
- **Engine Toggle Group Sync**: `engineToggleGroup` is now shown/hidden alongside the settings drawer open/close transition.
- **Drawer Auto-Close on Load**: `FileContext` now closes the settings drawer after clicking "Load File", matching legacy behaviour.
- **Autoplay Restoration**: `PlaybackController` correctly signals `SENTENCE_ENDED` via `audio.onended`/`audio.onerror` to drive the autoplay chain.
- **STOP & PLAYBACK_STATE_CHANGED Handlers**: Restored both IPC command handlers in `dashboard.js`.
- **WebviewStore.patchState**: Added public `patchState()` method for targeted state updates from lightweight IPC commands.

## [1.4.5] - 2026-04-02

### Added
- **Infrastructure Genesis (Phase 5.3)**: Introduced the early **Reactive State Management** foundation (`WebviewStore`) and the **Resilient IPC Bridge** (`MessageClient`) to eliminate non-deterministic race conditions during dashboard initialization.
- **Atomic Navigation Feedback**: Integrated a "Pending Jump" state in the `SentenceNavigator` component to provide immediate visual confirmation across the webview boundary.

## [1.4.4] - 2026-04-02

### Fixed
- **Markdown List Index Parsing (Issue #31)**: Implemented a position-aware, reinforced regex strategy to prevent multi-level indices (e.g., `1.1.`), Roman numerals, and mid-paragraph list markers from being incorrectly segmented as sentences.

## [1.4.3] - 2026-04-02

### Added
- **ESM Modularization Infrastructure (Phase 1 & 2)**: 
    - **Reactive State Management**: Introduced `WebviewStore` with selector-based subscriptions for high-performance UI updates.
    - **Resilient IPC Bridge**: Implemented `MessageClient` singleton to unify extension-to-dashboard communication.
    - **Consolidated IPC Protocol**: Unified all IPC commands via shared TypeScript Enums for improved maintainability.

### Fixed
- **Dashboard Initialization Race**: Resolved a critical startup failure caused by a VS Code API singleton violation and script execution order.

## [1.4.2] - 2026-04-02

### Added
- **Smart-Logic Navigation**: 
    - Re-engineered `ArrowUp` to intelligently restart chapter progress vs. jumping back, backed by hardware-level key repeat guards to prevent command flooding.
    - Implemented Unicode-aware suppression of emojis, flags, and skin tone modifiers to ensure clear, distraction-free speech synthesis.

### Fixed
- **Isolation Protocol (Issue #28)**: Resolved a critical navigation leak by enforcing atomic chapter jumps, preventing keyboard overflows from triggering accidental sentence skips.

## [1.4.1] - 2026-04-01

### Added
- **Premium Playback Animations (Issue #22)**:
    - Added `.is-loading` CSS spinner for Play/Pause buttons during neural synthesis and IPC sync locks.
    - Added `.stalled` "Spectral Glow" pulse for the sentence navigator to provide clear feedback during delays.
- **UI Logic Regression Suite**: Introduced `tests/webview/uiSync.test.ts` to verify state transitions and visibility logic.

### Fixed
- **Control Alignment**: Corrected "off-center" playback icon layout and normalized button widths for a balanced toolbar experience.
- **State Reconciliation**: Refactored UI logic into a strictly-typed TypeScript `UIManager` to eliminate race conditions and state-flicker.

## [1.4.0] - 2026-04-01

### Added
- **Rapid-Playback Engine (Zero-IPC Phase 2)**:
    - **Intent-Ejection Protocol**: Implemented a transactional nonce system (`activeRequestId`) to immediately discard stale synthesis results during rapid navigation, eliminating "Ghost Audio".
    - **Zero-Handshake Ingestion**: Optimized `AudioBridge` to trigger webview cache checks immediately upon navigation.
    - **Concurrent Task Deduping**: Shared task tracking for identical text segments to prevent redundant Azure TTS calls.
- **Neural Stability Watchdog**:
    - **MsEdgeTTS Recycling**: Automated client re-initialization and socket clearing on synthesis timeouts.
    - **Buffering Telemetry**: New `engineStatus: 'buffering'` event for improved UI feedback during network recovery.
- **Atomic UI-Sync**: Hardened synchronization between the extension host and webview state.

## [1.3.2] - 2026-03-31

### Added
- **Content-Aware State (MD5 Integrity)**:
    - **Integrity Fingerprinting**: Introduced automated **MD5 Integrity Fingerprinting** to track document changes, ensuring reading progress accurately resets on file modification.
    - **Composite Key Protocol**: Migrated storage from URI-only keys to `[URI]#[SALT]#[HASH]` mapping for collision-free state tracking.
    - **Passive Migration Gate**: Seamless, automatic upgrade path for existing user progress without data loss.
    - **Scoped Garbage Collection**: Added "Same-File Priority" management to the persistence layer, optimizing the 50-entry storage limit.

### Fixed
- **Atomic Index Reset**: Hardened the document activation protocol to eliminate UI flicker and index drift during fast file switching.

## [1.3.1] - 2026-03-31

### Fixed
- **Issue #25 (Atomic Index Reset)**: Resolved a critical offset persistence bug by implementing an atomic document activation protocol, ensuring consistent initialization and zero-flicker UI transitions.

## [1.3.0] - 2026-03-31

### Added
- **Sound & Visual Link Bridge**:
    - **Audio Gate Sanitization**: Automated stripping of markdown-style file URIs (`(file:///...)`) from speech synthesis, ensuring a natural reading experience while preserving the labels.
    - **Visual Link Bridge**: Transformed raw file URIs in the dashboard into premium, clickable links for instant navigation back to the editor.
    - **Navigation Bridge**: Integrated a bi-directional command layer (`OPEN_FILE`) between the webview and VS Code for seamless file management.

## [1.2.7] - 2026-03-31

### Added
- **Background Playback Persistence**: Enabled critical playback command whitelisting in `DashboardRelay.ts`, ensuring audio continuity even when the sidebar is hidden.
- **Dirty State Tracking**: Implemented a "needs sync" flag in `SpeechProvider.ts` to suppress redundant UI synchronization and prevent jarring resets upon revealing the sidebar.

### Fixed
- **UI Thrashing & Jumps**: Optimized `dashboard.js` with shallow state comparison and viewport-aware "smart" scrolling to eliminate unwanted jumps and flicker during playback.
- **Chapter List Loading**: Resolved a state-racing bug in the webview where the chapter list occasionally failed to render due to invalid assignment timing.

## [1.2.6] - 2026-03-31

### Added
- **Webview Protocol Guard**: Implemented defensive checks in `dashboard.js` to detect and report missing `cacheKey` or audio data, preventing silent playback failures.
- **Granular Synthesis Logging**: Added positional metrics (`CH:X SN:Y`) to synthesis error reports for high-resolution troubleshooting of neural voice issues.

### Fixed
- **Zero-IPC Playback Failure**: Resolved a critical protocol mismatch where the extension host failed to provide the mandatory `cacheKey` during Zero-IPC signals and extension cache hits.
- **Protocol Enrichment**: Unified the `AudioBridge` event layer to mandate positional context across all playback and error emissions.

## [1.2.5] - 2026-03-31

### Added
- **Predictive Synthesis Prefetching**: Implemented a high-performance "look-ahead" architecture with a depth of 5 sentences and a 200ms debounce to ensure zero-gap sentence transitions.
- **Stall-Guard Logic**: Introduced intelligent prefetch suspension that pauses background tasks if the engine is currently buffering the active sentence, preventing resource starvation.
- **Cache-Warming Telemetry**: Integrated explicit `[CACHE HIT]` and `[CACHE MISS]` tracking in the `PlaybackEngine` to monitor look-ahead effectiveness.

### Changed
- **Passive UI Refactoring**: Eliminated the "Snapback" flicker by making the dashboard purely reactive to the Single Source of Truth via `UI_SYNC` packets.
- **Transactional Synthesis**: Implemented an `activeRequestId` nonce system in `AudioBridge` to resolve "Ghost Audio" by discarding stale synthesis results during rapid navigation.

## [1.2.4] - 2026-03-31

### Added
- **Neural Voice Regression Suite**: Introduced `tests/vscode/speechProvider.voices.test.ts` to verify the voice discovery lifecycle and ensure high-integrity handshakes.

### Fixed
- **Voice Discovery Race Condition**: Resolved an issue where neural voices appeared missing during the initial background scan period by implementing a dedicated `voices` command handler in the dashboard.
- **UI Synchronization**: Hardened the communication between the extension and webview to ensure immediate voice dropdown population as soon as data is available.

## [1.2.3] - 2026-03-30

### Added
- **SSOT Architecture**: Promoted `StateStore` to the authoritative source for all playback, navigation, and configuration state, eliminating state drift.
- **Reactive Synchronization**: Refactored `DashboardRelay` and `SpeechProvider` to use a zero-parameter `sync()` method, triggered automatically by `StateStore` events.
- **State Resilience**: Consolidated and declared all missing state variables in `dashboard.js` to eliminate runtime crashes found in diagnostics.

### Changed
- **Stateless Webview**: Refactored `dashboard.js` to be purely reactive, removing all local state mirrors and relying entirely on `UI_SYNC` packets.
- **Hardened Volume Scaling**: Implemented nullish coalescing and range clamping in `dashboard.js` volume scaling to prevent `NaN` errors during initialization.

### Fixed
- **Dashboard Reference Errors**: Resolved `ReferenceError` crashes in the webview related to missing `isSynthesizing` and `currentChapterIndex` declarations.

## [1.2.2] - 2026-03-30

### Added
- **Regression Suite**: Introduced `tests/core/file_context_integrity.test.ts` for comprehensive UI data-flow and state synchronization verification.

### Changed
- **Relocated Status Indicator**: Moved the engine status dot from the Focused File slot to the global footer (bottom-right) for improved health visibility and cleaner separation of context.
- **Header Clean-up**: Removed redundant "NEURAL" text from the dashboard header for a more premium, focused UI.

### Fixed
- **Restored Version Badges**: Re-implemented version salt visibility (e.g., `V1`, `T-10:15`) in the Focused File slot to match v1.2.0 baseline behavior.

## [1.2.1] - 2026-03-30

### Added
- **Document-Level Persistence**: Integrated `vscode.globalState` to automatically save and restore reading positions (Chapter & Sentence) per document URI.
- **Improved Chapter Navigation**: 
    - **Row Progress Indicators**: Active chapter rows now feature a dynamic linear-gradient background representing sentence completion within that chapter.
    - **Header Blocking**: Chapters with 0 rows (headers) are now visually dimmed and interaction-locked to prevent playback errors.
    - **Pending Feedback**: Introduced a "Pending" highlight state for chapter jumps to provide instant visual confirmation before synthesis begins.

### Fixed
- **Play Button Flicker**: Eliminated the transient UI flicker during automatic sentence transitions by maintaining playback intent in the state synchronization layer.
- **UI Sync Stability**: Resolved a critical regression where the dashboard incorrectly parsed playback state after rapid navigation.
- **Type Safety**: Fixed a URI parsing mismatch in `SpeechProvider` persistence logic.
- **Diagnostic Hygiene**: Corrected inverted console log tags in the `DASHBOARD -> EXTENSION` bridge.

## [1.2.0] - 2026-03-30

### Added
- **Domain-Driven Architecture**: Executed the major decoupling of monolithic extension logic into isolated `@core`, `@vscode`, and `@webview` domains for ultimate architectural stability and predictable path routing.
- **Global Path Aliasing**: Implemented high-integrity `tsconfig.json` mappings to eliminate brittle relative imports across all source files and test suites.

### Changed
- **Asset Centralization Protocol**: Consolidated marketplace branding and animations into a root `/assets` directory to separate production runtime resources from repository metadata.

### Removed
- **Legacy Hygiene**: Executed a massive repository cleanup, purging over 4,600 lines of obsolete `media/` assets and orphaned logic controllers.

## [1.1.3] - 2026-03-29

### Added
- **Synthesis Resilience**: Implemented **Playback Intent IDs** to immediately eject stale tasks from the synthesis queue during rapid navigation.
- **WebSocket Recycling**: Added proactive `MsEdgeTTS` client re-initialization on 25s timeouts to clear persistent socket-level hangs.
- **Rate Limit Circuit Breaker**: Introduced explicit `429` (Too Many Requests) detection and a 60-second prefetch blackout during throttled states.
- **UI Navigation Debouncing**: Implemented a 350ms debounce on all navigation commands (`jump`, `next`, `prev`) in the dashboard to protect the engine from command storms.

### Changed
- **Retry Logic Hardening**: Restricted synthesis retries to priority tasks only, preventing background prefetch tasks from consuming quota after failure.
- **Interruptible Synthesis**: Optimized the `PlaybackEngine` lock to immediately release and abort in-flight tasks upon manual stop commands.

## [1.1.2] - 2026-03-29

### Added
- **Architectural Refactoring (Phase 3)**: Decoupled monolithic state from `SpeechProvider` into a centralized, reactive `StateStore`.
- **Atomic State Lifecycle**: Implemented `StateStore.reset()` to ensure synchronous, global state clearing and prevent session leakage.
- **Unit Testing Suite**: Established a dedicated `/tests` directory and integrated `vitest` for high-integrity logic verification (11/11 tests passing).
- **Logical Modularization**: Extracted document parsing and loading into a standalone `DocumentLoadController`.

### Changed
- **SpeechProvider**: Refactored to a pure coordinator pattern, delegating business logic and state management to isolated services.

## [1.1.1] - 2026-03-29

### Added
- **Neural Voice Caching Optimization**: Implemented voice-aware cache keys and persistent storage for audio data, enabling instant voice switching without re-synthesis.
- **Surgical Preview Mode**: Introduced a "Preview First" strategy for voice selection that synthesizes only the current sentence and defers document-wide prefetching.
- **Prefetch Guarding**: Throttled background synthesis tasks to prevent Azure TTS server exhaustion and state leakage during active playback.
- **Enhanced Diagnostics**: Added high-density shorthand logging for cache hits, cache misses, and synthesis lifecycle management.

## [1.1.0] - 2026-03-29

### Added
- **Serverless Evolution (Phase 1)**: Fully decommissioned the legacy `BridgeServer` infrastructure, migrating all extension-to-dashboard communication to the native **VS Code postMessage protocol**, eliminating port collisions and installation locks.
- **Improved UI Sync**: Restored the "Row X / Y" tracking and header state synchronization for a professional playback experience.
- **Direct Diagnostics**: Implemented a console-to-extension bridge to redirect webview logs directly to the "Read Aloud" output channel.
- **Voice Stabilization**: Standardized voice changes to immediately purge local audio caches and reset playback state.


## [1.0.3] - 2026-03-29

### Added
- **Selection Sync Multiplexer**: Implemented a 100ms debounced focus tracker in `extension.ts` to prevent race conditions during rapid tab switching or window resizing.
- **Ghost Focus Strategy**: Now prioritizes the active tab group's state when the sidebar is focused, ensuring the dashboard never loses context while you're interacting with it.
- **Enhanced Selection Guard**: Automatically clears "Focused File" area when an unsupported document type is active.

### Fixed
- **Dashboard Interactivity**: The **LOAD FILE** button now correctly disables (with a "ghosted" visual state) whenever "No Selection" is shown, providing clearer feedback on readable files.

## [1.0.2] - 2026-03-28

### Fixed
- **Webview Scoping**: Resolved fatal `ReferenceError` caused by incorrect block-scoping of DOM elements in `dashboard.js`.
- **Initialization Protocol**: Consolidated `acquireVsCodeApi()` calls and added a defensive handshake sequence to prevent startup crashes.
- **Expanded Recognition**: Relaxed document filters to support `.txt` and `.log` files in the Sidebar.
- **Diagnostic Layer**: Implemented a console-to-host logging bridge to capture and persist webview errors for rapid recovery.

### Removed
- **Redundant Commands**: Removed `readme-preview-read-aloud.read-selection` as selection handling is now integrated into the main flow.
- **Legacy Assets**: Deleted `media/simple.html`.

## [1.0.1] - 2026-03-28

### Fixed
- **Smart Port Isolation**: Dev sessions now use port 3002 to prevent handshake collisions with installed production instances.
- **Dynamic Versioning**: extension version is now dynamically injected from package.json into the dashboard.

### Removed
- **Neural Synthesis UI**: Cleaned up legacy premium toggles for a streamlined native experience.

## [1.0.0] - 2026-03-27

### Initial Release

- **Mission Control Dashboard**: Glassmorphism UI for session management.
- **Robust AST Parsing**: Accurate sentence mapping via `markdown-it`.
- **Intelligent Navigation**: Skip sentences, jump sections, or read from cursor.
- **Cross-Platform**: Support for Windows, macOS, and Linux native synthesis.
- **Resource Hygiene**: Proactive audio blob management for long sessions.
- **Production Bundling**: Optimized activation via `esbuild`.
