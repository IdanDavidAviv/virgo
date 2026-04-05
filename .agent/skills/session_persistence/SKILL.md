---
name: session_persistence
description: Protocol for local session metadata persistence in the Read Aloud extension.
---

# Session Persistence Protocol

## 1. Rationale
To ensure human-readable session titles and turn metadata are correctly resolved in the UI without relying on central agent memory, all session-specific state must be persisted locally.

## 2. Storage Architecture
- **Root Directory**: `C:\Users\Idan4\.gemini\antigravity\read_aloud\`
- **Session Folder**: `<sessionId>\`
- **State File**: `state.json`

## 3. Metadata Schema (`state.json`)
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
1. Check for `state.json` in the session directory.
2. If present, parse `session_title`.
3. If absent or empty, fallback to the `sessionId` (truncated).

### 4.2 MCP Injection
In `mcpStandalone.ts` or `mcpBridge.ts`, the `inject_markdown` tool must accept an optional `session_title`:
1. Update `state.json` with the new title if provided.
2. Increment `current_turn_index` atomically.

## 5. Maintenance
- **Migration**: If `state.json` is missing but the session exists in `brain/`, migrate the `session_title` to the local `read_aloud` folder.
