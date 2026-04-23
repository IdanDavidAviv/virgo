import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { PendingInjectionStore } from "./core/sharedStore";
import { createReadAloudMcpServer } from "./core/mcpFactory";

export class McpBridge extends EventEmitter {
    private _app: express.Application;
    private _store: PendingInjectionStore;
    private _httpServer: any = null;
    // [T-021] StreamableHTTP: stateless transport, one instance shared across all requests.
    // No session map needed — each POST to /mcp is self-contained.
    private _transport: StreamableHTTPServerTransport | null = null;
    private _server: McpServer | null = null;
    private static readonly SERVER_NAME = 'read-aloud';

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

    private _createServer(): McpServer {
        this._logger(`[MCP_BRIDGE] Initializing MCP Server (StreamableHTTP/stateless)`);
        
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
        
        // CORS for all routes
        this._app.use(cors());

        this._app.get("/health", (req, res) => {
            res.json({ status: "ok", mcp: "read-aloud", version: this._version });
        });

        // [T-021] Single /mcp endpoint — StreamableHTTP stateful mode.
        // Stateful: SDK manages sessions internally. MCP handshake works correctly
        // (initialize → notifications/initialized → tools/call all linked by session ID).
        // Results arrive in the POST response body — no SSE stream, no 60s hang.
        this._server = this._createServer();
        this._transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
        await this._server.connect(this._transport);
        this._logger(`[MCP_BRIDGE] ✅ StreamableHTTP transport connected (stateful, SDK-managed sessions).`);

        this._app.all("/mcp", express.json(), async (req, res) => {
            this._logger(`[MCP_TRACE] ${req.method} /mcp | method: ${req.body?.method ?? 'n/a'}`);
            try {
                await this._transport!.handleRequest(req as any, res as any, req.body);
            } catch (err: any) {
                this._logger(`[MCP_BRIDGE] /mcp handler error: ${err.message}`);
                if (!res.headersSent) {
                    res.status(500).send(err.message);
                }
            }
        });

        // Port Roaming Implementation
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const port = initialPort + attempt;
            try {
                await new Promise<void>((resolve, reject) => {
                    this._httpServer = this._app.listen(port, "127.0.0.1", () => {
                        this._logger(`[MCP_BRIDGE] Server listening on http://localhost:${port}/mcp (PID ${process.pid})`);  
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
                url: `http://localhost:${port}/mcp`,
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
