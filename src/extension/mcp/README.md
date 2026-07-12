# virgo-mcp

Standalone Model Context Protocol (MCP) server for the **Virgo** VS Code Extension (audio narration engine).

This server connects AI coding agents (like Antigravity, Claude Desktop, or Cursor) to the Virgo extension, enabling them to send audio narration requests.

*   **Repository**: [https://github.com/IdanDavidAviv/virgo](https://github.com/IdanDavidAviv/virgo)
*   **VS Code Marketplace**: [Virgo Extension](https://marketplace.visualstudio.com/items?itemName=IdanDavidAviv.virgo)

---

## 🚀 Installation & Configuration

To integrate your AI assistant with Virgo, configure it to run this server using `npx`:

### 1. Antigravity IDE / Gemini Agent (`mcp_config.json`)
Add the following configuration block:
```json
{
  "mcpServers": {
    "virgo": {
      "command": "npx",
      "args": [
        "-y",
        "virgo-mcp@latest"
      ],
      "env": {
        "VIRGO_ROOT": "virgo"
      }
    }
  }
}
```

### 2. Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "virgo": {
      "command": "npx",
      "args": [
        "-y",
        "virgo-mcp@latest"
      ],
      "env": {
        "VIRGO_ROOT": "virgo"
      }
    }
  }
}
```

---

## 🛠️ Provided Tools

### 1. `say_this_loud`
Surfaces text in the Virgo sidebar. Use this to feed prose text (SITREPs, walkthroughs, milestones) to the narration queue.
*   `content` (string): The markdown prose content.
*   `sessionId` (string): The active brain session UUID.
*   `snippet_name` (string): Short descriptive slug.

### 2. `self_diagnostic`
Checks the liveness and status of the MCP server.

### 3. `get_injection_status`
Returns persistence status and snippet counts on disk.

---

## 📂 Resources

*   `virgo://logs/live_log`: Live diagnostic stream from the VS Code Output Channel.
*   `virgo://session/{sessionId}/state`: Abstracted real-time access to the session's vitals (active mode, current turn index, and playback progress).

---

## 📜 License
This project is licensed under the terms of the license found in the main repository.
