---
name: session_persistence
description: Protocol for local session metadata persistence in the Read Aloud extension.
---

# Session Persistence Protocol

## 1. Rationale
To ensure human-readable session titles and turn metadata are correctly resolved in the UI without relying on central agent memory, all session-specific state must be persisted locally.

## 2. Storage Architecture

- **Antigravity Root**: `~/.gemini/antigravity/` (absolute, OS-normalized)
- **Snippet Root**: `~/.gemini/antigravity/read_aloud/`
- **Session Folder**: `~/.gemini/antigravity/read_aloud/<sessionId>/`
- **State File**: `~/.gemini/antigravity/read_aloud/<sessionId>/extension_state.json`
- **Snippet Files**: `~/.gemini/antigravity/read_aloud/<sessionId>/<timestamp>_<name>.md`

> [!IMPORTANT]
> The `_antigravityRoot` field in `SpeechProvider` is set to `path.join(root, 'read_aloud')` — NOT the bare `antigravity/` root.
> `_getSnippetHistory()` scans `_antigravityRoot` directly. Session directories are immediate children of this path.

## 3. Metadata Schema (`extension_state.json`)
```json
{
  "session_title": "Human Readable Title",
  "current_turn_index": 0,
  "last_updated": "2026-04-05T00:00:00Z"
}
```

## 4. Resolution Protocol
### 4.1 UI Resolution (Snippet History)
In `speechProvider.ts`, use `_getSnippetHistory()` to resolve the `displayName`:
1. Check for `extension_state.json` in the session directory.
2. If present, parse `session_title`.
3. If absent or empty, fallback to the `sessionId` (truncated).

### 4.2 MCP Injection
In `mcpStandalone.ts` or `mcpBridge.ts`, the `inject_markdown` tool must accept an optional `session_title`:
1. Update `extension_state.json` with the new title if provided.
2. Increment `current_turn_index` atomically.
3. **Guard**: Adhere strictly to the verbatim parity rules defined in [read_aloud_injection_guard](../read_aloud_injection_guard/SKILL.md).

## 5. Maintenance
- **Update Location**: Metadata updates MUST target `extension_state.json`.
- **Abolition**: `state.json` in the `brain/` directory is deprecated and MUST NOT be used for session vitals.

---

## 6. Snippet Scanner Exclusion List

> [!NOTE]
> Observed: 2026-04-10. `_getSnippetHistory()` iterates ALL directories in `antigravityRoot` (`read_aloud/`).
> System-only directories are NOT user sessions and produce empty results but waste I/O and clutter
> session discovery. They MUST be excluded from the scan.

### Directories to Filter (in `_getSnippetHistory()`)

| Directory | Reason |
|---|---|
| `brain/` | Agent memory (already excluded — line 802) |
| `protocols/` | Agent protocol templates — not a user session |
| `tempmediaStorage/` | Transient media files — not a user session |

### Implementation
```typescript
// REQUIRED filter in _getSnippetHistory() directory scan:
const EXCLUDED_DIRS = new Set(['brain', 'protocols', 'tempmediaStorage']);

// In the filter instead of checking name === 'brain' only:
if (EXCLUDED_DIRS.has(name)) { return null; }
```

### Files in Root (Non-Session)
These are filtered automatically by the `type !== FileType.Directory` check:
- `active_servers.json`
- `mcp_discovery.json`
- Any future flat files added to the root

---

## 7. Dual-Path Architecture — Agent Artifacts vs. Snippets

> [!IMPORTANT]
> There are TWO distinct storage paths used by the system. Conflating them will cause the Snippet Discovery sidebar to show empty.

| Path | Purpose | Scanner Reads It? |
|---|---|---|
| `brain/<sessionId>/` | Agent artifacts (`task.md`, `implementation_plan.md`, media, scratch) | ❌ NOT scanned by `_getSnippetHistory()` |
| `read_aloud/<sessionId>/` | User-playable snippet `.md` files injected via MCP `inject_markdown` | ✅ YES — this is where `_getSnippetHistory()` reads from |

### Implication for MCP Injection

When `inject_markdown` is called by the AI agent (via `mcp_read-aloud_inject_markdown`):
- The `.md` file MUST be written to `read_aloud/<sessionId>/<timestamp>_<snippet_name>.md`
- If instead it is written to `brain/<sessionId>/`, it will NEVER appear in the Snippet Discovery UI

### Symptom: Empty Snippet Discovery

If the Snippet tab shows "No injected snippets found" for the **current session**, the most likely cause is:
1. The MCP injection tool wrote the file to `brain/<sessionId>/` instead of `read_aloud/<sessionId>/`
2. The session directory exists in `read_aloud/` but contains only `extension_state.json` (no `.md` files)

**Remedy:** Verify that `inject_markdown` writes to the correct `read_aloud/` path before troubleshooting the scanner.
