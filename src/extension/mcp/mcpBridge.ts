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

    public add(content: string, name: string) {
        const timestamp = Date.now();
        // Sanitize name for filename
        const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const fileName = `${timestamp}_${safeName}.md`;
        const filePath = path.join(this._basePath, fileName);

        try {
            fs.writeFileSync(filePath, content);
        } catch (err) {
            console.error(`[MCP_BRIDGE] Failed to persist snippet: ${err}`);
        }

        const entry = {
            timestamp,
            content,
            name,
            filePath
        };
        this._injections.push(entry);
        return this._injections.length - 1;
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
                snippet_name: z.string().describe("Descriptive name for the snippet (used in filename)")
            },
            async ({ content, snippet_name }) => {
                const index = this._store.add(content, snippet_name);
                this._logger(`[MCP_BRIDGE] INCOMING_MARKDOWN | Name: ${snippet_name} | Size: ${content.length} bytes | Index: ${index}`);
                
                // Notify listeners (SpeechProvider) that new markdown is available
                this.emit("new_injection", this._store.getLatest());

                return {
                    content: [
                        {
                            type: "text",
                            text: `Successfully injected Markdown snippet '${snippet_name}' (Index: ${index}). Content is persisted in the Antigravity Root.`
                        }
                    ]
                };
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
                const { content, snippet_name: snippetName } = req.body.params.arguments || {};
                if (content && snippetName) {
                    this._logger(`[MCP_BRIDGE] WARNING: session-less injection (${sessionId}) - Direct Execution.`);
                    const index = this._store.add(content, snippetName);
                    this.emit("new_injection", this._store.getLatest());
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
