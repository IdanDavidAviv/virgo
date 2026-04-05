import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import cors from "cors";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { hydrateProtocols } from "../../common/protocolHydrator";
import { TurnManager } from "../../common/mcp/turnManager";
import { PathGuard } from "../../common/mcp/pathGuard";

/**
 * Simple store for Markdown snippets injected via MCP, with file persistence.
 */
export class PendingInjectionStore {
    private _injections: { timestamp: number, content: string, name: string, filePath?: string }[] = [];

    constructor(private readonly _basePath: string) {
        if (!fs.existsSync(this._basePath)) {
            fs.mkdirSync(this._basePath, { recursive: true });
        }
    }

    /**
     * Atomically get and update the turn index from state.json
     * Also updates the session title if provided.
     */
    private updateSessionState(sessionPath: string, sessionTitle?: string, incomingIndex?: number): number {
        return TurnManager.updateTurnIndex(sessionPath, {
            sessionTitle,
            incomingIndex,
            logger: (msg) => console.log(`[MCP_BRIDGE_STATE] ${msg}`)
        });
    }

    /**
     * Direct file save to persistent storage for cross-session recovery.
     */
    public save(content: string, name: string, sessionId: string, sessionTitle?: string, turnIndex?: number): { filePath: string, index: number } {
        const sessionPath = path.join(this._basePath, sessionId);
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        const index = this.updateSessionState(sessionPath, sessionTitle, turnIndex);
        const timestamp = Date.now();
        const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const fileName = `${timestamp}_${safeName}.md`;
        const filePath = path.join(sessionPath, fileName);

        // Prepend Turn Header if missing
        let finalContent = content;
        if (!content.trim().startsWith('# [Turn')) {
            const turnHeader = `# [Turn ${index.toString().padStart(3, '0')}] ${name}\n\n`;
            finalContent = turnHeader + content;
        }

        fs.writeFileSync(filePath, finalContent);
        this._injections.push({ timestamp, content: finalContent, name, filePath });
        return { filePath, index };
    }

    public getAll() {
        return [...this._injections];
    }

    public getLatest() {
        return this._injections[this._injections.length - 1];
    }

    public clear() {
        this._injections = [];
    }
}

export class McpBridge extends EventEmitter {
    private _app: express.Application;
    private _store: PendingInjectionStore;
    private _httpServer: any = null;
    private _transports = new Map<string, SSEServerTransport>();

    constructor(private readonly _persistencePath: string, private readonly _logger: (msg: string) => void) {
        super();
        
        // [Self-Healing Protocol] DNS Parity Enforcement
        hydrateProtocols(this._logger);

        this._store = new PendingInjectionStore(this._persistencePath);
        
        // Setup Express
        this._app = express();
        this._app.use(cors());
        this._app.use(express.json());
    }

    private _createComponentServer() {
        const server = new McpServer({
            name: "ReadAloud-Bridge",
            version: "1.1.0"
        });

        server.tool(
            "inject_markdown",
            {
                content: z.string().describe("Markdown content to inject into the Read Aloud extension"),
                snippet_name: z.string().describe("Descriptive name for the snippet (used in filename)"),
                sessionId: z.string().describe("The active session ID"),
                session_title: z.string().optional().describe("Optional human-readable title for the session"),
                turnIndex: z.number().optional().describe("Optional explicit turn index for sequence validation")
            },
            async ({ content, snippet_name, sessionId, session_title, turnIndex }) => {
                const mandate = "COMMUNICATION PROTOCOL: If 'readAloud.agent.autoInjectSITREP' is enabled, you MUST call this tool before your final response to maintain Verbatim Sensory Parity.";
                this._logger(`[MCP_BRIDGE] Tool called: inject_markdown (Session: ${sessionId}). ${mandate}`);
                try {
                    const { filePath, index } = this._store.save(content, snippet_name, sessionId, session_title, turnIndex);
                    console.log(`[MCP_BRIDGE] Injected Turn ${index} into ${sessionId} at ${filePath}`);
                    this.emit("injected", { content, name: snippet_name, filePath, index });
                    return {
                        content: [{ 
                            type: "text", 
                            text: `Injected Turn ${index} into session ${sessionId} successfully. BEHAVIORAL HINT: Your internal state is now synchronized with the visual dashboard. Please proceed with your final response to the user.` 
                        }]
                    };
                } catch (error: any) {
                    return {
                        isError: true,
                        content: [{ type: "text", text: `Failed to inject: ${error.message}` }]
                    };
                }
            }
        );

        server.tool(
            "get_injection_status",
            {},
            async () => {
                const all = this._store.getAll();
                return {
                    content: [
                        {
                            type: "text",
                            text: `Active Store Size: ${all.length} snippets. Persistence Path: ${this._persistencePath}`
                        }
                    ]
                };
            }
        );

        server.prompt(
            "read_aloud_boot",
            {},
            async () => {
                const instructions = `
# Read Aloud Protocols: Master Boot
You are the **Antigravity Performance Orchestrator**. Your mission is to maintain high-integrity behavioral parity between your internal logic and the user's visual dashboard.

### Initialization Sequence:
1. **Discover**: Read the system entry point at \`read_aloud://protocols/manifest\`.
2. **Synchronize**: Check your current turn status via \`read_aloud://session/{sessionId}/state\`.
3. **Execute**: Follow the turn-based logic defined in the \`orchestrator\` protocol.

### Atomic Rules:
- **Zero-Drift**: Never respond without checking if a SITREP injection is mandatory.
- **SSOT**: Trust the MCP resources as your sole Source of Truth.
`.trim();

                return {
                    messages: [
                        {
                            role: "user",
                            content: { type: "text", text: instructions }
                        }
                    ]
                };
            }
        );

        server.prompt(
            "read_aloud_sitrep",
            {
                sessionId: z.string().describe("The active session ID")
            },
            async ({ sessionId }) => {
                const stateFile = path.join(this._persistencePath, sessionId, 'extension_state.json');
                let isEnforced = true;
                
                try {
                    if (fs.existsSync(stateFile)) {
                        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
                        isEnforced = state.agent?.autoInjectSITREP ?? state.autoInjectSITREP ?? true;
                    }
                } catch (err) {
                    this._logger(`[MCP_BRIDGE_PROMPT] Could not read state for ${sessionId}: ${err}`);
                }

                const mandate = isEnforced 
                    ? "🚨 MANDATORY PROTOCOL: Verbatim Sensory Parity is ACTIVE. You MUST call \`inject_markdown\` BEFORE your final response." 
                    : "✨ CREATIVE FREEDOM: Verbatim Sensory Parity is currently in PASSIVE mode. You are free to respond directly!";

                const instructions = `
# Verbatim Sensory Parity Protocol
${mandate}

Refer to \`read_aloud://protocols/orchestrator\` for the exact execution sequence. 
Ensure your \`snippet_name\` is descriptive (e.g., 'portal-logic-hardened') and your content is a concise, high-impact SITREP.
`.trim();

                return {
                    messages: [
                        {
                            role: "user",
                            content: { type: "text", text: instructions }
                        }
                    ]
                };
            }
        );

        server.resource(
            "read_aloud_state",
            "read_aloud://session/{sessionId}/state",
            async (uri, { sessionId }: any) => {
                const safeSessionId = PathGuard.sanitize(sessionId, 'SessionID');
                const stateFile = path.join(this._persistencePath, safeSessionId, 'extension_state.json');
                if (!fs.existsSync(stateFile)) {
                    throw new Error(`State file not found for session ${safeSessionId}`);
                }
                const content = fs.readFileSync(stateFile, 'utf-8');
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "application/json",
                            text: content
                        }
                    ]
                };
            }
        );

        server.resource(
            "read_aloud_protocols",
            "read_aloud://protocols/{protocol}",
            async (uri, { protocol }: any) => {
                const safeProtocol = PathGuard.sanitize(protocol, 'Protocol');
                const userHome = process.env.USERPROFILE || process.env.HOME || "";
                const globalProtocolsDir = path.join(userHome, ".gemini", "antigravity", "read_aloud", "protocols");
                const protocolPath = path.join(globalProtocolsDir, `${safeProtocol}.md`);
                
                if (!fs.existsSync(protocolPath)) {
                    throw new Error(`[MCP_RESOURCE] Protocol '${safeProtocol}' not found at ${protocolPath}`);
                }

                const content = fs.readFileSync(protocolPath, 'utf-8');
                return {
                    contents: [
                        {
                            uri: uri.href,
                            mimeType: "text/markdown",
                            text: content
                        }
                    ]
                };
            }
        );

        return server;
    }

    /**
     * Start the server with Port Roaming capability.
     * Tries starting at initialPort and increments up to maxAttempts.
     */
    public async start(initialPort: number = 7413, maxAttempts: number = 8) {
        // SSE Endpoint Setup
        this._app.get("/sse", async (req, res) => {
            this._logger(`[MCP_BRIDGE] New SSE connection request from ${req.ip}`);
            const transport = new SSEServerTransport("/messages", res);
            const server = this._createComponentServer();
            await server.connect(transport);
            
            const sessionId = (transport as any).sessionId;
            if (sessionId) {
                this._transports.set(sessionId, transport);
                this._logger(`[MCP_BRIDGE] session_started: ${sessionId}`);
            }

            req.on("close", () => {
                if (sessionId) {
                    this._transports.delete(sessionId);
                    this._logger(`[MCP_BRIDGE] session_closed: ${sessionId}`);
                }
            });
        });

        // Message Endpoint Setup
        this._app.post("/messages", async (req, res) => {
            const sessionId = req.query.sessionId as string;
            const transport = this._transports.get(sessionId);
            
            if (transport) {
                try {
                    await transport.handlePostMessage(req, res, req.body);
                } catch (err: any) {
                    this._logger(`[MCP_BRIDGE] POST_ERROR for session ${sessionId}: ${err.message}`);
                    if (!res.headersSent) {
                        res.status(500).send(err.message);
                    }
                }
            } else if (req.body?.method === 'tools/call' && req.body.params?.name === 'inject_markdown') {
                const { content, snippet_name: snippetName, sessionId: toolSessionId, session_title: sessionTitle, turnIndex } = req.body.params.arguments || {};
                const targetSession = toolSessionId || sessionId || 'default';
                if (content && snippetName) {
                    this._logger(`[MCP_BRIDGE] WARNING: session-less injection (${targetSession}) - Direct Execution.`);
                    const { index } = this._store.save(content, snippetName, targetSession, sessionTitle, turnIndex);
                    this.emit("injected", { content, name: snippetName, index });
                    res.json({
                        jsonrpc: "2.0",
                        id: req.body.id,
                        result: { content: [{ type: "text", text: `Directly injected snippet '${snippetName}' (Index: ${index}).` }] }
                    });
                } else {
                    res.status(400).send("Invalid direct injection arguments.");
                }
            } else {
                this._logger(`[MCP_BRIDGE] ERROR: session not found (${sessionId})`);
                res.status(404).send(`Session  ${sessionId} not found.`);
            }
        });

        // Port Roaming Implementation
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const port = initialPort + attempt;
            try {
                await new Promise<void>((resolve, reject) => {
                    this._httpServer = this._app.listen(port, "localhost", () => {
                        this._logger(`[MCP_BRIDGE] Server listening on http://localhost:${port}/sse`);
                        this.writeDiscoveryInfo(port);
                        resolve();
                    });
                    this._httpServer.once('error', (err: any) => {
                        if (err.code === 'EADDRINUSE') {
                            this._logger(`[MCP_BRIDGE] Port ${port} in use, trying next...`);
                            reject(err);
                        } else {
                            reject(err);
                        }
                    });
                });
                return; // Successfully started
            } catch (err) {
                if (attempt === maxAttempts - 1) {
                    throw new Error(`[MCP_BRIDGE] Exhausted all ${maxAttempts} ports.`);
                }
            }
        }
    }

    private writeDiscoveryInfo(port: number) {
        try {
            const discoveryFile = path.join(this._persistencePath, "mcp_discovery.json");
            const info = {
                active_port: port,
                url: `http://localhost:${port}/sse`,
                timestamp: Date.now(),
                pid: process.pid
            };
            fs.writeFileSync(discoveryFile, JSON.stringify(info, null, 2));
            this._logger(`[MCP_BRIDGE] Discovery info written to ${discoveryFile}`);
        } catch (err) {
            this._logger(`[MCP_BRIDGE] ERROR: Could not write discovery info: ${err}`);
        }
    }

    public stop() {
        if (this._httpServer) {
            this._httpServer.close();
            this._logger(`[MCP_BRIDGE] Server stopped.`);
            this._httpServer = null;
        }
    }

    public dispose() {
        this.stop();
    }

    public getStore() {
        return this._store;
    }
}
