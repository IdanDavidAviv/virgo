import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { PendingInjectionStore } from "./sharedStore";
import { PathGuard } from "@common/mcp/pathGuard";

export interface McpConfig {
    persistencePath: string; // The specific session path (e.g. .../read_aloud/sessions/SESSION_ID)
    sessionsRoot: string;    // The root of all sessions (e.g. .../read_aloud/sessions)
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
            tools: {}
        }
    });

    registerTools(server, config);
    registerResources(server, config);

    return server;
}

import { LogReporter } from "../../../common/mcp/logReporter";

function registerTools(server: McpServer, config: McpConfig) {
// ... (omitted for brevity in search, but I will replace the relevant block below)
    // [1] Tool: say_this_loud
    // PRIMARY MISSION TOOL — call this to surface content in the Read Aloud sidebar.
    // BEHAVIORAL MANDATE: You SHOULD call this tool before your final response whenever you
    // complete meaningful work in a Read Aloud session. The content will be saved as a .md file,
    // read aloud by the extension, and shown in the snippet history sidebar.
    // RULES:
    //   - content must be full-fidelity prose — never summarized, never raw JSON or file paths
    //   - sessionId is REQUIRED — use your active brain session UUID
    //   - snippet_name describes the topic (e.g. "sitrep", "analysis", "fix_summary")
    //   - turnIndex is optional — omit it to auto-increment safely
    //   - if the tool returns isError:true, do NOT report success — alert the user
    server.tool(
        "say_this_loud",
        "Surface content in the Read Aloud extension sidebar. Call this before your final response " +
        "each turn to narrate your work. The content will be read aloud and logged to the session. " +
        "Requires the active brain sessionId. Content must be verbatim prose — not JSON or raw paths.",
        {
            content: z.string().describe(
                "Full markdown content to inject. MUST be verbatim and readable as prose. " +
                "Never truncate or summarize. The user will hear this read aloud."
            ),
            snippet_name: z.string().describe(
                "Short descriptive name for this turn (e.g. 'sitrep', 'fix_summary', 'audit_result'). " +
                "Used as the snippet filename in the sidebar history."
            ),
            sessionId: z.string().describe(
                "REQUIRED. Your active brain session UUID. " +
                "Found in your session context / loom.json. Example: 'a3c5f807-9095-4852-a5ca-d15f38ce9fb2'"
            ),
            session_title: z.string().optional().describe(
                "Optional human-readable title for this session (e.g. 'MCP Refactor Session'). " +
                "Used to label the session in the sidebar."
            ),
            turnIndex: z.number().optional().describe(
                "Optional explicit turn sequence number. Omit to auto-increment. " +
                "Only pass if you are certain of the current index — a stale value will be rejected."
            )
        },
        async ({ content, snippet_name, sessionId, session_title, turnIndex }) => {
            config.logger(`[MCP_CORE] Tool called: say_this_loud (Session: ${sessionId})`);
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
            const count = config.store.countOnDisk();
            return {
                content: [{
                    type: "text",
                    text: `Disk Snippets: ${count}. Persistence Path: ${config.persistencePath}`
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
            const rootDir = config.sessionsRoot;
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
            const statePath = path.join(config.sessionsRoot, safeId, 'extension_state.json');
            
            if (!fs.existsSync(statePath)) {
                return { contents: [{ uri: uri.href, mimeType: "application/json", text: "{}" }] };
            }
            
            const content = fs.readFileSync(statePath, 'utf8');
            return { contents: [{ uri: uri.href, mimeType: "application/json", text: content }] };
        }
    );


    // [5] Resource: Injected Snippets (Multi-Session Discovery)
    const snippetTemplate = new ResourceTemplate("read-aloud://snippets/{sessionId}/{snippetName}", {
        list: async () => {
            const results: any[] = [];
            if (!fs.existsSync(config.sessionsRoot)) { return { resources: [] }; }
            
            // Limit snippet discovery to the 10 most recent sessions
            const sessions = fs.readdirSync(config.sessionsRoot)
                .map(name => ({ name, stat: fs.lstatSync(path.join(config.sessionsRoot, name)) }))
                .filter(s => s.stat.isDirectory())
                .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
                .slice(0, 10)
                .map(s => s.name);

            for (const session of sessions) {
                const sessionDir = path.join(config.sessionsRoot, session);
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
            const sessionDir = path.join(config.sessionsRoot, safeSession);
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

