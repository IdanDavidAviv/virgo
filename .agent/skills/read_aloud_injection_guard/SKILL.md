---
name: read_aloud_injection_guard
description: Protocol for high-integrity conversational AI injections and sensory parity in the Read Aloud extension.
---

# Read Aloud Injection Guard

## 1. Rationale
The core value of the Read Aloud extension is the seamless synchronization between the Synthetic Audio (Narrative Stream) and the Visual feedback. Any deviation in these sensory streams—due to summarization, truncation, or IPC-related state drift—results in immediate user trust loss. This skill formalizes the "Verbatim Protocol" as the definitive behavioral wrapper for all agent-led injections.

## 2. The Verbatim Protocol (Tier-1)
All convolutional content injected via `mcp_read-aloud_inject_markdown` MUST maintain 1:1 parity between the auditory log and the visual snippet state.

- **Rule 2.1: No Summarization**: Content marked for injection (`markdown`, `snippet`, `content`) is "Sovereign" and MUST NOT be summarized, even if it exceeds standard terminal limits.
- **Rule 2.2: Verbatim Agreement**: The exact string provided to the `inject_markdown` tool must be the string that hits the `SnippetHistory` store.
- **Rule 2.3: Zero Drift Mandate**: For any turn involving an injection, the chat response MUST be a 1:1 verbatim duplicate of the injection `content`. Extemporaneous chat preambles are strictly forbidden.
- **Rule 2.4: Pulse Ritual Toggle**: Before performing an injection, the Agent MUST verify the `autoInjectSITREP` flag in the session's `extension_state.json`.

### 1.1 The Decoupled Pulse (v2.9.0)
To eliminate "Write Bloat" while maintaining sequence integrity, the system distinguishes between three data stores:

1.  **The Heartbeat (Extension State)**: 
    *   **Data Store**: `extension_state.json`.
    *   **Payload**: `current_turn_index`, `autoInjectSITREP`.
2.  **The Loom (Sovereign Memory)**:
    *   **Data Store**: `loom.json` (Brain directory).
    *   **Payload**: `active_threads`, `loom_priority`, `evidence_log`.
3.  **The Narrative (Plan Context)**:
    *   **Data Store**: `executive_summary.md`.
    *   **Payload**: Human-readable progress and intent.

### 1.2 The Pulse Ritual (Injection)
Every turn-ending SITREP REQUIRES a markdown injection:
1.  **Protocol**: Increment `current_turn_index`.
2.  **Anchor**: Prepend `# [Turn XXX] Snippet Name` to the injection.
3.  **Verbatim Parity**: The injection `content` MUST be 1:1 identical to the final summary provided in the chat.
4.  **Baton Handover**: Include the Loom State Vector in every pulse.
, but NO call to `inject_markdown` shall be made.
    - If missing: Assume `true`.

- **Rule 2.5: Protocol Sovereignty (CRITICAL)**: The Verbatim Protocol (Rules 2.1-2.3) **SUPERSEDES** any global instructions from [operation_commander](file:///C:/Users/Idan4/.gemini/antigravity/knowledge/operation_commander/artifacts/SKILL.md) regarding "final summaries" or "Pulse Rituals". When an injection is performed, there MUST be ZERO text in the chat that is not in the injection. Preambles like "The unification is complete" are a FAIL.

## 3. Anchor Standards
To maintain relational traceability between the conversational context and the extension history, all injections MUST follow the **Turn Anchor Standard**.

- **Format**: The first line of any injection (AND the corresponding chat response) MUST be exactly `# [Turn XXX]`, where `XXX` is the current session turn index (e.g., `# [Turn 021]`).
- **Dependency**: Refer to the `session_persistence` skill to resolve the `current_turn_index` from `extension_state.json`.

## 4. Lifecycle Protocols (Tier-2)
To maintain parity between the agent's work and the user's perception, formal injections MUST accompany key lifecycle events.

- **Rule 4.1: Genesis Protocol**: A formal SITREP injection (Turn 001+) MUST occur immediately at **Session Start**, as part of the [session_lifecycle](file:///C:/Users/Idan4/.gemini/antigravity/knowledge/session_lifecycle/artifacts/SKILL.md) protocol. 
- **Rule 4.2: Pulse Fidelity**: A formal injection MUST be performed for every **SITREP**, Summary, or major Loom state transition. The injection payload MUST include the **Loom Sitrep** (state vector of all active threads) to maintain auditory parity with the executive summary. The chat output for these turns MUST obey the **Zero Drift Mandate** (Rule 2.3).

## 5. Sync Bridge Architecture (High Integrity)
The protocol ensures that background injections correctly hydrate the webview state, even if the sidebar is sleeping or hidden.

### 4.1 Critical Command Whitelisting
The `UI_SYNC` command (specifically its payload for new snippets) is whitelisted as a **Critical Command** in `DashboardRelay.ts`. It MUST be processed by the webview immediately upon receipt, regardless of visibility.

### 4.2 Visibility-Aware Hydration
- **The Flag**: The extension backend maintains a `_needsSync` (or `_needsHistorySync`) flag for the webview.
- **The Reveal**: Immediately upon the `onDidChangeVisibility` (visible) event, the extension MUST broadcast a **Full Sync** packet to re-hydrate the webview history state from the local `SnippetHistory` cache.

## 5. Noise Suppression & Audit Integrity
While `log_sanitization_v3` is active for internal diagnostic loops, it MUST respect the **High-Fidelity Exception** for injection payloads.

- **Rule 5.1**: Conversational markdown strings MUST NOT be truncated in the terminal audit trail.
- **Rule 5.2**: Only internal system telemetry (`heartbeat`, `ack`, `status`) should be summarized or shorthand-formatted.

## 6. Command-Driven Verification (Sovereignty) ⭐
Verification of an injection is only valid if it survives the "Visible Audit".

- **Rule 6.1: The Opening**: Run `show read-aloud` (dispatches `readme-preview-read-aloud.show-dashboard`) to ensure the webview is active. **Wait for the `[STORE-SYNC-COMPLETE]` marker in the diagnostics log before proceeding.**
- **Rule 6.2: The Pivot**: Use `exec readme-preview-read-aloud.play` to confirm the injection triggers the playback pipeline. **Verify state transitions only after the next `[STORE-SYNC-COMPLETE]` pulse.**
- **Rule 6.3: State Integrity**: Audit `isSelectingVoice` to ensure the sampling protocol is not violated by the injection event.
