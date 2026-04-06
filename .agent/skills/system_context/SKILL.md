---
name: system_context
description: Architectural map and development guidelines for the Read Aloud extension. Mandatory reference for all agent modifications.
---

# System Context & Architecture Protocol

> [!IMPORTANT]
> This skill is the **Source of Truth (SSOT)** for the Read Aloud extension's internal systems. 
> **AGENT MANDATE**: If you modify, refactor, or introduce a new system that contradicts or extends the content below, you MUST update this skill in the same turn.

## 1. Architectural Map (Snapshot: 2026-04-06)

### 1.1 Core Backend (VS Code Extension)
- **`StateStore.ts`**: The central, reactive **EventEmitter** storing all document and playback status.
- **`SyncManager.ts`**: The **Observer** service. It listens to `StateStore`, applies 100ms throttling, session parity checks, and visibility-aware flushing to the UI.
- **`PlaybackEngine.ts`**: Orchestrates synthesis. Handles the transition between **Local** (SAPI/macOS) and **Neural** (Edge TTS) audio streams. 
- **`DocController.ts`**: Document intelligence. Manages chunking, metadata extraction, and position tracking.
- **`SettingsManager.ts`**: The authority on configuration and persistence. Bridges `settings.json`, `globalState`, and the Agent's `extension_state.json`.
- **`DashboardRelay.ts`**: The IPC "Switchboard" for post-message communication with the Webview.
- **`McpWatcher.ts` / `McpBridge.ts`**: High-integrity integration with the agent's brain environment for real-time SITREP and command mirroring.

### 1.2 Frontend (Webview Sidebar)
- **`WebviewStore.ts`**: Global reactive store (Redux-lite). Maintained by `UI_SYNC` packets from `SyncManager`.
- **`CommandDispatcher.ts`**: Entry point for all incoming VS Code messages. Dispatches actions to the store or local services.
- **`MessageClient.ts`**: Outbound IPC wrapper. Used to send user commands (Play, Pause, Stop) back to VS Code.

## 2. Advanced Architectural Patterns

### 2.1 The "Ghost Focus" Multiplexer
Located in `extension.ts`, the `syncSelection()` function tracks document focus across tab changes, editor switches, and sidebar interactions. If no active editor exists (e.g., the webview has focus), it falls back to the last active tab or visible editor.

### 2.2 Brain Sensitivity Protocol
The extension uses a `FileSystemWatcher` on `~/.gemini/antigravity/brain`. When a new directory is created, it automatically pivots its internal session context to maintain parity with the active agent session.

### 2.3 Throttled Persistence
Settings (via `SettingsManager`) and state (via `SyncManager`) use aggressive debouncing (500ms-1000ms) to ensure high performance during rapid user interaction or agentic state injections.

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

## 5. Maintenance Logic
- **Discovery**: Before starting a new task, check if the current `task.md` or `implementation_plan.md` suggests an architectural evolution.
- **Burn-down**: Once a component is refactored (e.g., `PlaybackEngine` -> `AudioStrategy`), update the **Architectural Map** above immediately.
- **Check-in**: If unsure where to "hook" a new feature, run a search for `StateStore` usage.
