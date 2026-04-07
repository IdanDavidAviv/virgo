import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { PendingInjectionStore } from "./sharedStore";
import { PathGuard } from "@common/mcp/pathGuard";
import { hydrateProtocols } from "@common/protocolHydrator";

export interface McpConfig {
    persistencePath: string; // The specific session path (e.g. .../read_aloud/SESSION_ID)
    brainRoot: string;       // The root of all sessions (e.g. .../read_aloud)
    logger: (msg: string) => void;
    nativeLogUri?: { fsPath: string };
    debugLogPath?: string;
    store: PendingInjectionStore;
    version: string;
}

/**
 * Unified factory for the Read Aloud MCP Server.
 * Ensures parity between SEE (Bridge) and Stdio (Standalone) transports.
 */
export function createReadAloudMcpServer(config: McpConfig): McpServer {
    const server = new McpServer({
        name: "read-aloud",
        version: config.version
    }, {
        capabilities: {
            resources: { subscribe: true },
            tools: {},
            prompts: {}
        }
    });

    registerTools(server, config);
    registerResources(server, config);
    registerPrompts(server, config);

    // Ensure protocols are hydrated for any consumer
    hydrateProtocols(config.logger);

    return server;
}

import { LogReporter } from "../../../common/mcp/logReporter";

function registerTools(server: McpServer, config: McpConfig) {
// ... (omitted for brevity in search, but I will replace the relevant block below)
    // [1] Tool: inject_markdown
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
            config.logger(`[MCP_CORE] Tool called: inject_markdown (Session: ${sessionId})`);
            try {
                const { filePath, index } = config.store.save(content, snippet_name, sessionId, session_title, turnIndex);
                return {
                    content: [{ 
                        type: "text", 
                        text: `Injected Turn ${index} into session ${sessionId} successfully at ${filePath}.` 
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

    // [2] Tool: self_diagnostic
    server.tool(
        "self_diagnostic",
        {},
        async () => {
            config.logger(`[MCP_CORE] Internal Diagnostic Request received.`);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        status: "HEALTHY",
                        pid: process.pid,
                        persistence: config.persistencePath,
                        timestamp: new Date().toISOString(),
                        version: config.version
                    }, null, 2)
                }]
            };
        }
    );

    // [3] Tool: get_injection_status
    server.tool(
        "get_injection_status",
        {},
        async () => {
            const all = config.store.getAll();
            return {
                content: [{
                    type: "text",
                    text: `Active Store Size: ${all.length} snippets. Persistence Path: ${config.persistencePath}`
                }]
            };
        }
    );
}

function registerResources(server: McpServer, config: McpConfig) {
    // [1] Resource: Native Logs
    server.resource(
        "native-logs",
        "read-aloud://logs/native",
        {
            description: "Real-time diagnostic stream from the VS Code Output Channel.",
            mimeType: "text/plain"
        },
        async (uri) => {
            const text = LogReporter.build('native', { nativeLogUri: config.nativeLogUri });
            return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
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
            const text = LogReporter.build('debug', { debugLogPath: config.debugLogPath });
            return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
        }
    );

    // [3] Resource: Session State (Dynamic Template)
    const stateTemplate = new ResourceTemplate("read-aloud://session/{sessionId}/state", { 
        list: async () => {
            const rootDir = config.brainRoot;
            if (!fs.existsSync(rootDir)) { return { resources: [] }; }
            
            const sessions = fs.readdirSync(rootDir)
                .map(name => ({ name, stat: fs.lstatSync(path.join(rootDir, name)) }))
                .filter(s => s.stat.isDirectory())
                .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
                .slice(0, 10)
                .map(s => ({
                    uri: `read-aloud://session/${s.name}/state`,
                    name: `Session State: ${s.name}`,
                    description: `Metadata and turn index for session ${s.name}`
                }));

            return { resources: sessions };
        }
    });

    server.resource(
        "session-state",
        stateTemplate,
        async (uri, vars) => {
            const { sessionId } = vars;
            if (!sessionId) {
                throw new Error(`[MCP] Missing sessionId in resource URI: ${uri.href}`);
            }

            const safeId = PathGuard.sanitize(String(sessionId), 'SessionID');
            const statePath = path.join(config.brainRoot, safeId, 'extension_state.json');
            
            if (!fs.existsSync(statePath)) {
                return { contents: [{ uri: uri.href, mimeType: "application/json", text: "{}" }] };
            }
            
            const content = fs.readFileSync(statePath, 'utf8');
            return { contents: [{ uri: uri.href, mimeType: "application/json", text: content }] };
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
        async (uri, vars) => {
            const { protocol } = vars;
            if (!protocol) {
                throw new Error(`[MCP] Missing protocol in resource URI: ${uri.href}`);
            }
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
            if (!fs.existsSync(config.brainRoot)) { return { resources: [] }; }
            
            // Limit snippet discovery to the 10 most recent sessions
            const sessions = fs.readdirSync(config.brainRoot)
                .map(name => ({ name, stat: fs.lstatSync(path.join(config.brainRoot, name)) }))
                .filter(s => s.stat.isDirectory())
                .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
                .slice(0, 10)
                .map(s => s.name);

            for (const session of sessions) {
                const sessionDir = path.join(config.brainRoot, session);
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
            const sessionDir = path.join(config.brainRoot, safeSession);
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
}

function registerPrompts(server: McpServer, config: McpConfig) {
    server.prompt(
        "read_aloud_boot",
        {},
        async () => ({
            messages: [{
                role: "user",
                content: { type: "text", text: "You are the Antigravity Performance Orchestrator. Maintain parity with the dashboard." }
            }]
        })
    );
}
