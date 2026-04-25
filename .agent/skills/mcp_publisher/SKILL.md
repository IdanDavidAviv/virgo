---
name: mcp_publisher
description: >
  Governance protocol and automated scripts for packaging and publishing the Virgo MCP standalone server 
  to the public NPM registry. Enforces safety gates and clean extraction logic.
---

# 📦 MCP Publisher

> **Single Source of Truth for extracting and publishing the standalone MCP server.**

---

## 0. Rationale

The Virgo extension bundles a standalone Model Context Protocol (MCP) server for integrations with AI IDEs like Claude Desktop and Cursor. To avoid fragile absolute paths (`C:\Users\...\mcp-standalone.js`), the server must be deployed globally via NPM so users can execute it cleanly via `npx -y virgo-mcp`.

This skill encapsulates the logic that safely separates the bundled MCP script from the larger VS Code extension, attaches a bespoke `package.json`, and publishes it to the registry.

---

## 1. The Protocol

When the user requests to "publish the MCP server", the following happens:

1. **Build Validation**: The extension must be built first (`npm run build`) to ensure `dist/mcp-standalone.js` exists and contains the necessary Node execution hashbang (`#!/usr/bin/env node`).
2. **Extraction Ritual**: The script `scripts/publish_mcp.js` takes over. It creates a temporary staging directory (`dist-npm-mcp`), copies the executable, and synthesizes a lightweight `package.json` scoped exclusively to the executable's execution scope.
3. **Publishing**: Finally, the script executes `npm publish --access public`.

---

## 2. Authorization Gate

> [!CAUTION]
> **ABSOLUTE AUTHORIZATION GATE — NON-NEGOTIABLE**
> The agent is **STRICTLY FORBIDDEN** from executing `npm run publish:mcp` without an
> **explicit, scoped GO** that directly references the publishing of the MCP package.
> 
> Because this command interacts directly with the public NPM registry using the user's local credentials, accidental execution is a severe violation. 

---

## 3. Usage Commands

- **Dry Run Test (Safety Check)**: `node .agent/skills/mcp_publisher/scripts/publish_mcp.js` (Note: Ensure `--dry-run` is temporarily patched into the script if testing safely, though by default it executes a real publish).
- **Production Publish**: `npm run publish:mcp`

---

## 4. Dependencies

This skill works synergistically with the `release_authority` skill. When bumping a version in `release_authority`, the version cascades down because the `publish_mcp` script explicitly reads the active `version` from the root `package.json` during the extraction phase. There is no risk of version drift.
