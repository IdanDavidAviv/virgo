---
name: system_context
description: Architectural map and development guidelines for the Read Aloud extension. Mandatory reference for all agent modifications.
---

# System Context & Architecture Protocol

> [!IMPORTANT]
> This skill is the **Source of Truth (SSOT)** for the Read Aloud extension's internal systems. 
> **AGENT MANDATE**: If you modify, refactor, or introduce a new system that contradicts or extends the content below, you MUST update this skill in the same turn.

## 1. Architectural Map (Snapshot: 2026-04-08)

### 1.1 Core Backend (VS Code Extension)
- **`StateStore.ts`**: The central, reactive **EventEmitter** storing all document and playback status.
- **`SyncManager.ts`**: The **Observer** service. It listens to `StateStore`, applies 100ms throttling, session parity checks, and visibility-aware flushing to the UI.
- **`PlaybackEngine.ts`**: Orchestrates synthesis. Handles the transition between **Local** (SAPI/macOS) and **Neural** (Edge TTS) audio streams. Implements **Authoritative Stop** via unified AbortController hierarchy.
- **`DocController.ts`**: Document intelligence. Manages chunking, metadata extraction, and position tracking.
- **`SettingsManager.ts`**: The authority on configuration and persistence. Bridges `settings.json`, `globalState`, and the Agent's `extension_state.json`.
- **`DashboardRelay.ts`**: The IPC "Switchboard" for post-message communication with the Webview.
- **`McpWatcher.ts` / `McpBridge.ts`**: High-integrity integration with the agent's brain environment for real-time SITREP and command mirroring.

### 1.2 Frontend (Webview Sidebar)
- **`WebviewStore.ts`**: Global reactive store (Redux-lite). Maintained by `UI_SYNC` packets from `SyncManager`.
- **`CommandDispatcher.ts`**: Entry point for all incoming VS Code messages. Dispatches actions to the store or local services.
- **`MessageClient.ts`**: Outbound IPC wrapper. Used to send user commands (Play, Pause, Stop) back to VS Code.
- **`WebviewAudioEngine.ts`**: The "Dumb Player" (Stateless worker). Executes single-threaded audio playback using a single HTMLAudioElement for all strategies.

### 1.3 Auditory Strategy & Caching (The Holistic Hierarchy)
- **Unified Synthesis Pipe**: [v2.3.1] The engine no longer uses explicit Strategy classes. Logic for Neural vs Local is branch-based within the `WebviewAudioEngine`.
- **`CacheManager.ts`**: The **Tier-1 (Persistent)** storage (SSOT). Uses **IndexedDB** (`ReadAloudAudioCache`) with a 100MB cap and 7-day TTL.
- **`cachePolicy.ts`**: The centralized authority for key generation across both environments.

## 2. Advanced Architectural Patterns

### 2.1 The "Ghost Focus" Multiplexer
Located in `extension.ts`, the `syncSelection()` function tracks document focus across tab changes, editor switches, and sidebar interactions. If no active editor exists (e.g., the webview has focus), it falls back to the last active tab or visible editor.

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

### 2.5 Single Source of Intent (SSOI) & Handshake Gate [v2.3.1]
- **Intent Sovereignty**: All synthesis and playback tasks MUST be tagged with a `playbackIntentId`. Components MUST immediately eject tasks that do not match the current global intent. Intent IDs are initialized to `Date.now()` to prevent race conditions.
- **Single Source of Intent (SSOI)**: The `WebviewStore` is the **exclusive owner** of active intent and synchronization state. `PlaybackController` MUST NOT maintain private copies of `isPlaying`, `isAwaitingSync`, or `playbackIntentId`. All logic must read from and write to the store to prevent "Split-Brain" behavior.
- **Abortable Intent Pattern**: `WebviewAudioEngine` manages an internal `AbortController` linked to the active intent. New intents call `abort()` on the previous controller, which immediately releases locks and cancels async playback/fetch tasks.
- **Authoritative Stop**: The `stop()` command is universal. It triggers a cascade of aborts across all active segments, pre-fetch batches, and the primary synthesis lock in the `WebviewAudioEngine`.
- **Handshake Gate**: The Webview MUST block all synthesis requests and pre-fetching until the `isHandshakeComplete` flag is true in the store.
- **Control Sovereignty**: User actions in the Webview are authoritative. Upon a user click, the system enters a **Sovereign Window (5s)**:
    - `playbackIntentId` is updated in the store (`Date.now()`).
    - `isAwaitingSync` is set to `true` in the store.
    - Incoming `UI_SYNC` packets with lower `intentId`s are ignored to prevent "UI Flickering".
- **Instance Guard**: To prevent "Bridge Storms", the `McpBridge` enforces a **200ms eviction delay** before force-purging stale sessions.

### 2.6 Snippet Data Sovereignty [v2.3.1]
- **Directory Redirection**: To ensure the playback experience remains focused on content, the extension's data root is redirected to the `antigravity/read_aloud/` subdirectory.
- **Sovereign Isolation**:
    - **User Content**: All playback snippets, session metadata (`extension_state.json`), and transitory audio files MUST reside in `/read_aloud/<sessionId>`.
    - **Agent Process**: Internal agent artifacts (e.g., `task.md`, `implementation_plan.md`, `walkthrough.md`, `.log`) reside in `/brain/<sessionId>`.
- **UI Visibility & Privacy Shield**:
    - **Discovery Logic**: The Webview Sidebar (Snippet Lookup) MUST exclusively discover files from the `read_aloud/` path.
    - **No-Brain Regex**: Discovery and rendering logic MUST explicitly ignore any path or session ID containing the word `brain` (case-insensitive). This ensures that agent artifacts (tasks, plans, logs) do not clutter the user's snippet history.
    - **Limit**: Snippet history is strictly limited to the **10 most recent** non-brain sessions to prevent performance degradation.

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
        G --> I[NeuralAudioStrategy: Ingest]
        H --> J[CacheManager: Load Blob]
        I --> K[Tier-2: Memory Window Objects]
        J --> K
        K --> L[WebviewAudioEngine: Play]
        I -.-> M[Tier-1: IndexedDB Sync]
        M -- "Periodic Update" --> N[CacheManifest]
        N -- "Sync Out" --> B
    end
```

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

### 7.4 Sanitization Layer [v2.3.1]
- **Purpose**: Prevent `undefined` properties (CundefinedSundefined logging) from infecting the state.
- **Mechanism**: `MessageClient` implements a **Sanitizer** that validates `UI_SYNC` packets before they reach the Store, ensuring concrete numbers for indices, volume, and rate.

### 7.5 State-First Convergence [v2.3.1]
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

## 9. Autoradiant Health & Fallback Protocol [v2.4.0]

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
