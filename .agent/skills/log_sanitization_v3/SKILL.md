---
name: log_sanitization_v3
description: Protocol for high-density, symmetrical shorthand logging in VS Code extensions.
---

# Log Sanitization Protocol (Tier-3)

## 0. Rationale
Recursive JSON serialization of large state objects (voices, chapters, binary buffers) leads to two critical failures:
1.  **Terminal Content-Cropping**: VS Code Output channels often crop lines that exceed a certain character count (the "ellipses of death").
2.  **Cognitive Overload**: Syntax noise (`{ }`, `"` , `"payload":`) makes it impossible to scan diagnostic streams at a glance.

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

## 2. Noise Suppression
High-frequency "heartbeat" or "sync" messages MUST be suppressed from the main output channel.
-   **Blacklist**: `state-sync`, `cacheStatus`, `progress`.
-   **Exception**: Only log errors from these channels.
