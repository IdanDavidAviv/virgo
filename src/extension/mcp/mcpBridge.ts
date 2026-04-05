import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import cors from "cors";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";

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
    private updateSessionState(sessionPath: string, sessionTitle?: string): number {
        const stateFile = path.join(sessionPath, 'extension_state.json');
        let index = 1;
        let currentState: any = {};

        try {
            if (fs.existsSync(stateFile)) {
                currentState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
                index = (currentState.current_turn_index || 0) + 1;
            }
            
            const newState = { 
                ...currentState,
                current_turn_index: index,
                ...(sessionTitle ? { session_title: sessionTitle } : {})
            };

            fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2));
        } catch (err) {
            console.error(`[MCP_BRIDGE_STATE] Failed to update state.json: ${err}`);
        }

        return index;
    }

    /**
     * Direct file save to persistent storage for cross-session recovery.
     */
    public save(content: string, name: string, sessionId: string, sessionTitle?: string): { filePath: string, index: number } {
        const sessionPath = path.join(this._basePath, sessionId);
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        const index = this.updateSessionState(sessionPath, sessionTitle);
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
                session_title: z.string().optional().describe("Optional human-readable title for the session")
            },
            async ({ content, snippet_name, sessionId, session_title }) => {
                try {
                    const { filePath, index } = this._store.save(content, snippet_name, sessionId, session_title);
                    console.log(`[MCP_BRIDGE] Injected Turn ${index} into ${sessionId} at ${filePath}`);
                    this.emit("injected", { content, name: snippet_name, filePath, index });
                    return {
                        content: [{ type: "text", text: `Injected Turn ${index} into session ${sessionId} successfully.` }]
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

        return server;
    }

    public async start(port: number = 7413) {
        // SSE Endpoint
        this._app.get("/sse", async (req, res) => {
            this._logger(`[MCP_BRIDGE] New SSE connection request from ${req.ip}`);
            const transport = new SSEServerTransport("/messages", res);
            const server = this._createComponentServer();
            
            await server.connect(transport);
            
            // Capture session ID for multi-session support
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

        // Message Endpoint
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
                // FALLBACK: In development, handle direct 'inject_markdown' calls even without SSE transport
                const { content, snippet_name: snippetName, session_title: sessionTitle } = req.body.params.arguments || {};
                if (content && snippetName) {
                    this._logger(`[MCP_BRIDGE] WARNING: session-less injection (${sessionId || 'unknown'}) - Direct Execution.`);
                    const { index } = this._store.save(content, snippetName, sessionId || 'default', sessionTitle);
                    this.emit("injected", { content, name: snippetName, index });
                    res.json({
                        jsonrpc: "2.0",
                        id: req.body.id,
                        result: {
                            content: [{ type: "text", text: `Directly injected snippet '${snippetName}' (Index: ${index}).` }]
                        }
                    });
                } else {
                    res.status(400).send("Invalid direct injection arguments.");
                }
            } else {
                this._logger(`[MCP_BRIDGE] ERROR: session not found (${sessionId})`);
                res.status(404).send(`Session  ${sessionId} not found.`);
            }
        });

        return new Promise<void>((resolve) => {
            this._httpServer = this._app.listen(port, "localhost", () => {
                this._logger(`[MCP_BRIDGE] Server listening on http://localhost:${port}/sse`);
                resolve();
            });
        });
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
