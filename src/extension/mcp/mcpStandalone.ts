import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "path";
import { createReadAloudMcpServer } from "./core/mcpFactory";
import { PendingInjectionStore } from "./core/sharedStore";

/**
 * Portless MCP Server for Read Aloud (Standalone)
 * Communicates via Stdio and synchronizes via the Brain directory.
 */

async function main() {
    // 1. Environment Discovery
    const userHome = process.env.USERPROFILE || process.env.HOME || "";
    const defaultBrainRoot = path.join(userHome, ".gemini", "antigravity", "read_aloud");
    const brainRoot = process.env.READ_ALOUD_DATA_DIR || defaultBrainRoot;
    
    // Standalone usually targets the last active session if none is specified, 
    // but the factory handles specific session IDs via tool arguments.
    // We'll set the persistencePath to the brainRoot for general discovery.
    const persistencePath = brainRoot; 

    const logger = (msg: string) => console.error(`[MCP_STANDALONE] ${msg}`);
    
    logger(`Brain Root: ${brainRoot}`);

    // 3. Setup Store & Factory
    const store = new PendingInjectionStore(persistencePath);
    const server = createReadAloudMcpServer({
        persistencePath,
        brainRoot,
        logger,
        store,
        version: "2.2.0"
    });

    // 4. Connect Transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    logger("Portless Server running (Stdio)");
}

main().catch((err) => {
    console.error("[MCP_STANDALONE] Critical failure:", err);
    process.exit(1);
});
