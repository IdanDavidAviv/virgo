---
name: read_aloud_injection_guard
description: Protocol for high-integrity conversational AI injections and sensory parity in the Read Aloud extension.
---

# Read Aloud Injection Guard

> [!IMPORTANT]
> **Current State (v2.5.3)**: The MCP server has ONE core function — `say_this_loud`. The auto-SITREP loop, `autoInjectSITREP` flag, and protocol-reading boot sequence were aspirational and are **not reliably triggered**. Do NOT assume these work automatically. The agent must call `say_this_loud` explicitly when it wants to surface content in the sidebar.

---

## 1. What The MCP Actually Does (SSOT)

The Read Aloud MCP server is a **sidecar HTTP service** (SSE + REST) running inside the VS Code extension process. Its sole production mission:

```
Agent calls say_this_loud
  → PendingInjectionStore.save() writes <timestamp>_<name>.md to sessions/<id>/
  → McpBridge emits 'injected'
  → SpeechProvider.refreshView() is called
  → Snippet History sidebar updates in real time
```

**No other behavior is guaranteed to be active.**

---

## 2. The One Tool That Works: `say_this_loud`

```json
{
  "tool": "say_this_loud",
  "arguments": {
    "content": "# Markdown content here...",
    "snippet_name": "my_sitrep",
    "sessionId": "<active-session-id>",
    "session_title": "Optional human-readable title",
    "turnIndex": 42
  }
}
```

**Rules:**
- `content` + `snippet_name` + `sessionId` are **required**
- `session_title` and `turnIndex` are optional (omit if uncertain)
- Do NOT pass a stale `turnIndex` lower than the current one — it will be rejected. Omit it to auto-increment safely.
- The tool writes to `~/.gemini/antigravity/read_aloud/sessions/<sessionId>/`
- File name format: `<timestamp>_<safe_name>.md`
- A `# [Turn XXX]` header is prepended automatically if the content doesn't start with one

**Success response:**
```
Injected Turn 5 into session abc123 successfully at /path/to/file.md
```

---

## 3. Session ID Discovery

The agent must supply the correct `sessionId`. The canonical session ID is:
- The active brain session UUID (from the conversation context / `loom.json`)
- Readable from the `read_aloud://session/{sessionId}/state` resource (if SSE is connected)
- Or from the most recently modified directory under `~/.gemini/antigravity/read_aloud/sessions/`

> [!WARNING]
> The `protocols/` directory (`read_aloud://protocols/...`) is served by the MCP resource layer but **the `protocols` resource is scheduled for removal** (see MCP audit). Do not depend on it as a boot mechanism.

---

## 4. Verbatim Parity Rule (Still Applies)

When you inject content, it will be read aloud by the extension. Therefore:

- **Rule 4.1**: Content injected via `say_this_loud` MUST be meaningful and readable as prose — not raw JSON, file paths, or internal telemetry.
- **Rule 4.2**: Do not truncate or summarize user messages if injecting a SITREP — the user hears what you inject.
- **Rule 4.3**: If the injection fails (tool returns `isError: true`), do NOT report it as success. Alert the user.

---

## 5. The "Protocols" Directory — Context

The `~/.gemini/antigravity/read_aloud/protocols/` directory contains `.md` files that were intended to be read by the agent on boot via the `read_aloud://protocols/` MCP resource, enforcing automatic SITREP injection every turn.

**Current status**: The auto-boot mechanism (via the `read_aloud_boot` MCP prompt + `boot.md` protocol) **does not fire reliably** because MCP prompts are not auto-executed by Gemini on connection. The vision is sound — the execution layer is still maturing.

**What the protocols say (for reference):**
| File | Intent |
|------|--------|
| `boot.md` | Identifies session, loads vitals, initializes SITREP |
| `manifest.md` | Overview of the "Standalone" architecture |
| `orchestrator.md` | Turn-by-turn injection loop |
| `injection_guard.md` | Verbatim parity rules |
| `sensory_integrity.md` | No truncation in injections |

These files remain as aspirational documentation. When the agent-boot mechanism is stabilized, they will become the active runtime protocol.

---

## 6. Sync Architecture (How Injection Reaches The UI)

```
say_this_loud tool call
  ↓
PendingInjectionStore.save()  [sharedStore.ts]
  ↓ emits 'injected'
McpBridge  [mcpBridge.ts]
  ↓ emits 'injected' to EventEmitter
extension.ts listener (mcpBridge.on('injected'))
  ↓ calls
SpeechProvider.refreshView()  [speechProvider.ts]
  ↓ calls
_getSnippetHistory()  — scans sessions/<id>/*.md only
  ↓
StateStore.setSnippetHistory()
  ↓ emits 'change'
SyncManager  — hash includes snippetHistory
  ↓
DashboardRelay.sync()  →  UI_SYNC packet  →  Webview sidebar updates
```

**Key invariants:**
- Only `.md`/`.markdown` files are discovered (non-markdown files are filtered)
- `extension_state.json` does NOT appear in the sidebar (filtered by extension)
- Snippet history is limited to the **10 most recent sessions**
- The entire pipeline is **event-driven** — no polling

---

## 7. Available MCP Tools & Resources

| Name | Type | Status | Use |
|------|------|--------|-----|
| `say_this_loud` | Tool | ✅ Active | Inject content into sidebar |
| `self_diagnostic` | Tool | ✅ Active | Health check (pid, path, version) |
| `get_injection_status` | Tool | ✅ Active | Store size + persistence path |
| `native-logs` | Resource | ✅ Active | VS Code output channel logs |
| `debug-logs` | Resource | ✅ Active | Extension diagnostic log file |
| `injected-snippets` | Resource | ✅ Active | Read back injected `.md` files |
| `session-state` | Resource | ⚠️ Stale | Returns `extension_state.json` — scheduled for removal |
| `protocols` | Resource | ⚠️ Deprecated | Returns protocol `.md` files — scheduled for removal |
| `read_aloud_boot` | Prompt | ❌ Unreliable | Not auto-triggered; noop in practice |
