---
name: read_aloud_injection_guard
description: Protocol for high-integrity conversational AI injections and sensory parity in the Read Aloud extension.
---

# Read Aloud Injection Guard

## 1. Rationale
The core value of the Read Aloud extension is the seamless synchronization between what the user hears (Auditory) and what they see (Visual). Any deviation in these sensory streams—due to summarization, truncation, or IPC-related state drift—results in immediate user trust loss. This skill formalizes the "Verbatim Protocol" as the definitive behavioral wrapper for all agent-led injections.

## 2. The Verbatim Protocol (Tier-1)
All convolutional content injected via `mcp_read-aloud_inject_markdown` MUST maintain 1:1 parity between the auditory log and the visual snippet state.

- **Rule 2.1: No Summarization**: Content marked for injection (`markdown`, `snippet`, `content`) is "Sovereign" and MUST NOT be summarized, even if it exceeds standard terminal limits.
- **Rule 2.2: Verbatim Agreement**: The exact string provided to the `inject_markdown` tool must be the string that hits the `SnippetHistory` store.
- **Rule 2.3: Zero Drift Mandate**: For any turn involving an injection, the chat response MUST be a 1:1 verbatim duplicate of the injection `content`. Extemporaneous chat preambles are strictly forbidden.

## 3. Anchor Standards
To maintain relational traceability between the conversational context and the extension history, all injections MUST follow the **Turn Anchor Standard**.

- **Format**: The first line of any injection MUST be exactly `# [Turn XXX]`, where `XXX` is the current session turn index.
- **Dependency**: Refer to the `session_persistence` skill to resolve the `current_turn_index`.

## 4. Lifecycle Protocols (Tier-2)
To maintain parity between the agent's work and the user's perception, formal injections MUST accompany key lifecycle events.

- **Rule 4.1: Genesis Protocol**: A formal SITREP injection (Turn 001+) MUST occur immediately at **Session Start**, as part of the [session_lifecycle](file:///C:/Users/Idan4/.gemini/antigravity/knowledge/session_lifecycle/artifacts/SKILL.md) protocol. 
- **Rule 4.2: SITREP Fidelity**: A formal injection MUST be performed for every **SITREP** or major decision gate. The chat output for these turns MUST obey the **Zero Drift Mandate** (Rule 2.3).

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
