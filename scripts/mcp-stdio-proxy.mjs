import fs from 'fs';
import path from 'path';
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import os from 'os';
import crypto from 'crypto';
import { execSync, spawn } from 'child_process';

/**
 * MCP Stdio Proxy for Read Aloud (Indestructible Gateway v3.1 - RAW RELAY)
 * Logic: Wait-on-Startup, Absolute JSON-RPC Relay, and High-Density Debugging.
 */

const LOG_FILE = 'c:\\Users\\Idan4\\Desktop\\readme-preview-read-aloud\\diagnostics.log';

// Backoff state for reconnect loop
let _reconnectAttempts = 0;

function logTraffic(direction, payload) {
    try {
        const timestamp = new Date().toISOString();
        if (payload?.method === 'notifications/initialized' || payload?.method === 'ping') { return; }
        const msg = payload !== undefined ? `[${direction}] ${JSON.stringify(payload)}` : direction;
        const entry = `[${timestamp}] ${msg}\n`;
        fs.appendFileSync(LOG_FILE, entry);
        // NOTE: Do NOT write to console.error here — the pipe may be broken after dev host teardown,
        // which causes an EPIPE that crashes the proxy via uncaughtException.
    } catch (_) {
        // Silently fail — we never crash on a log write failure.
    }
}


async function safeReadManifest(filePath) {
    for (let attempts = 0; attempts < 3; attempts++) {
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                if (content && content.trim()) {
                    return JSON.parse(content);
                }
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 50));
        }
    }
    return [];
}

async function main() {
    const userHome = process.env.USERPROFILE || process.env.HOME || "";
    const registryPath = path.join(userHome, ".gemini", "antigravity", "read_aloud", "active_servers.json");
    const currentDir = (process.env.READ_ALOUD_PROJECT_ROOT || process.cwd()).toLowerCase();
    const currentDirHash = crypto.createHash('md5').update(currentDir).digest('hex').substring(0, 8);
    const lockFile = path.join(os.tmpdir(), `read-aloud-proxy-${currentDirHash}.lock`);

    // [REMOVED] Destructive stealing protocol.
    // We now rely on Port Roaming in the bridge and multiple proxies can coexist if needed.
    fs.writeFileSync(lockFile, process.pid.toString());
    process.on('exit', () => { try { fs.unlinkSync(lockFile); } catch (e) {} });

    logTraffic(`[PROXY] Gateway Starting (PID: ${process.pid})`);

    let instance = null;
    let attempts = 0;
    const maxAttempts = 10;

    while (!instance && attempts < maxAttempts) {
        try {
            const registry = await safeReadManifest(registryPath);
            
            // [PRIORITIZATION] Filter for current workspace and sort by recency
            const validInstances = registry.filter(s => {
                const root = (s.workspaceRoot || "").toLowerCase();
                return currentDir.startsWith(root);
            }).sort((a, b) => b.timestamp - a.timestamp);

            // [DEV PRECEDENCE] Favor Development instance if it exists, otherwise use most recent Production
            instance = validInstances.find(s => s.extensionMode === "Development") 
                    || validInstances.find(s => s.extensionMode === "Production")
                    || (registry.length > 0 ? registry[registry.length - 1] : null);

        } catch (e) {
            logTraffic(`[PROXY] Registry error: ${e.message}`);
        }

        if (!instance) {
            logTraffic(`[PROXY] Waiting for bridge registration... (Attempt ${attempts + 1}/${maxAttempts})`);
            await new Promise(r => setTimeout(r, 2000));
            attempts++;
        }
    }

    if (!instance) {
        logTraffic("[PROXY] No active Read Aloud bridge found. Falling back to STANDALONE mode...");
        
        // Resolve path to mcp-standalone.js in the dist folder
        const scriptDir = path.dirname(new URL(import.meta.url).pathname);
        const projectRoot = path.join(scriptDir, '..');
        const standalonePath = path.join(projectRoot, 'dist', 'mcp-standalone.js');
        // Fix Windows path (remove leading slash if present from URL pathname)
        const normalizedPath = standalonePath.replace(/^\/([A-Z]:)/, '$1');

        if (!fs.existsSync(normalizedPath)) {
            logTraffic(`[PROXY] FATAL: Standalone fallback not found at ${normalizedPath}`);
            process.exit(1);
        }

        logTraffic(`[PROXY] Spawning standalone server: node ${normalizedPath}`);
        const child = spawn('node', [normalizedPath], {
            stdio: 'inherit',
            env: { ...process.env, READ_ALOUD_STANDALONE: 'true' }
        });
        
        child.on('exit', (code) => process.exit(code || 0));
        return; // Exit main, let the child handle stdio
    }

    logTraffic(`[PROXY] Bridging Stdio to SSE: ${instance.url}`);

    const server = new Server(
        { name: "read-aloud", version: "2.1.3" },
        { 
            capabilities: { 
                resources: { 
                    subscribe: true,
                    listChanged: true 
                }, 
                tools: {
                    listChanged: true
                }
            } 
        }
    );

    const serverTransport = new StdioServerTransport();

    let client = null;
    let clientTransport = null;

    const connectToBridge = async (url) => {
        logTraffic(`[PROXY] Connecting to bridge at ${url}...`);

        try {
            clientTransport = new SSEClientTransport(new URL(url));
            client = new Client(
                { name: "proxy-relay", version: "1.2.4" },
                { 
                    capabilities: { 
                        resources: { subscribe: true }, 
                        resourceTemplates: true, 
                        tools: {} 
                    } 
                }
            );

            clientTransport.onclose = () => {
                logTraffic("[PROXY] Bridge connection LOST. Initiating Re-Discovery...");
                _reconnectAttempts = 0; // reset backoff on a fresh loss
                setTimeout(reconnect, 5000 + Math.floor(Math.random() * 2000));
            };

            await client.connect(clientTransport);
            _reconnectAttempts = 0; // successful connect — reset backoff

            // [NOTIFICATION RELAY] Forward bridge notifications (e.g., list_changed) to the Agent
            client.onnotification = (notification) => {
                logTraffic(`[PROXY] Forwarding bridge notification: ${notification.method}`);
                server.notification(notification);
            };
            const transportSid = clientTransport.sessionId || clientTransport._sessionId;
            logTraffic(`[PROXY] Bridge Handshake: SUCCESS (Session: ${transportSid}, Proxy PID: ${process.pid})`);
        } catch (err) {
            // Exponential backoff with jitter: 5s → 10s → 20s → 40s → 60s (cap)
            _reconnectAttempts++;
            const base = Math.min(5000 * Math.pow(2, _reconnectAttempts - 1), 60000);
            const jitter = Math.floor(Math.random() * 3000);
            const delay = base + jitter;
            logTraffic(`[PROXY] Connection Error: ${err.message}. Retrying in ${Math.round(delay / 1000)}s (attempt ${_reconnectAttempts})...`);
            setTimeout(reconnect, delay);
        }
    };

    const reconnect = async () => {
        try {
            logTraffic("[PROXY] Re-Discovery Triggered...");
            const registry = await safeReadManifest(registryPath);
            
            const validInstances = registry.filter(s => {
                const root = (s.workspaceRoot || "").toLowerCase();
                return currentDir.startsWith(root);
            }).sort((a, b) => b.timestamp - a.timestamp);

            const nextInstance = validInstances.find(s => s.extensionMode === "Development") 
                    || validInstances.find(s => s.extensionMode === "Production")
                    || (registry.length > 0 ? registry[registry.length - 1] : null);

            if (nextInstance) {
                await connectToBridge(nextInstance.url);
            } else {
                // Registry empty — dev host likely just closed. Back off 30s before next probe.
                logTraffic("[PROXY] Re-Discovery failed. Host Registry Empty. Retrying in 30s...");
                setTimeout(reconnect, 30000);
            }
        } catch (e) {
            logTraffic(`[PROXY] Internal Reconnection Error: ${e.message}`);
            setTimeout(reconnect, 10000);
        }
    };

    // ── EPIPE guard ───────────────────────────────────────────────────────────
    // When the dev host tears down, the extension's stdout/stderr pipe breaks.
    // EPIPE on stdout/stderr is not a fatal error for a proxy — it means the
    // consumer is gone. We silence it rather than crashing.
    process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
    process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

    // Global Error Guard - Log everything to diagnostics.log (file only, no stderr)
    process.on("uncaughtException", (err) => {
        if (err.code === 'EPIPE') return; // EPIPE is always safe to ignore in a proxy
        logTraffic(`[PROXY_FATAL] Uncaught Exception: ${err.message}\n${err.stack}`);
        process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
        logTraffic(`[PROXY_FATAL] Unhandled Rejection: ${reason}`);
    });


    server.setRequestHandler(ListResourcesRequestSchema, async () => {
        logTraffic("[PROXY] request: listResources");
        if (!client) {
            logTraffic("[PROXY] listResources REJECTED - Client Offline");
            return { resources: [] };
        }
        try {
            const start = Date.now();
            const result = await client.listResources();
            const duration = Date.now() - start;

            // [STABILITY GUARD] Filter out un-interpolated templates (e.g. URI contains '{')
            // These cause 500 errors in the Agent Discovery engine.
            const absoluteResources = (result.resources || []).filter(r => {
                const isTemplate = r.uri.includes('{') || r.uri.includes('}');
                if (isTemplate) {
                    logTraffic(`[PROXY_GUARD] Dropping malformed template from Resource List: ${r.uri}`);
                }
                return !isTemplate;
            });

            logTraffic(`[PROXY] response: listResources (${absoluteResources.length} absolute items, ${result.resources?.length - absoluteResources.length} filtered) in ${duration}ms`);
            
            return {
                ...result,
                resources: absoluteResources
            };
        } catch (err) {
            logTraffic(`[PROXY] ERROR during listResources: ${err.message}`);
            return { resources: [] };
        }
    });


    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
        logTraffic("[PROXY] request: listResourceTemplates");
        if (!client) {
            return { resourceTemplates: [] };
        }
        const result = await client.listResourceTemplates();
        logTraffic(`[PROXY] response: listResourceTemplates (${result.resourceTemplates?.length || 0} items)`);
        return result;
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        logTraffic(`[PROXY] request: readResource (${request.params.uri})`);
        if (!client) {
            throw new Error("Bridge Offline");
        }
        const result = await client.readResource({ uri: request.params.uri });
        logTraffic(`[PROXY] response: readResource (Length: ${JSON.stringify(result).length})`);
        return result;
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        logTraffic("[PROXY] request: listTools");
        if (!client) {
            return { tools: [] };
        }
        const result = await client.listTools();
        logTraffic(`[PROXY] response: listTools (${result.tools?.length || 0} items)`);
        return result;
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        logTraffic(`[PROXY] request: callTool (${request.params.name})`);
        if (!client) {
            throw new Error("Bridge Offline");
        }
        return await client.callTool({
            name: request.params.name,
            arguments: request.params.arguments
        });
    });

    await connectToBridge(instance.url);
    await server.connect(serverTransport);
    logTraffic("[PROXY] Ready. Raw Relay Protocol ACTIVE.");

    const cleanup = () => {
        logTraffic("[PROXY] Shutting down cleanly...");
        process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
}

main().catch(err => {
    logTraffic(`[PROXY] Fatal Header: ${err.message}`);
    process.exit(1);
});
