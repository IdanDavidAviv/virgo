---
name: state_coherence_v4
description: Protocol for high-integrity state auditing, conflict detection, and sovereign state management.
---

# State Coherence Audit Protocol

This skill defines the authoritative procedure for auditing state variables, identifying redundancy, and ensuring sovereign state management. It is designed to prevent "Split-Brain Syndrome" in complex applications where multiple entities (Extension, Webview, Controllers) compete for control.

## 1. Audit Methodology

Follow these four phases sequentially when tasked with a "State Audit."

### Phase 1: Surface Discovery
- **Identify Stores**: List all central state containers (e.g., `WebviewStore.ts`, `PlaybackEngine.ts`).
- **Grep for Mutations**: Search for direct assignments (`state.x = y`) versus functional updates (`updateState({ x: y })`).
- **Map Controllers**: Identify the "Heads" that trigger these mutations (e.g., `PlaybackController.ts`).

### Phase 2: Conflict Matrix Mapping
Create a matrix to identify redundant or overlapping variables. Use the template below:

| Variable | Scope | Mutator(s) | Redundancy Link | Issue |
| :--- | :--- | :--- | :--- | :--- |
| `isPlaying` | Extension | `PlaybackEngine` | `WebviewStore.isPlaying` | Split-brain risk during IPC. |
| `intent` | Webview | `PlaybackController` | `WebviewStore.playbackIntent` | Duplicate state in Controller/Store. |

### Phase 3: Sovereignty Check
For every "Atomic Transition" (e.g., Playing to Paused, Mode A to Mode B), ask:
1.  **Who owns the Lock?** (e.g., A watchdog timer or an IntentId).
2.  **Is the Lock global or local?** (Shared across components or isolated).
3.  **Does the Lock block conflicting Syncs?** (Sovereignty over external updates).

### Phase 4: Controller-Driven Refactoring
Apply the **Sovereign Model** to resolve conflicts:
- **Rule 1**: The `Store` is a **Reactive View-Model**. It reflects the truth but does not define it.
- **Rule 2**: The `Controller` is the **Sovereign Authority**. It manages timers, locks, and atomic logic.
- **Rule 3**: Components **NEVER** update the Store directly for logical shifts; they must call a Controller action.

## 2. Red Flags (Split-Brain Symptoms)

- **Flickering UI**: The UI reverts to an old state for <100ms before correcting.
- **Timer Divergence**: Two different components have different "Intent Timeout" values for the same action.
- **Double-Sync**: An IPC command is sent, and a "Sync" packet from the extension arrives *before* the command's confirmation, causing a state revert.

## 3. Sovereignty Guard Patterns

### Intent-ID Latching (Robust)
Instead of time-based locks, use incremental IDs for every user action.
```typescript
// Controller
this.lastIntentId = generateId();
this.store.update({ intentId: this.lastIntentId, locked: true });

// Sync Handler
if (incomingData.intentId < this.store.getIntentId()) {
    return; // Discard stale packet
}
```

### Time-Based Sovereignty (Fallback)
Grant a "Window of Immunity" to the user's last action.
```typescript
// Controller
this.intentExpiry = Date.now() + 1000;

// Sync Handler
if (Date.now() < this.intentExpiry) {
   // Ignore extension sync, user intent is currently sovereign
}
```

## 4. Implementation Checklist

- [ ] Consolidate overlapping flags into a single "Source of Truth" enum.
- [ ] Move logic-based derived states (e.g., `isSyncing`) into a single method or a Controller property.
- [ ] Ensure all "Optimistic UI" patches are tied to a specific "Sovereignty Lock" that is explicitly released by the Controller.
