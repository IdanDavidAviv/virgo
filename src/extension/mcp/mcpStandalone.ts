import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

/**
 * Portless MCP Server for Read Aloud
 * Communicates via Stdio and synchronizes via the Antigravity Root filesystem.
 */

// 1. Setup MCP Server
const server = new McpServer({
    name: "ReadAloud-Portless",
    version: "2.0.0"
});

// 2. Constants
const ANTIGRAVITY_ROOT = "C:/Users/Idan4/.gemini/antigravity/read_aloud";

/**
 * Atomic state management for Turn-Aware Antigravity Sessions.
 */
function getAndUpdateTurnIndex(sessionPath: string): number {
    const stateFile = path.join(sessionPath, 'state.json');
    let index = 1;

    try {
        if (fs.existsSync(stateFile)) {
            const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            index = (data.current_turn_index || 0) + 1;
        }
        
        fs.writeFileSync(stateFile, JSON.stringify({ current_turn_index: index }, null, 2));
    } catch (err) {
        console.error(`[MCP_STATE] Failed to update state.json: ${err}`);
        // Fallback to 1 if we can't read/write, at least we mark the turn
    }

    return index;
}

// 3. Define the inject_markdown tool
server.tool(
    "inject_markdown",
    {
        content: z.string().describe("Markdown content to inject into the Read Aloud extension"),
        snippet_name: z.string().describe("Descriptive name for the snippet (used in filename)"),
        sessionId: z.string().describe("The active Antigravity Session ID (Conversation ID) to target.")
    },
    async ({ content, snippet_name, sessionId }) => {
        const sessionPath = path.join(ANTIGRAVITY_ROOT, sessionId);
        
        // Ensure path exists
        if (!fs.existsSync(sessionPath)) {
            try {
                fs.mkdirSync(sessionPath, { recursive: true });
            } catch (err: any) {
                return {
                    content: [{ type: "text", text: `Failed to create session directory: ${err.message}` }],
                    isError: true
                };
            }
        }

        const index = getAndUpdateTurnIndex(sessionPath);
        const timestamp = Date.now();
        const safeName = snippet_name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const fileName = `${timestamp}_${safeName}.md`;
        const filePath = path.join(sessionPath, fileName);

        // [AUTOMATION] Prepend Turn Header if not present
        let finalContent = content;
        if (!content.trim().startsWith('# [Turn')) {
            const turnHeader = `# [Turn ${index.toString().padStart(3, '0')}] ${snippet_name}\n\n`;
            finalContent = turnHeader + content;
        }

        try {
            fs.writeFileSync(filePath, finalContent);
            // Log to stderr so it doesn't break JSON-RPC over stdout
            console.error(`[MCP] Injected Turn ${index} (${fileName}) into ${sessionId}`);
            
            return {
                content: [
                    {
                        type: "text",
                        text: `Successfully injected '${snippet_name}' into session '${sessionId}'. The extension will auto-load this snippet if it's currently active.`
                    }
                ]
            };
        } catch (err: any) {
            return {
                content: [{ type: "text", text: `Failed to write file: ${err.message}` }],
                isError: true
            };
        }
    }
);

// 4. Start the server using Stdio
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[MCP_STANDALONE] Portless Server running (Stdio)");
}

main().catch((err) => {
    console.error("[MCP_STANDALONE] Critical failure:", err);
    process.exit(1);
});
