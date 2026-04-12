---
name: system_context
description: Architectural map and development guidelines for the Read Aloud extension. Mandatory reference for all agent modifications.
---

# System Context & Architecture Protocol

> [!IMPORTANT]
> This skill is the **Source of Truth (SSOT)** for the Read Aloud extension's internal systems.
> **AGENT MANDATE**: If you modify, refactor, or introduce a new system that contradicts or extends the content below, you MUST update this skill in the same turn.

## 0. Skill Coherence Mandate

> [!IMPORTANT]
> All system skills are **bidirectional**. Before any significant action, read the relevant skill(s) that govern the affected subsystem. After any significant action, follow the **[skill_coherence_loop](../skill_coherence_loop/SKILL.md)** protocol to propose updates.
> A `skill pass [on <context>]` command triggers an explicit coherence audit at any time.

### 0.1 Skill Index (Living Map)

| Skill | Governs | Last Updated |
|---|---|---|
| [`system_context`](../system_context/SKILL.md) | Architectural map, subsystem ownership, synchronization protocols | 2026-04-12 (v2.12.0) |
| [`loom_meta_governance`](../loom_meta_governance/artifacts/SKILL.md) | **Tier-0** Universal Agent OS / Medium Tier Management | 2026-04-12 |
| [`startup_orchestration`](../startup_orchestration/SKILL.md) | Boot sequence, Pulse graph, DPG, Phase 1–3 dependencies | 2026-04-10 |
| [`autoplay_orchestration`](../autoplay_orchestration/SKILL.md) | Playback pipeline, pre-fetch, neural laws, intent baton | 2026-04-09 |
| [`state_coherence_v4`](../state_coherence_v4/SKILL.md) | State sovereignty, 1-based consensus, split-brain detection | 2026-04-11 (v2.4.2) |
| [`state_auditor`](../state_auditor/SKILL.md) | Multi-layer state conflict detection and audit methodology | 2026-04-09 |
| [`read_aloud_injection_guard`](../read_aloud_injection_guard/SKILL.md) | MCP injection, dedup guards, sensory parity, verbatim rules | 2026-04-09 |
| [`session_persistence`](../session_persistence/SKILL.md) | `extension_state.json`, turn indexing, session metadata, snippet paths | 2026-04-10 |
| [`lifecycle_guard`](../lifecycle_guard/SKILL.md) | Memory leaks, event listener cleanup, webview disposal | 2026-04-09 |
| [`log_sanitization_v3`](../log_sanitization_v3/SKILL.md) | Log density, shorthand formats, symmetrical prefixes | 2026-04-09 |
| [`release_prestige`](../release_prestige/SKILL.md) | Extension packaging, installation testing, VSIX integrity | 2026-04-09 |
| [`version_sentinel`](../version_sentinel/SKILL.md) | Semantic versioning, changelog, release protocol | 2026-04-09 |
| [`startup_orchestration`](../startup_orchestration/SKILL.md) | Boot sequence, Pulse graph, DPG, Phase 1–3, Persistence Yield | 2026-04-10 |
| [`skill_coherence_loop`](../skill_coherence_loop/SKILL.md) | Skill lifecycle, bidirectional read/write protocol, harvest gate | 2026-04-10 |
| [`dev_cycle`](../dev_cycle/SKILL.md) | Build, package, VSIX install, process kill/restart for Antigravity editor | 2026-04-10 |

## 1. Architectural Map (Snapshot: 2026-04-09)

### 1.1 Core Backend (VS Code Extension)
- **`StateStore.ts`**: The central, reactive **EventEmitter** storing all document and playback status. Tracks `isSelectingVoice` for sampling mode.
- **`SyncManager.ts`**: The **Observer** service. It listens to `StateStore`, applies 100ms throttling, session parity checks, and visibility-aware flushing to the UI.
- **`PlaybackEngine.ts`**: Orchestrates synthesis. Handles the transition between **Local** (SAPI/macOS) and **Neural** (Edge TTS) audio streams. Implements **Authoritative Stop** via unified AbortController hierarchy.
- **`DocController.ts`**: Document intelligence. Manages chunking, metadata extraction, and position tracking.
- **`SettingsManager.ts`**: The authority on configuration and persistence. Bridges `settings.json`, `globalState`, and the Agent's `extension_state.json`.
- **`DashboardRelay.ts`**: The IPC "Switchboard" for post-message communication with the Webview.
- **`McpWatcher.ts` / `McpBridge.ts`**: High-integrity integration with the agent's brain environment for real-time SITREP and command mirroring.

### 1.2 Frontend (Webview Sidebar)
- **`WebviewStore.ts`**: Global reactive store (Redux-lite). Maintained by `UI_SYNC` packets from `SyncManager`. Includes `isSelectingVoice` flag.
- **`CommandDispatcher.ts`**: Entry point for all incoming VS Code messages. Dispatches actions to the store or local services.
- **`MessageClient.ts`**: Outbound IPC wrapper. Used to send user commands (Play, Pause, Stop) back to VS Code.
- **`WebviewAudioEngine.ts`**: The "Dumb Player" (Stateless worker). Executes single-threaded audio playback using a single HTMLAudioElement for all strategies.
- **`window.__debug`** *(dev builds only)*: When `__BOOTSTRAP_CONFIG__.debugMode === true`, the bootstrap function in `src/webview/index.ts` exposes internal singletons as a global for live CDP inspection: `{ store, audioEngine, playback, dispatcher }`. This global is **never present in production builds** (gated by `debugMode`).

### 1.3 Auditory Strategy & Caching (The Holistic Hierarchy)
- **Unified Synthesis Pipe**: The engine no longer uses separate strategy classes. Logic for Neural vs Local is controlled via the `engineMode` property and executed by the `WebviewAudioEngine`.
- **`CacheManager.ts`**: The **Tier-1 (Persistent)** storage (SSOT). Uses **IndexedDB** (`ReadAloudAudioCache`) with a 100MB cap and 7-day TTL.
- **`cachePolicy.ts`**: The centralized authority for key generation across both environments.

## 2. Advanced Architectural Patterns

### 2.1 The "Ghost Focus" Multiplexer & Focused/Loaded Duality (Law F.1)

Located in `extension.ts`, the `syncSelection()` function tracks document focus across tab changes, editor switches, and sidebar interactions. If no active editor exists (e.g., the webview has focus), it falls back to the last active tab or visible editor.

> [!IMPORTANT]
> **Law F.1 — Focused/Loaded Duality (BINDING)**
>
> These are two **legally separate** concepts. Any code that conflates them is a violation:
>
> | Slot | State Field | Updated By | Update Trigger |
> |---|---|---|---|
> | **FOCUSED FILE** (passive) | `focusedDocumentUri` / `focusedFileName` | `syncSelection()` → `setActiveEditor()` | Every tab/editor change |
> | **LOADED FILE** (explicit) | `activeDocumentUri` / `activeDocumentFileName` | `loadCurrentDocument()` → `setActiveDocument()` | Explicit "Load File" button only |
>
> **Invariants:**
> - `syncSelection()` MUST NEVER call `loadCurrentDocument()` or `setActiveDocument()`.
> - `DocController` chapter loading MUST ONLY be invoked from the `LOAD_DOCUMENT` IPC path.
> - Webview UI components showing "Loaded File" MUST bind to `activeDocumentFileName` exclusively.
> - **`focusedVersionSalt` MUST be rendered as HTML** (not `textContent`) to show the `<span class="version-badge">` in the FOCUSED FILE slot. Using `textContent` silently strips the badge.
>
> **Status:** ✅ Issue #26 RESOLVED (2026-04-10)
> - DPG persistence yield guard added to `_tryInitialDocumentLoad()` in `speechProvider.ts`.
> - Focused file version salt now renders correctly via `innerHTML`.


### 2.2 Brain Sensitivity Protocol
The extension uses a `FileSystemWatcher` on `~/.gemini/antigravity/brain`. When a new directory is created, it automatically pivots its internal session context to maintain parity with the active agent session.

### 2.3 Holistic Caching Policy (SSOT)
- **Keys**: All cache keys are generated via `cachePolicy.ts` using `[Text + VoiceID + Rate + EngineVersion]`.
- **Sovereign Manifest**: The Webview emits a `CacheManifest` (Set of IDs) to the Extension Host. 
- **Zero-Target Synthesis**: The Extension Host MUST check the `CacheManifest` before synthesis. If a key is present, synthesis is skipped, and the Webview is instructed to play from local disk.
- **Tiering**: 
    1. **Ext-RAM**: Ephemeral buffer for active synthesis delivery.
    2. **Web-RAM**: High-priority `ObjectURL` window (Active + Next 2).
    3. **Web-DB**: Persistent IndexedDB (The long-term SSOT).

- **Lifecycle**: Prefetch tasks are aborted immediately on `IntentId` increments (e.g., user skips forward).
- **Known Event Mirroring (Not a Bug):** `CACHE_STATS_UPDATE` is emitted by **two separate paths**
  for the same cache event: (1) the Extension bridge on write, and (2) the Webview `CacheManager`
  on read/hydration acknowledgment. This produces two `[HOST->WEBVIEW] [CACHE_STATS_UPDATE]`
  log lines per cache operation. Do NOT suppress either side without verifying which path owns
  cache authority for the current operation (synthesis write vs. disk hydration).

### 2.5 Single Source of Intent (SSOI) & Handshake Gate 
- **Intent Sovereignty**: All synthesis and playback tasks MUST be tagged with a `playbackIntentId`. Components MUST immediately eject tasks that do not match the current global intent. Intent IDs are initialized to **1** as the authoritative baseline across all environments (Extension Host, Webview, PlaybackEngine) to ensure total synchronization upon first handshake.
- **Single Source of Intent (SSOI)**: The `WebviewStore` is the **exclusive owner** of active intent and synchronization state in the UI. `PlaybackController` MUST NOT maintain private copies of `isPlaying`, `isAwaitingSync`, or `playbackIntentId`. All logic must read from and write to the store to prevent "Split-Brain" behavior.
- **Abortable Intent Pattern**: `WebviewAudioEngine` manages an internal `AbortController` linked to the active intent. New intents call `abort()` on the previous controller, which immediately releases locks and cancels async playback/fetch tasks.
- **Authoritative Stop**: The `stop()` command is universal. It triggers a cascade of aborts across all active segments, pre-fetch batches, and the primary synthesis lock in the `WebviewAudioEngine`.
- **Handshake Gate**: The Webview MUST block all synthesis requests and pre-fetching until the `isHandshakeComplete` flag is true in the store. This ensures the intent baseline has synced.
- **Log-Based Verification (v2.4.2)**: To enable robust automated testing via CDP, the `WebviewStore.patchState` method emits a specific ASCII marker `[STORE-SYNC-COMPLETE]` after every non-identical state update. This signal is the authoritative "Done" marker for automation scripts to stop polling and verify state.
- **Voice Decoupling**: To optimize IPC performance, `availableVoices` is excluded from the high-frequency `DEFAULT_SYNC_PACKET`. It is updated exclusively via dedicated `VOICES` commands during initialization or explicit voice scans.
- **Control Sovereignty**: User actions in the Webview are authoritative. Upon a user click, the system enters a **Sovereign Window (5s)**:
    - `playbackIntentId` is updated in the store (`Date.now()`).
    - `isAwaitingSync` is set to `true` in the store.
    - Incoming `UI_SYNC` packets with lower `intentId`s are ignored to prevent "UI Flickering".
- **Instance Guard**: To prevent "Bridge Storms", the `McpBridge` enforces a **200ms eviction delay** before force-purging stale sessions.
- **Monotonic Batch ID Hardening**: `batchId` tracks manual vs auto-advance sequences. 
    - **Manual Action**: Increments `batchId`.
    - **Auto-Advance**: Persists `batchId` to maintain sequence continuity.
    - **Batch 0**: Prevented globally; minimum valid `batchId` is 1. Synthesis requests with 0-value IDs auto-adopt current authoritative IDs.

### 2.6 Snippet Data Sovereignty 
- **Directory Redirection**: To ensure the playback experience remains focused on content, the extension's data root is redirected to the `antigravity/read_aloud/` subdirectory.
- **Sovereign Isolation**:
    - **User Content**: All playback snippets, session metadata (`extension_state.json`), and transitory audio files MUST reside in `/read_aloud/<sessionId>`.
    - **Agent Process**: Internal agent artifacts (e.g., `task.md`, `implementation_plan.md`, `walkthrough.md`, `.log`) reside in `/brain/<sessionId>`.
    - **UI Visibility & Privacy Shield (Sovereignty Protocol)**:
    - **Focus Sovereignty**: Focus state is the ultimate authority. If an agent artifact (e.g., `task.md`, `diag.log`) is focused in the VS Code editor, the system MUST load the document and allow synthesis. 
    - **Discovery-only Isolation (The Brain Exception)**: The Webview Sidebar (Snippet Lookup) MUST filter ONLY the `brain/` directory. Directories like `knowledge/` and `protocols/` are permissible for discovery. This ensures UI history hygiene while maintaining permissive authoritative focus.
    - **Limit**: Snippet history is strictly limited to the **10 most recent** non-system sessions to prevent performance degradation.

### 2.7 Sampling Neutrality (Law S.1)
When the user changes a voice, the system enters "Sampling Mode" (`isSelectingVoice: true`).
- **Isolation**: Only the current sentence is synthesized and played.
- **Suppression**: The `SENTENCE_ENDED` event from the audio engine is caught by the `PlaybackEngine` but **not** processed for auto-advance.
- **Intent**: Changing voice triggers an authoritative stop but *does not* increment the `batchIntentId` (which is reserved for manual playback jumps or explicit user "Commit" to play).

### 2.8 CDP Command Prefixing (PowerShell Protocol)
When simulating command palette interaction via CDP:
- **Prefix Requirement**: All commands sent via `type` to the VS Code command palette MUST be prefixed with `>`. 
- **Reason**: On Windows (and some Antigravity versions), the command palette may open as a "File Search" by default. The `>` prefix forces it into "Command Mode".
- **Implementation**: Handled by the `exec` command in `cdp-controller.mjs`.

## 3. Hook Protocol (Development Guide)

### 3.1 Extending State
- **Rule**: NEVER add independent local state to `SpeechProvider` or `DocController` if it needs to be reflected in the UI.
- **Action**: Add properties to the `StateStore` interface and `StateStore.init()`. 
- **Parity**: Update the `DashboardRelay.sync()` method to include the new data in the standard sync packet.

### 3.2 Adding a New Setting
- **Action**: Register the key in `package.json` (under `contributes.configuration`). Update `SettingsManager.ts` to map the configuration value into the `StateStore`.

### 3.3 Adding an IPC Command
- **Frontend**: Use `MessageClient.postMessage({ command: 'myCommand', ... })`.
- **Backend**: Update the `CommandDispatcher` on the backend (usually delegated to `SpeechProvider.onDidReceiveMessage`) to handle the incoming request.

### 3.4 Test Infrastructure Known Constraints

> [!WARNING]
> These are structural jsdom/vitest limitations — not production bugs. They affect test file setup only.

#### jsdom `HTMLAudioElement` Stub (canplay Contract)
`WebviewAudioEngine.playBlob()` sets `audio.src`, calls `audio.load()`, then awaits either `canplay`, `ended`, or `error` events before calling `audio.play()`. In jsdom, `audio.load()` is a no-op stub — **media events never fire automatically**.

Any test that calls `playBlob()` directly **MUST** mock `load()` to dispatch `canplay` synchronously:

```typescript
// Instance-level (RaceCondition.test.ts — spy on specific engine.audioElement):
vi.spyOn(audio, 'load').mockImplementation(function(this: HTMLAudioElement) {
    this.dispatchEvent(new Event('canplay'));
});

// Prototype-level (WebviewAudioEngine.test.ts — affects all HTMLAudioElement instances):
vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function(this: HTMLAudioElement) {
    this.dispatchEvent(new Event('canplay'));
});
```

Without this, the inner Promise in `playBlob()` hangs permanently, causing a 5000ms watchdog timeout and a Vitest global timeout failure.

**Known affected tests (pre-fix):**
- `tests/webview/core/RaceCondition.test.ts:47` — "SHOULD allow audio packets that match the current intent"
- `tests/webview/core/WebviewAudioEngine.test.ts:49` — "should acquire lock for playBlob and release it on completion"

#### `vscode.window.tabGroups` Mock Requirement
Any test file that triggers `SpeechProvider._sendInitialState()` (via `resolveWebviewView()` + a `ready` message) must include `tabGroups.activeTabGroup.activeTab` in the `vscode.window` mock — otherwise a `TypeError` crashes the test:
```typescript
window: {
    createStatusBarItem: vi.fn(...),
    activeTextEditor: undefined,
    tabGroups: { activeTabGroup: { activeTab: undefined } }
}
```

**Known affected test files:** `speechProvider.voices.test.ts`, `speechProvider.sync.test.ts`.

## 4. Execution Trace: The "Play" Request
1. **Trigger**: User clicks Play in Webview.
2. **IPC (Out)**: `MessageClient.postMessage({ command: 'play' })`.
3. **Internal Logic**: `SpeechProvider.play()` -> `PlaybackEngine.start()`.
4. **State Update**: `StateStore` emits `change`.
5. **Sync (In)**: `SyncManager` throttles and sends `UI_SYNC` message to Webview via `DashboardRelay`.
6. **UI Update**: `WebviewStore` updates and React components re-render.

## 5. Holistic Audio Caching Flow (Visualization)

```mermaid
graph TD
    subgraph "Extension Host (Synthesis Authority)"
        A[DocController: Chunking] --> B[CacheCheck: Manifest Look-up]
        B -- Miss --> E[EdgeTTS: Synthesis]
        B -- Hit --> F[Bridge: Signal Cache-Hit]
    end

    subgraph "IPC Bridge"
        E --> G[DATA_PUSH / SYNTH_READY]
        F --> H[PLAY_FROM_CACHE]
    end

    subgraph "Webview (Playback & Persistence SSOT)"
        G --> I[WebviewAudioEngine: Ingest]
        H --> J[CacheManager: Load Blob]
        I --> K[Tier-2: Memory Window Objects]
        J --> K
        K --> L[WebviewAudioEngine: Play]
        I -.-> M[Tier-1: IndexedDB Sync]
        M -- "Periodic Update" --> N[CacheManifest]
        N -- "Sync Out" --> B
    end
```

## 6. CDP Debugging Infrastructure

> [!NOTE]
> This section documents the live inspection and mutation toolchain available to the agent during development. All capabilities below are **dev-only** and are never active in production.

### 6.1 The `cdp-controller.mjs` Persistent REPL (`npm run cdp:shell`)

A long-running Node.js process that maintains a single CDP connection to the running Antigravity editor (`localhost:9222`). It provides a REPL with the following command registry:

| Command | Action |
|---|---|
| `launch` | Triggers F5 in the main editor, waits for `VOICE_SCAN` activation signal |
| `exec <cmd>` | Dispatches a VS Code command palette action (prefixed with `>`) to the **Dev Host** workbench |
| `frames` | Lists all CDP frames in the dev host (diagnostic — identifies webview targets) |
| `eval <expr>` | Executes JS in the live Read Aloud webview (`fake.html`) frame |
| `close` | 3-tier graceful shutdown: Polite → `window.close()` → Surgical PID kill |
| `exit` | Terminates the REPL process itself |

**VS Code Two-Frame Architecture**: VS Code webviews are sandboxed iframes inside the workbench renderer. They never appear as separate CDP top-level targets. The controller traverses child frames of the dev host page, preferring the `vscode-webview://.../fake.html` frame — where extension HTML is injected.

### 6.2 `window.__debug` — Live Singleton Inspector

Exposed in `src/webview/index.ts` inside the `bootstrap()` function, gated by:
```typescript
if (__BOOTSTRAP_CONFIG__.debugMode) {
  (window as any).__debug = { store, audioEngine, playback, dispatcher };
}
```

**Verified live snapshot** (2026-04-10):
```json
{ "native": true, "extensionVersion": "2.2.2", "debugMode": true, "logLevel": 2 }
```

### 6.3 WebviewStore API Surface (Custom Store — NOT Zustand/Redux)

The store is a custom class. Key methods available via `window.__debug.store`:

| Method | Purpose |
|---|---|
| `getState()` | Returns full state snapshot |
| `patchState(patch)` | Shallow-merges patch into state. **Mutations are immediate and confirmed.** |
| `updateState(patch)` | Deep state update (triggers listeners) |
| `subscribe(fn)` | Registers a state change listener |
| `resetPlaybackIntent()` | Atomically resets intent + `isAwaitingSync` |
| `setIntentIds(ids)` | Updates `playbackIntentId` + `batchIntentId` |

> [!WARNING]
> `store.dispatch()` does NOT exist. This is a custom store, not Redux. Use `patchState()` for direct mutations in debug sessions.

**Critical state fields for playback diagnosis:**
```
rate, volume, engineMode, playbackIntent, isPlaying, isPaused,
playbackStalled, isBuffering, neuralBuffer, lastLoadType,
playbackIntentId, batchIntentId, activeQueue
```

### 6.4 WebviewAudioEngine API Surface

Key methods available via `window.__debug.audioEngine`:

| Method | Behavior |
|---|---|
| `setVolume(0–100)` | Normalizes to `audioElement.volume` (divides by 100). ✅ Confirmed working. |
| `setRate(n)` | Sets playback rate. **Does NOT write back to store** — rate change is engine-local only. |
| `pause()` / `resume()` / `stop()` | Direct playback control |
| `ingestData(data)` | Feeds a synthesized audio blob into the engine buffer |
| `scanVoices()` | Re-queries available TTS voices |
| `purgeMemory()` | Wipes in-memory audio objects |
| `wipeCache()` | Clears IndexedDB cache |

### 6.5 Dispatcher API (Extension → Webview only)

`window.__debug.dispatcher.dispatch({ command, ... })` handles **inbound** message commands from the VS Code extension side. It is **not** a client-side mutation API — calling `dispatch()` from the webview console will return `{}` without state changes.

### 6.6 Known Live-State Observations (Verified 2026-04-10)

| Observation | Verdict |
|---|---|
| `isBuffering: true` while `playbackIntent: "STOPPED"` | ✅ **Remediated** — Filtered via Segmented Sovereignty |
| `audioEngine.setRate()` adjustments | ✅ **Seamless** — Applied via Neural Rate Guard ($target / baked$) |
| `audioElement.volume = setVolume(n) / 100` | ✅ **Correct normalization** |
| `store.patchState()` mutations are instant and reflected in next `getState()` | ✅ Confirmed |
| Dev session baseline: `rate: 7.2`, `volume: 84`, `engineMode: "neural"` | 📊 Reference snapshot |

## 7. Architectural Sovereignty Protocol (SSOA)

To maintain high-integrity state and prevent "Split-Brain" bugs, agents MUST adhere to these three pillars:

### 7.1 The "No Shadowing" Rule
**STRICT PROHIBITION**: Components (Controllers, Engines, UI Classes) are FORBIDDEN from maintaining local private properties that duplicate or shadow data stored in the `WebviewStore` or `StateStore`. 
- **Correct**: Read `store.getState().isPlaying` inside your method.
- **Incorrect**: Having `private isPlaying: boolean` in your class and trying to keep it synced.
- **No Duplication**: NEVER create new properties that duplicate existing ones in the `state` sub-object or vice-versa. If a property exists in both, one MUST be the authority.

### 7.3 Atomic Intent Management
Never scatter `Date.now()` or manual ID increments across components.
- **Rule**: Use centralized store methods (e.g., `store.resetPlaybackIntent()`). This ensures that the `intentId` update and the `isAwaitingSync` lock happen in a single atomic state transition.

### 7.4 Sanitization Layer 
- **Purpose**: Prevent `undefined` properties (CundefinedSundefined logging) from infecting the state and ensure valid defaults.
- **Sanitizer**: `MessageClient` implements a **Sanitizer** that validates `UI_SYNC` packets before they reach the Store.
- **Zero-Point Baseline**: All intent IDs (`playbackIntentId`, `batchIntentId`) MUST initialize to **1**. 
- **Baseline Rate**: The system mandates **1.0** as the authoritative default (Normal) rate. All calculations, store initializations, and UI state normalization MUST adhere to this constant. Values of 0 for rate are considered corrupt and MUST be defaulted to 1.0.
- **Loading Boundaries**: The system maintains a distinction between UI focus and Discovery. Internal agent paths (`brain`, `antigravity`) are filtered ONLY from the Snippet Discovery Sidebar to maintain history hygiene. They are FULLY permitted for loading and synthesis if they are the actively focused editor in VS Code.

### 7.5 State-First Convergence 
- **Purpose**: Resolve "Ghost State" during high-frequency IPC updates.
- **Hierarchy**: During a `UI_SYNC`, the Extension's nested `state` object is the definitive authority. The `WebviewStore`'s `patchState` must perform a strictly mirrors the sub-object onto flat properties to prevent local optimistic UI from permanently diverging from the Extension's reality.

## 8. Agent Heuristics for Architecture

### 8.1 "Reconnaissance-First" Development
Before adding any new property, method, or IPC command:
1. **Search**: Run `grep_search` or `search_code` for the functional concept (e.g., "sync", "lock", "intent").
2. **Reconstruct**: If a similar part exists, modify it to support the new use case rather than creating a parallel-but-different part.
3. **Consolidate**: If you find duplication, your FIRST task is to decommission the redundant part and unify the logic.

### 8.2 The "Duck Test" for Primitives
If a new requirement "looks like" something the Store already handles (e.g., "I need a way to wait for a response"), use the existing mechanism (e.g., `isAwaitingSync`) instead of creating a new one (e.g., `this.isWaitingForDoc`).

## 9. Autoradiant Health & Fallback Protocol 

To ensure playback reliability despite the inherent instability of internet-based Neural TTS, the system adheres to the **Autoradiant** philosophy: "Neural by choice, Local by necessity, Healing by design."

### 9.1 Service Health States
1. **HEALTHY**: Primary mode. All synthesis requests use Neural voices.
2. **DEGRADED**: Entered after persistent Neural failures or >120s of "Dead" service. Synthesis is automatically routed to **Local** voices.
3. **HEALING**: Background probing mode. The system attempts Neural prefetching. A successful prefetch transitions the state back to **HEALTHY**.

### 9.2 The "Dead Man's Switch" (2-Minute Rule)
- **Constraint**: The system MUST NOT fallback to robotic Local voices for transient network blips.
- **Protocol**: If a prioritary Neural synthesis fails, the `lastNeuralSuccessTime` is checked. Fallback to Local only occurs if:
    - (A) Persistent errors occur AND
    - (B) `Date.now() - lastNeuralSuccessTime > 120,000ms`.

### 9.3 Client Sovereignty (Fail-Fast)
- **Library Corruption**: Errors containing `readyState` or `TypeError` in the TTS client are treated as **Authoritative Corruptions**.
- **Action**: The `MsEdgeTTS` instance MUST be immediately destroyed and re-initialized. Retries MUST NOT proceed using a corrupted client.

### 9.4 Simplified Synthesis Flow (The "Autoradiant" Loop)
1. **Acquire Lock**: Unified `synthesisLock` with intent-based early ejection.
2. **Fresh Client Check**: Verify client health before I/O.
3. **Synthesis Loop**: A simple `for` loop (3 attempts) with exponential backoff.
4. **Health Guard**: On error, update health state. If health hits `DEGRADED`, signal the Bridge to pivot.

### 9.5 Sidebar Discovery Protocol (Lazy-Loading)
- **Invariant**: The Read Aloud sidebar webview is **lazy-loaded**.
- **Protocol**: CDP automation MUST NOT assume the webview frame exists on launch.
- **Action**: Use `show read-aloud` (dispatches `readme-preview-read-aloud.show-dashboard`) to ensure the panel is active before performing `eval` or state audits.
- **Discovery**: Use `find read-aloud` to locate the `fake.html` frame within the `vscode-webview://` sandbox.

### 9.6 CDP Automation Invariants (Shell Sovereignty)
- **Locking**: The `cdp-controller.mjs` uses `.cdp_shell.lock` (in project root). ONLY ONE instance can be active.
- **Cleanup (Sovereign Exit)**: 
    - Always use the `exit` or `quit` command via `send_command_input` to ensure the lock file is removed.
    - **Verification**: After exit, confirmed that the lock file is GONE via `list_dir`.
- **Connection**: Parallel CDP connections to the same port (9222) will cause SSE `429` (Too Many Requests) or target detachment.
- **Protocol**: If the shell hangs, manually delete `scripts/.cdp-shell.lock` and `kill` the Node process.
