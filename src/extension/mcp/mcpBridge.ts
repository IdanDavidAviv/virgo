import * as vscode from "vscode";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import cors from "cors";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { PathGuard } from "../../common/mcp/pathGuard";
import { PendingInjectionStore } from "./core/sharedStore";
import { createReadAloudMcpServer } from "./core/mcpFactory";

export class McpBridge extends EventEmitter {
    private _app: express.Application;
    private _store: PendingInjectionStore;
    private _httpServer: any = null;
    private _transports = new Map<string, SSEServerTransport>();
    private _server: McpServer | null = null;
    private static readonly SERVER_NAME = 'read-aloud';
    // [Gate 2] Startup Orchestration — coalesce SSE probes for the FULL session lifetime.
    // Gate opens on first connection and closes ONLY when the SSE connection closes (req 'close' event).
    // This prevents Gemini's MCP client from triggering eviction loops on every retry.
    private _isHandshaking: boolean = false;
    private _handshakeTimeout: NodeJS.Timeout | null = null;
    private _absorbedProbes: number = 0;

    constructor(
        private _persistencePath: string, 
        private readonly _logger: (msg: string) => void,
        private readonly _nativeLogUri?: { fsPath: string },
        private readonly _debugLogPath?: string,
        private readonly _extensionMode: number = 1, // Default to Production
        private readonly _version: string = "0.0.0"
    ) {
        super();
        
        this._store = new PendingInjectionStore(this._persistencePath);
        
        this._app = express();
        this._app.use(cors());
        this._app.use(express.json());

        this._initializeServer();
    }

    public async reinitialize() {
        this._logger(`[MCP_BRIDGE] Hub Re-Sync Initiated...`);
        if (this._server) {
            try {
                this._server.sendResourceListChanged();
                this._server.sendToolListChanged();
            } catch (e) {}
        }
        this._logger(`[MCP_BRIDGE] Hub Re-Sync Complete.`);
    }

    private _initializeServer() {
        this._logger(`[MCP_BRIDGE] Initializing Service Registry`);
        
        this._store.onInjected(({ content, name, index, filePath }) => {
            this.emit("injected", { content, name, index, filePath });
            if (this._server) {
                try { this._server.sendResourceListChanged(); } catch (e) {}
            }
        });
    }

    public pivotSession(newSessionId: string) {
        this._logger(`[MCP_BRIDGE] PIVOTING to session: ${newSessionId}`);
        const sessionsRoot = path.dirname(this._persistencePath);
        this._persistencePath = path.join(sessionsRoot, newSessionId);
        this._store.setBasePath(this._persistencePath);
        
        this.reinitialize();
    }

    private _createNewServer(): McpServer {
        this._logger(`[MCP_BRIDGE] Spawning New Server Instance`);
        
        const server = createReadAloudMcpServer({
            persistencePath: this._persistencePath,
            sessionsRoot: path.dirname(this._persistencePath),
            logger: this._logger,
            nativeLogUri: this._nativeLogUri,
            debugLogPath: this._debugLogPath,
            store: this._store,
            version: this._version
        });

        return server;
    }

    private _notifyAll(callback: (server: McpServer) => void) {
        if (this._server) {
            try { callback(this._server); } catch (err) {
                this._logger(`[MCP_BRIDGE] Broadcast Error: ${err}`);
            }
        }
    }

    /**
     * Start the server with Port Roaming capability.
     * Returns the port it settled on.
     */
    public async start(initialPort: number = 7413, maxAttempts: number = 8): Promise<number> {
        const envPort = process.env.READ_ALOUD_MCP_PORT ? parseInt(process.env.READ_ALOUD_MCP_PORT, 10) : undefined;
        if (envPort && !isNaN(envPort)) {
            this._logger(`[MCP_BRIDGE] Debug Override: Locking to port ${envPort}`);
            initialPort = envPort;
            maxAttempts = 1; // Failure is terminal if exclusive port is requested
        }
        
        // CORS must be available for all routes, but JSON is ONLY for our own custom POSTs
        this._app.use(cors());

        this._app.get("/health", (req, res) => {
            res.json({ status: "ok", mcp: "read-aloud", version: this._version });
        });


        this._app.get("/sse", async (req, res) => {
            // [Gate 3] Noise Mitigation — v2.4.6
            // Check immediately before any async yield to prevent race conditions.
            if (this._isHandshaking) {
                this._absorbedProbes++;
                if (this._absorbedProbes === 1 || this._absorbedProbes % 10 === 0) {
                    this._logger(`[MCP_BRIDGE] 🛑 Coalesce Gate: Handshake in-flight. Absorbing duplicate probe #${this._absorbedProbes} (Returning 204).`);
                }
                if (!res.headersSent) {
                    res.status(204).end();
                }
                return;
            }

            // Lock the gate before the async debounce
            this._isHandshaking = true;
            this._absorbedProbes = 0;

            const cleanupHandshake = () => {
                if (this._handshakeTimeout) {
                    clearTimeout(this._handshakeTimeout);
                    this._handshakeTimeout = null;
                }
                this._isHandshaking = false;
            };

            try {
                this._logger(`[MCP_BRIDGE] New SSE connection attempt from ${req.ip}`);
                
                this._handshakeTimeout = setTimeout(() => {
                    if (this._isHandshaking) {
                        this._logger(`[MCP_BRIDGE] ⏳ Handshake timeout (10s). Dropping gate safety.`);
                        cleanupHandshake();
                    }
                }, 10000); // Relaxed to 10s to match synthesis watchdog

                // [v2.4.6] DECOMMISSIONED: Aggressive eviction removed to support Multi-Instance sessions (Main + Dev Host).
                // Eviction is now handled exclusively by the 'close' event on the request.
            } catch (err) {
                this._logger(`[MCP_BRIDGE] Error during handshake setup: ${(err as any).message}`);
                cleanupHandshake();
                if (!res.headersSent) {
                    res.status(500).end();
                }
                return;
            }

            const server = this._createNewServer();
            this._server = server;
            this._transports = new Map(); // reset transport map for new session

            const transport = new SSEServerTransport("/messages", res);

            this._logger(`[MCP_BRIDGE] Connecting to Transport (Pending Handshake)...`);

            server.connect(transport).then(() => {
                cleanupHandshake();
                const sid = (transport as any).sessionId || (transport as any)._sessionId;
                if (sid) {
                    this._transports.set(sid, transport);
                    this._logger(`[MCP_BRIDGE] ✅ session_active: ${sid}`);

                    // Critical Handshake: Force immediate resource/tool sync after handshake
                    setTimeout(() => {
                        try {
                            server.sendResourceListChanged();
                            server.sendToolListChanged();
                            this._logger(`[MCP_BRIDGE] Post-Handshake Broadcast Complete`);
                        } catch (e) {}
                    }, 500);
                }
            }).catch(err => {
                this._logger(`[MCP_BRIDGE] ❌ Handshake FAILED: ${err.message}`);
                cleanupHandshake();
                this._server = null;
                try { transport.close(); } catch (e) {}
                if (!res.writableEnded) {
                    try { res.end(); } catch (e) {}
                }
            });

            req.on("close", () => {
                const sid = (transport as any).sessionId || (transport as any)._sessionId;
                if (sid) {
                    this._transports.delete(sid);
                }
                this._server = null;
                cleanupHandshake();
                try { transport.close(); } catch (e) {}
                this._logger(`[MCP_BRIDGE] session_closed`);
            });
        });

        // Message Endpoint Setup - MANUAL body parsing to prevent SDK collision
        this._app.post("/messages", express.json(), async (req, res) => {
            const sessionId = req.query.sessionId as string;
            this._logger(`[MCP_TRACE] POST /messages | session: ${sessionId} | method: ${req.body?.method}`);
            
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
            } else if (req.body?.method === 'tools/call' && req.body.params?.name === 'say_this_loud') {
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
                this._logger(`[MCP_BRIDGE] ERROR: session not found (${sessionId}). Active sessions: ${Array.from(this._transports.keys()).join(', ')}`);
                res.status(404).send(`Session  ${sessionId} not found.`);
            }
        });

        // Port Roaming Implementation
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const port = initialPort + attempt;
            try {
                await new Promise<void>((resolve, reject) => {
                    this._httpServer = this._app.listen(port, "127.0.0.1", () => {
                        this._logger(`[MCP_BRIDGE] Server listening on http://localhost:${port}/sse (PID ${process.pid})`);
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
                return port; // Successfully started
            } catch (err) {
                if (attempt === maxAttempts - 1) {
                    throw new Error(`[MCP_BRIDGE] Exhausted all ${maxAttempts} ports.`);
                }
            }
        }
        throw new Error("Failed to start server");
    }

    private writeDiscoveryInfo(port: number) {
        try {
            // [REMOVED] Legacy session-local discovery. 
            // We now rely exclusively on the Global Registry for multi-instance discovery.

            // Write Global Registry with Atomic Resilience
            const userHome = process.env.USERPROFILE || process.env.HOME || "";
            const globalDir = path.join(userHome, ".gemini", "antigravity", "read_aloud");
            if (!fs.existsSync(globalDir)) {
                fs.mkdirSync(globalDir, { recursive: true });
            }
            
            const registryFile = path.join(globalDir, "active_servers.json");
            const tempFile = registryFile + ".tmp";
            let registry: any[] = [];
            
            if (fs.existsSync(registryFile)) {
                try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf-8')); } catch (e) { registry = []; }
            }
            
            const info = {
                active_port: port,
                url: `http://localhost:${port}/sse`,
                timestamp: Date.now(),
                pid: process.pid,
                sessionId: path.basename(this._persistencePath),
                extensionMode: this._extensionMode === 2 ? "Development" : "Production",
                workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || "unknown",
                resources: [
                    { name: "native-logs", uri: "read-aloud://logs/native" },
                    { name: "debug-logs", uri: "read-aloud://logs/debug" }
                ]
            };
            
            // Cleanup stale entries (no longer running, same port, or same workspace collision)
            registry = registry.filter(entry => {
                    // Always remove self (we'll re-add current info) or same port
                    if (entry.pid === process.pid || entry.active_port === port) {
                        return false;
                    }
                    
                    // Filter by Workspace Collision - Only one bridge per workspace root
                    if (entry.workspaceRoot === info.workspaceRoot) {
                        this._logger(`[MCP_BRIDGE] Evicting stale bridge for workspace ${entry.workspaceRoot} (PID ${entry.pid})`);
                        return false;
                    }

                    // Check if PID is still alive
                    try {
                        process.kill(entry.pid, 0); 
                        return true;
                    } catch {
                        return false;
                    }
            });
            registry.push(info);
            
            fs.writeFileSync(tempFile, JSON.stringify(registry, null, 2));
            fs.renameSync(tempFile, registryFile);
            
            this._logger(`[MCP_BRIDGE] Global Registry atomically updated at ${registryFile}`);
        } catch (err) {
            this._logger(`[MCP_BRIDGE] ERROR: Could not write discovery info: ${err}`);
        }
    }

    public stop() {
        if (this._httpServer) {
            this._httpServer.close();
            // Cleanup Global Registry
            // [Atomic Teardown] Cleanup Global Registry using Rename Pattern
            try {
                const userHome = process.env.USERPROFILE || process.env.HOME || "";
                const registryFile = path.join(userHome, ".gemini", "antigravity", "read_aloud", "active_servers.json");
                const tempFile = registryFile + ".tmp";
                
                if (fs.existsSync(registryFile)) {
                    let registry = [];
                    try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf-8')); } catch (e) { registry = []; }
                    
                    const filtered = registry.filter((entry: any) => entry.pid !== process.pid);
                    
                    fs.writeFileSync(tempFile, JSON.stringify(filtered, null, 2));
                    fs.renameSync(tempFile, registryFile);
                    this._logger(`[MCP_BRIDGE] PID ${process.pid} removed atomically from registry.`);
                }
            } catch (e: any) {
                this._logger(`[MCP_BRIDGE] Teardown error: ${e.message || e}`);
            }
            
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
