import * as vscode from "vscode";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
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
export class PendingInjectionStore extends EventEmitter {
    private _injections: { timestamp: number, content: string, name: string, filePath?: string }[] = [];

    constructor(private readonly _basePath: string) {
        super();
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
        this.emit('injected', { content: finalContent, name, index });
        return { filePath, index };
    }

    public onInjected(callback: (data: { content: string, name: string, index: number }) => void) {
        this.on('injected', callback);
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
    private _activeServers = new Set<McpServer>();
    private static readonly SERVER_NAME = 'read-aloud';
    private static _instanceCounter = 0;

    constructor(
        private readonly _persistencePath: string, 
        private readonly _logger: (msg: string) => void,
        private readonly _nativeLogUri?: { fsPath: string },
        private readonly _debugLogPath?: string,
        private readonly _extensionMode: number = 1 // Default to Production
    ) {
        super();
        
        // [Self-Healing Protocol] DNS Parity Enforcement
        hydrateProtocols(this._logger);

        this._store = new PendingInjectionStore(this._persistencePath);
        
        // Setup Express
        this._app = express();
        this._app.use(cors());
        this._app.use(express.json());

        this._initializeServer();
    }

    /**
     * [Reconstruction Pattern] Teardown and rebuild the server instance.
     * Use this to force-refresh capabilities or recover from internal SDK stalls.
     */
    /**
     * [Broadcasting Protocol] Force-refresh all active server instances.
     * This ensures the "Mothership" (VS Code) sees discovery changes immediately.
     */
    public async reinitialize() {
        this._logger(`[MCP_BRIDGE] Hub Re-Sync Initiated...`);
        this._notifyAll(server => {
            try {
                server.sendResourceListChanged();
                server.sendToolListChanged();
                server.sendPromptListChanged();
            } catch (e) {}
        });
        this._logger(`[MCP_BRIDGE] Hub Re-Sync Complete.`);
    }

    private _initializeServer() {
        this._logger(`[MCP_BRIDGE] Initializing Service Registry (Multi-Instance Hub)`);
        
        // Listen to store changes to broadcast resource refreshes across all active instances
        this._store.onInjected(() => {
            this._notifyAll(server => {
                try { server.sendResourceListChanged(); } catch (e) {}
            });
        });
    }

    private _createNewServer(): McpServer {
        const instanceId = ++McpBridge._instanceCounter;
        this._logger(`[MCP_BRIDGE] Spawning New Server Instance (ID: ${instanceId})`);
        
        const server = new McpServer({
            name: McpBridge.SERVER_NAME,
            version: "2.1.3"
        }, {
            capabilities: {
                resources: { subscribe: true },
                tools: {}
            }
        });

        // Track the ID in the server metadata for diagnostics
        (server as any)._readAloudInstanceId = instanceId;

        this._registerCapabilitiesTo(server);
        this._registerResourcesTo(server);

        return server;
    }

    private _registerCapabilitiesTo(server: McpServer) {
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
            "self_diagnostic",
            {},
            async () => {
                this._logger(`[MCP_BRIDGE] Internal Diagnostic Request received.`);
                const resources = [
                    { name: "native-logs", uri: "read-aloud://logs/native" },
                    { name: "debug-logs", uri: "read-aloud://logs/debug" },
                    { name: "protocols", uri: "read-aloud://protocols/{protocol}" }
                ];
                
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            status: "HEALTHY",
                            engine: "McpServer v1.2.1",
                            handshake: "STATIC_FIRST",
                            pid: process.pid,
                            persistence: this._persistencePath,
                            registered_resources: resources,
                            timestamp: new Date().toISOString()
                        }, null, 2)
                    }]
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

        server.prompt(
            "read_aloud_boot",
            {},
            async () => {
                const instructions = `
# Read Aloud Protocols: Master Boot
You are the **Antigravity Performance Orchestrator**. Your mission is to maintain high-integrity behavioral parity between your internal logic and the user's visual dashboard.

### Initialization Sequence:
1. **Discover**: Read the system entry point at \`read-aloud://protocols/manifest\`.
2. **Synchronize**: Check your current turn status via \`read-aloud://session/{sessionId}/state\`.
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
                const safeSessionId = PathGuard.sanitize(sessionId, 'SessionID');
                const stateFile = path.join(this._persistencePath, safeSessionId, 'extension_state.json');
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

Refer to \`read-aloud://protocols/orchestrator\` for the exact execution sequence. 
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
    }

    private _registerResourcesTo(server: McpServer) {
        this._logger(`[MCP_BRIDGE] Registering Native Resources...`);

        // [1] Resource: Native Logs
        server.resource(
            "native-logs",
            "read-aloud://logs/native",
            {
                description: "Real-time diagnostic stream from the VS Code Output Channel. Trace internal extension behavior.",
                mimeType: "text/plain"
            },
            async (uri) => {
                this._logger(`[MCP_BRIDGE] Resource Request: ${uri.href}`);
                let content = "--- [READ ALOUD NATIVE LOGS START] ---\n";
                if (this._nativeLogUri && fs.existsSync(this._nativeLogUri.fsPath)) {
                    content += fs.readFileSync(this._nativeLogUri.fsPath, 'utf8');
                } else {
                    content += "Log output channel not yet initialized or session is idle.";
                }
                return { contents: [{ uri: uri.href, mimeType: "text/plain", text: content }] };
            }
        );

        // [2] Resource: Debug Logs
        server.resource(
            "debug-logs",
            "read-aloud://logs/debug",
            {
                description: "Internal extension logs containing bridge events and lifecycle diagnostics.",
                mimeType: "text/plain"
            },
            async (uri) => {
                let content = "--- [EXTENSION DEBUG LOGS START] ---\n";
                if (this._debugLogPath && fs.existsSync(this._debugLogPath)) {
                    content += fs.readFileSync(this._debugLogPath, 'utf8');
                } else {
                    content += "No diagnostic logs found.";
                }
                return { contents: [{ uri: uri.href, mimeType: "text/plain", text: content }] };
            }
        );

        // [3] Resource: Session State (Dynamic Template)
        const stateTemplate = new ResourceTemplate("read-aloud://session/{sessionId}/state", { 
            list: async () => {
                const rootDir = path.dirname(this._persistencePath);
                if (!fs.existsSync(rootDir)) { return { resources: [] }; }
                
                // [PRUNING] Sort by mtime and take the 10 most recent sessions to avoid discovery bloat
                const sessions = fs.readdirSync(rootDir)
                    .map(name => ({ name, stat: fs.lstatSync(path.join(rootDir, name)) }))
                    .filter(s => s.stat.isDirectory())
                    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
                    .slice(0, 10)
                    .map(s => s.name);

                return {
                    resources: sessions.map(s => ({
                        uri: `read-aloud://session/${s}/state`,
                        name: `State: ${s}`,
                        mimeType: "application/json"
                    }))
                };
            }
        });

        server.resource(
            "session-state",
            stateTemplate,
            async (uri, { sessionId }) => {
                const content = await this.getSessionStateContent(String(sessionId));
                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: "application/json",
                        text: content
                    }]
                };
            }
        );

        // [4] Resource: Protocols
        const protocolTemplate = new ResourceTemplate("read-aloud://protocols/{protocol}", { 
            list: async () => {
                const userHome = process.env.USERPROFILE || process.env.HOME || "";
                const globalProtocolsDir = path.join(userHome, ".gemini", "antigravity", "read_aloud", "protocols");
                if (!fs.existsSync(globalProtocolsDir)) { return { resources: [] }; }
                const files = fs.readdirSync(globalProtocolsDir).filter(f => f.endsWith('.md'));
                return {
                    resources: files.map(f => ({
                        uri: `read-aloud://protocols/${path.basename(f, '.md')}`,
                        name: `Protocol: ${path.basename(f, '.md')}`,
                        mimeType: "text/markdown"
                    }))
                };
            }
        });

        server.resource(
            "protocols",
            protocolTemplate,
            async (uri, { protocol }) => {
                const safeProtocol = PathGuard.sanitize(String(protocol), 'Protocol');
                const userHome = process.env.USERPROFILE || process.env.HOME || "";
                const globalProtocolsDir = path.join(userHome, ".gemini", "antigravity", "read_aloud", "protocols");
                const protocolPath = path.join(globalProtocolsDir, `${safeProtocol}.md`);
                
                if (!fs.existsSync(protocolPath)) {
                    throw new Error(`[MCP_RESOURCE] Protocol '${safeProtocol}' not found.`);
                }

                const content = fs.readFileSync(protocolPath, 'utf8');
                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: "text/markdown",
                        text: content
                    }]
                };
            }
        );

        // [5] Resource: Injected Snippets (Multi-Session Discovery)
        const snippetTemplate = new ResourceTemplate("read-aloud://snippets/{sessionId}/{snippetName}", {
            list: async () => {
                const results: any[] = [];
                if (!fs.existsSync(this._persistencePath)) { return { resources: [] }; }
                
                // [PRUNING] Limit snippet discovery to the 10 most recent sessions
                const sessions = fs.readdirSync(this._persistencePath)
                    .map(name => ({ name, stat: fs.lstatSync(path.join(this._persistencePath, name)) }))
                    .filter(s => s.stat.isDirectory())
                    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
                    .slice(0, 10)
                    .map(s => s.name);

                for (const session of sessions) {
                    const sessionDir = path.join(this._persistencePath, session);
                    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.md'));
                    for (const file of files) {
                        results.push({
                            uri: `read-aloud://snippets/${session}/${path.basename(file, '.md')}`,
                            name: `Snippet: ${session}/${path.basename(file, '.md')}`,
                            mimeType: "text/markdown"
                        });
                    }
                }
                return { resources: results };
            }
        });

        server.resource(
            "injected-snippets",
            snippetTemplate,
            async (uri, { sessionId, snippetName }) => {
                const safeSession = PathGuard.sanitize(String(sessionId), 'SessionID');
                const safeSnippet = PathGuard.sanitize(String(snippetName), 'Snippet');
                const sessionDir = path.join(this._persistencePath, safeSession);
                const filePath = path.join(sessionDir, `${safeSnippet}.md`);
                
                if (!fs.existsSync(filePath)) {
                    throw new Error(`[MCP_RESOURCE] Snippet '${safeSnippet}' not found in session '${safeSession}'.`);
                }

                const content = fs.readFileSync(filePath, 'utf8');
                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: "text/markdown",
                        text: content
                    }]
                };
            }
        );

        // Force capability discovery
        try {
            server.sendResourceListChanged();
            server.sendToolListChanged();
        } catch (e) {
            this._logger(`[MCP_BRIDGE] Initial instance sync completed.`);
        }
    }

    /**
     * Broadcasts a notification to all active MCP server instances.
     */
    private _notifyAll(callback: (server: McpServer) => void) {
        this._activeServers.forEach(server => {
            try {
                callback(server);
            } catch (err) {
                this._logger(`[MCP_BRIDGE] Broadcast Error: ${err}`);
            }
        });
    }

    /**
     * Internal method to retrieve log content for both native and debug streams.
     * Exposed as public for high-integrity unit testing and Chat UI integration.
     */
    public async getLogContent(type: 'native' | 'debug'): Promise<string> {
        const pid = process.pid;
        if (type === 'native') {
            const header = `--- [READ ALOUD NATIVE LOGS | PID: ${pid} | START] ---\n`;
            if (!this._nativeLogUri) {
                return header + "Native log URI not initialized or LogOutputChannel not supported by the environment.";
            }
            if (!fs.existsSync(this._nativeLogUri.fsPath)) {
                return header + `Native log file not found at ${this._nativeLogUri.fsPath}`;
            }
            return header + fs.readFileSync(this._nativeLogUri.fsPath, 'utf8');
        } else {
            if (!this._debugLogPath || !fs.existsSync(this._debugLogPath)) {
                return `--- [READ ALOUD DEBUG LOGS | PID: ${pid} | START] ---\nDebug log file not found at project root. Verify that 'diagnostics.log' exists.`;
            }
            const header = `--- [READ ALOUD DEBUG LOGS | PID: ${pid} | PATH: ${this._debugLogPath} | START] ---\n`;
            return header + fs.readFileSync(this._debugLogPath, 'utf8');
        }
    }

    /**
     * Retrieves the current session state for diagnostic reporting.
     */
    public async getSessionStateContent(sessionId: string): Promise<string> {
        const sessionDir = path.join(this._persistencePath, sessionId);
        const statePath = path.join(sessionDir, "state.json");
        let state: any = { status: "NEW", sessionId };
        
        if (fs.existsSync(statePath)) {
            try {
                state = { ...state, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) };
            } catch (e) {}
        }
        return JSON.stringify(state, null, 2);
    }

    /**
     * Start the server with Port Roaming capability.
     * Tries starting at initialPort and increments up to maxAttempts.
     * Supports READ_ALOUD_MCP_PORT env override for exclusive debug sessions.
     */
    public async start(initialPort: number = 7413, maxAttempts: number = 8) {
        const envPort = process.env.READ_ALOUD_MCP_PORT ? parseInt(process.env.READ_ALOUD_MCP_PORT, 10) : undefined;
        if (envPort && !isNaN(envPort)) {
            this._logger(`[MCP_BRIDGE] Debug Override: Locking to port ${envPort}`);
            initialPort = envPort;
            maxAttempts = 1; // Failure is terminal if exclusive port is requested
        }
        
        // CORS must be available for all routes, but JSON is ONLY for our own custom POSTs
        this._app.use(cors());

        this._app.get("/health", (req, res) => {
            res.json({ status: "ok", mcp: "read-aloud", version: "1.2.1" });
        });

        this._app.get("/sse", async (req, res) => {
            this._logger(`[MCP_BRIDGE] New SSE connection attempt from ${req.ip}`);
            
            const MAX_SESSION_TIMEOUT_MS = 60000; // 1 minute stale check
            
            // SELF-HEALING: If an active session exists, check if it's "zombie" (stale) or explicitly evict if it's from the same source
            if (this._activeServers.size > 0) {
                this._logger(`[MCP_BRIDGE] Conflict: Active session already exists. Evicting old session to allow re-handshake.`);
                for (const oldServer of this._activeServers) {
                    this._logger(`[MCP_BRIDGE] Force-purging stale session ID: ${(oldServer as any)._readAloudInstanceId}`);
                    this._activeServers.delete(oldServer);
                }
            }

            const server = this._createNewServer();
            const instanceId = (server as any)._readAloudInstanceId;
            this._activeServers.add(server);
            
            const transport = new SSEServerTransport("/messages", res);
            
            this._logger(`[MCP_BRIDGE] Connecting Instance ${instanceId} to Transport (Pending Handshake)...`);
            
            server.connect(transport).then(() => {
                const sid = (transport as any).sessionId || (transport as any)._sessionId;
                if (sid) {
                    this._transports.set(sid, transport);
                    this._logger(`[MCP_BRIDGE] session_active: ${sid} (Instance: ${instanceId}, Total: ${this._activeServers.size})`);
                    
                    // Critical Handshake: Force immediate resource/tool sync after handshake
                    setTimeout(() => {
                        try {
                            server.sendResourceListChanged();
                            server.sendToolListChanged();
                            this._logger(`[MCP_BRIDGE] Post-Handshake Broadcast Complete (Instance: ${instanceId})`);
                        } catch (e) {}
                    }, 500);
                }
            }).catch(err => {
                this._logger(`[MCP_BRIDGE] CONNECTION_ERROR (Instance ${instanceId}): ${err.message}`);
                this._activeServers.delete(server);
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
                this._activeServers.delete(server);
                try { transport.close(); } catch (e) {}
                this._logger(`[MCP_BRIDGE] session_closed (Instance: ${instanceId}, Remaining: ${this._activeServers.size})`);
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
                this._logger(`[MCP_BRIDGE] ERROR: session not found (${sessionId}). Active sessions: ${Array.from(this._transports.keys()).join(', ')}`);
                res.status(404).send(`Session  ${sessionId} not found.`);
            }
        });

        // Port Roaming Implementation
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const port = initialPort + attempt;
            try {
                await new Promise<void>((resolve, reject) => {
                    this._httpServer = this._app.listen(port, "localhost", () => {
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
            // Write session-local discovery (legacy support)
            const discoveryFile = path.join(this._persistencePath, "mcp_discovery.json");
            const info = {
                active_port: port,
                url: `http://localhost:${port}/sse`,
                timestamp: Date.now(),
                pid: process.pid,
                sessionId: path.basename(this._persistencePath),
                extensionMode: this._extensionMode === 2 ? "Development" : "Production",
                workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || "unknown",
                // Shadow Manifest: Direct discovery of resources without SDK handshake
                resources: [
                    { name: "native-logs", uri: "read-aloud://logs/native" },
                    { name: "debug-logs", uri: "read-aloud://logs/debug" }
                ]

            };
            fs.writeFileSync(discoveryFile, JSON.stringify(info, null, 2));

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
            
            // Cleanup stale entries (no longer running or same port)
            registry = registry.filter(entry => entry.pid !== process.pid && entry.active_port !== port);
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
