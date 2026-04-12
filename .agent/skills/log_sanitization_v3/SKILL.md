---
name: log_sanitization_v3
description: Protocol for high-density, symmetrical shorthand logging in VS Code extensions.
---

# Log Sanitization Protocol (Tier-3)

## 0. Rationale: Diagnostic vs. Verbatim
Recursive JSON serialization of large state objects during debugging leads to terminal cropping and cognitive noise. This protocol solves this for **internal code logs**. However, it MUST NOT apply to user-facing content (conversational text), which is protected by the `read_aloud_injection_guard` verbatim protocol.

## 1. Governance Rules

### 1.1 Recursive Summarization
Any array with `length > 10` MUST be replaced with a string summary during serialization:
-   `[COUNT: {n} items]`
-   Applies to `voices`, `chapters`, `sentences`, etc.

### 1.2 Path & URI Compression
Filesystem paths and UUIDs MUST be shortened to preserve horizontal space:
-   `file:///.../24f2-9ddc-46d5-86e4-f499bb2cca28` -> `file:///.../24f2...cca28`

### 1.3 Tier-3 Shorthand Formatting
Abandon JSON formatting for log payloads. Use the **High-Density Shorthand** format:
-   **Format**: `[COMMAND] key:val | key2:val2`
-   **Benefit**: Removes all syntax noise. A single line can contain 3-4x more information without wrapping.

### 1.4 Bridge Symmetrics
The `sanitizer` logic MUST be mirrored in both the Extension (Backend) and Webview (Frontend) to ensure diagnostic logs look identical across the bridge.

### 1.5 High-Fidelity Exception (Critical Parity)
Any payload marked as `content`, `snippet`, or `markdown` used for user-facing auditory injections is EXEMPT from all summarization rules.
- **Audit Rule**: Terminal logs representing conversational text MUST remain verbatim to ensure the auditory audit trail matches the UI 1:1.
- **Scope**: This skill ONLY applies to diagnostic code logs (`console`, `logger`). It does not apply to the `read_aloud_injection_guard`.

## 2. Noise Suppression
High-frequency "heartbeat" or "sync" messages MUST be suppressed from the main output channel.
-   **Blacklist**: `state-sync`, `cacheStatus`, `progress`.
-   **Exception**: Only log errors from these channels.

### 1.6 Automation Signal Exemption (v2.4.2)
The ASCII signal marker `[STORE-SYNC-COMPLETE]` is EXEMPT from all noise suppression and summarization rules.
- **Mandate**: This marker MUST be emitted as a standalone, unformatted terminal line to ensure CDP automation can detect it via basic string matching.
