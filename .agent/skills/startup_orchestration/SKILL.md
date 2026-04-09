---
name: startup_orchestration
description: Dependency-aware startup protocol for the Read Aloud extension. Ensures high-integrity, non-blocking initialization of the Webview and Extension environments.
---

# Startup Orchestration Protocol

## 1. Dependency Graph (Visualization)

The following graph defines the authoritative startup sequence. Nodes are categorized by their impact on UI responsiveness.

```mermaid
graph TD
    subgraph "Phase 1: Structural Handshake (Fast/Instant)"
        WA[Webview: Bootstrap] --> WB[Webview: READY Signal]
        WB --> EA[Extension: Ack READY]
        EA --> EC[Extension: Send Metadata Sync]
        EC --> WD[Webview: isHydrated = true]
        WD --> WF[UI: UNLOCK SHELL]
        WD --> WH[Webview: isSyncing = false]
    end

    subgraph "Phase 2: Contextual Hydration (Medium/Editor-bound)"
        EA --> EB[Extension: Load Active Document]
        EB --> ED[Extension: Send Document Sync]
        ED --> WG[Webview: Render Content]
    end

    subgraph "Phase 3: Heavy Data Discovery (Slow/Async)"
        EA --> EE[Extension: scanAndSync Voices]
        EA --> EF[Extension: getSnippetHistory]
        EE --> EH[Extension: Send Final UI_SYNC]
        EF --> EH
        EH --> WH[Webview: Populate Selectors/History]
    end

    style WF fill:#d4edda,stroke:#28a745,stroke-width:2px
    style EA fill:#fff3cd,stroke:#ffc107,stroke-width:2px
```

## 2. Blocking States & Mitigation

| State | Blockage Type | Logic Gate | Mitigation Strategy |
| :--- | :--- | :--- | :--- |
| `ScanAndSync` | Asynchronous (Heavy) | Pre-Handshake | Move to **Phase 3**. Send structural sync BEFORE awaiting voice discovery. |
| `getSnippetHistory` | Asynchronous (I/O) | Pre-Handshake | Move to **Phase 3**. Discover history in background; update UI incrementally. |
| `isHydrated` | Handshake Gate | UI Interactivity | Bind to **Phase 1 (ACK)**. MUST be sent as `true` in Pulse 1 to prevent "Dead UI". |
| `pointer-events: none` | CSS Block | `is-loading` class | Class should be removed as soon as **Phase 1** completes. |

## 3. Implementation Guidelines

### 3.1 Extension side (`SpeechProvider.ts`)
- `_sendInitialState()` MUST NOT `await` heavy operations before sending the first `sync()`.
- Use a "Triple-Pulse" sync strategy:
    1.  **ACK Pulse**: Immediate empty sync with `isHydrated: true`.
    2.  **Context Pulse**: Sync after `loadCurrentDocument`.
    3.  **Data Pulse**: Sync after `scanAndSync` and history discovery.

### 3.2 Webview side (`WebviewStore.ts`)
- Ensure `patchState` can handle partial updates without regressing the hydration state.
- `isLoadingVoices` should be a separate transient flag to show a specific spinner in the Voice Selector, rather than blocking the global UI.

### 3.3 SSOI (Single Source of Intent)
- Initial `playbackIntentId` MUST be preserved through the sequence to ensure that any user command sent *during* hydration (e.g., "Stop") takes precedence over late-arriving data packets.
