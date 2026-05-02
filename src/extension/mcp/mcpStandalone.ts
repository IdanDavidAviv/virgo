import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "path";
import { createVirgoMcpServer } from "./core/mcpFactory";
import { PendingInjectionStore } from "./core/sharedStore";
// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __APP_VERSION__: string;

/**
 * Portless MCP Server for Virgo (Standalone)
 * Communicates via Stdio and synchronizes via the sessions directory.
 */

async function main() {
    // 1. Environment Discovery
    const userHome = process.env.USERPROFILE || process.env.HOME || "";
    // [MP-001 T-015] Canonical sessions root: virgo/sessions/
    // Override via VIRGO_ROOT or VIRGO_DATA_DIR env var for custom deployments.
    const virgoRootName = process.env.VIRGO_ROOT || "virgo";
    const defaultSessionsRoot = path.join(userHome, ".gemini", "antigravity", virgoRootName, "sessions");
    const sessionsRoot = process.env.VIRGO_DATA_DIR || process.env.VIRGO_DATA_DIR || defaultSessionsRoot;
    
    // Standalone targets the sessions root; the factory handles specific session IDs via tool arguments.
    const persistencePath = sessionsRoot;

    const logger = (msg: string) => {
        if (process.env.NODE_ENV !== 'production') {
            console.error(`[MCP_STANDALONE] ${msg}`);
        }
    };
    
    logger(`Sessions Root: ${sessionsRoot}`);

    // 3. Setup Store & Factory
    const store = new PendingInjectionStore(persistencePath);
    const server = createVirgoMcpServer({
        persistencePath,
        sessionsRoot,
        logger,
        store,
        version: __APP_VERSION__
    });

    // 4. Connect Transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    logger("Portless Server running (Stdio)");
}

// [LIVENESS PROBE] One-shot health check. Extension calls: npx virgo-mcp --ping
// Prints VIRGO_MCP_OK and exits 0 — no server boot, no stdio transport.
if (process.argv.includes('--ping')) {
    console.log('VIRGO_MCP_OK');
    process.exit(0);
}

main().catch((err) => {
    console.error("[MCP_STANDALONE] Critical failure:", err);
    process.exit(1);
});
