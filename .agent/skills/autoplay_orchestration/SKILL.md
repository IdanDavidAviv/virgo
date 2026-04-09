---
name: autoplay_orchestration
description: Protocol for high-stability, state-driven playback orchestration and state management in the Read Aloud extension.
---

# Autoplay Orchestration

This skill defines the authoritative architecture for the Read Aloud playback engine. It replaces ad-hoc "Guards" with a formal state machine to ensure zero "play override" issues and robust state transitions.

## 1. System Dynamics

The system revolves around the **Sovereign Intent Baton**. 
- **Acquire**: The user (or auto-next) initiates an action. A new `intentId` (Baton) is minted **only** for disruptive actions (Stop, Jump, Manual Play). `batchId` is incremented for every **manual gesture**.
- **Continuity**: Seamless transitions (auto-next/pre-fetch) **inherit** the current `batchId` to maintain sequence continuity, while disruptive jumps reset the context.
- **Execution Phases**:
    - **Call**: Extension is notified of the intent.
    - **Synthesis**: Extension prepares the audio.
    - **Play**: Webview receives audio and plays it IF the baton hasn't moved (Baton Magnitude Check).
    - **Reject**: Stale intents (lesser baton magnitude) are immediately discarded by the "Zombie Guard".

```mermaid
graph TD
    User([User Interaction]) --> OP[Optimistic Patch]
    OP --> SM[State Machine]
    SM --> Intent{Intent Latched?}
    Intent -- YES --> Ext[Extension Play Command]
    Intent -- NO --> Error[Transition Rejected]
    
    Ext --> Synth[Synthesis Engine]
    Synth --> Notify[SYNTHESIS_READY]
    
    Notify --> Poll{Intent Valid?}
    Poll -- YES --> Pull[FETCH_AUDIO]
    Poll -- NO --> Ignore[Ignore / Prune]
    
    Pull --> Push[DATA_PUSH]
    Push --> Engine[Audio Engine]
    Engine --> PB[Playback]
```

### Temporal Handshake

The diagram below illustrates the timing relationship between intent creation and synchronization.

```mermaid
sequenceDiagram
    participant U as User
    participant S as Webview Store
    participant C as Playback Controller
    participant E as Extension
    participant S as Webview Store / Engine

    U->>C: Click Play
    Note over C: Increment IntentId (X)
    C->>S: Optimistic Patch (isPlaying: true)
    Note over S: Set IntentExpiry (+1500ms)
    C->>E: IPC: action:PLAY (IntentId: X)
    
    E->>E: Neural Synthesis
    E->>S: IPC: SYNTHESIS_READY (IntentId: X, CacheKey: K)
    
    alt Intent Parity
        S->>E: IPC: FETCH_AUDIO (CacheKey: K)
        E->>S: IPC: DATA_PUSH (Binary Base64)
        S->>U: Start Audio Playback
    else Stale Intent (User Stopped)
        Note over S: Intent mismatch (X vs Y)
        Note over S: Pull Aborted
    end
```

## 2. State Variable Analysis

| Variable | Scope | Purpose | Rule |
| :--- | :--- | :--- | :--- |
| `playbackState` | WebviewStore | Current engine state (IDLE, PLAYING, etc.) | Canonical Source of Truth for UI. |
| `playbackIntent` | WebviewStore | User's desired state. | Used for reconciliation with Extension syncs. |
| `lastIntentId` | WebviewStore | Incremental counter for every state change. | **Sovereignty Key**: Data with older IDs must be discarded. |
| `isAwaitingSync` | WebviewStore | UI Lock during transition. | Prevents rapid fire commands while extension is processing. |
| `batchId` | Both | Monotonic sequence ID. | Tracks manual vs auto-advance chunks. |

## 3. Timing Registry (TTL)

| Parameter | Value | Entity | Purpose |
| :--- | :--- | :--- | :--- |
| `INTENT_TIMEOUT_MS` | 1500ms | WebviewStore | Sovereignty window encompassing synthesis latency. |
| `FETCH_TIMEOUT` | 5000ms | Webview Audio Engine | Timeout for the Pull-Fetch handshake before giving up. |
| `SYNC_GRACE_PERIOD` | 400ms | WebviewStore | Delay before showing "Loading" spinner during syncs. |
| `PASSAGE_HOLD_SEC` | 10s | Webview Audio Engine | Immunity window for segments with matching `intentId`. |

## 4. The "Guard" Consolidation

### Sovereignty Guard (WebviewStore)
Blocks extensions syncs that contradict the last user intent within the 1500ms `intentExpiry` window. Implements **Segmented Sovereignty**: allows Telemetry fields to pass while filtering Disruptive fields during the window.

### Reactive Pull Handshake (WebviewAudioEngine)
Replaces the "unsolicited push" model. The engine now waits for a `SYNTHESIS_READY` notification and explicitly requests data.
- **Rule**: Never ingest data unless an active pull request exists for that specific `cacheKey` and `intentId`.
- **Refinement**: If `intentId` matches the current active intent, the segment is NOT a zombie and must be fetched/buffered, regardless of temporary UI sync transitions.

### Monotonic Batch Hardening 
Ensures that synthesis and playback never drift due to Batch 0 leakage.
- **Rule**: Minimum valid `batchId` is 1.
- **Protocol**: If a request arrives at the Extension with ID 0, it must be hardened (auto-upgraded) to 1 or the current authoritative IDs (`playbackIntentId` and `batchId`) before starting synthesis.

## 4. Trigger System

- **USER_PRIMARY**: Direct clicks on Play/Pause. Triggers immediate optimistic patch.
- **AUTO_NEXT**: End of sentence. Extension-driven. No optimistic patch; waits for `UI_SYNC`.
- **HALT_INTERRUPT**: Stop command or Chapter Jump. Must flush all in-flight buffers.

## 5. Head Abstraction (Future Proofing)

The Orchestrator must be decoupled from the specific Sidebar or Webview implementation.
- **State Registry**: All UI "Heads" must subscribe to the same `WebviewStore` for state.
- **Action Inversion**: Heads do not trigger logic; they emit "Intent Requests" (e.g., `REQUEST_PLAY`) to the Orchestrator.
- **Auditory Parity**: The Auditory Strategy (Neural/Local) is the only component allowed to mark a sentence as "Finished".

## 6. Implementation Protocol

1. **State Latching**: Always update `intentId` before sending commands to the extension.
2. **Buffer Immunity**: Blobs tagged with the *current* `intentId` are immune to pruning for 5 seconds.
3. **Optimistic Locking**: Use `isAwaitingSync` to prevent "Command Overlap" (e.g., clicking Pause while a Play sync is in transit).
