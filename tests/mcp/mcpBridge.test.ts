import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';

import { McpBridge } from '../../src/extension/mcp/mcpBridge';
import { PendingInjectionStore } from '../../src/extension/mcp/core/sharedStore';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Mock vscode
vi.mock('vscode', () => ({
    ExtensionMode: {
        Production: 1,
        Development: 2,
        Test: 3
    },
    workspace: {
        workspaceFolders: []
    }
}));

// Use a distinct port for testing to avoid collisions with the dev environment
const TEST_PORT = 7414;

describe('McpBridge Tests', () => {
    let bridge: McpBridge;
    const logger = vi.fn((msg) => console.log(msg));
    const testPersistencePath = './tests/mcp/test_storage';

    beforeEach(() => {
        if (fs.existsSync(testPersistencePath)) {
            fs.rmSync(testPersistencePath, { recursive: true, force: true });
        }
        fs.mkdirSync(testPersistencePath, { recursive: true });
    });

    let activePort: number;

    beforeAll(async () => {
        bridge = new McpBridge(testPersistencePath, logger);
        activePort = await bridge.start(TEST_PORT);
    });

    afterAll(async () => {
        await bridge.stop();
    });

    describe('PendingInjectionStore (Unit)', () => {
        it('should save injections and increment index', () => {
            const store = new PendingInjectionStore(testPersistencePath);
            const { index: idx1 } = store.save('# First', 'first_snippet', 'test_session');
            const { index: idx2 } = store.save('# Second', 'second_snippet', 'test_session');

            expect(idx1).toBe(1);
            expect(idx2).toBe(2);
            expect(store.countOnDisk()).toBeGreaterThanOrEqual(2);
        });

        it('should report snippet count from disk', () => {
            const store = new PendingInjectionStore(testPersistencePath);
            store.save('tmp', 'count_test', 'test_session');
            expect(store.countOnDisk()).toBeGreaterThanOrEqual(1);
        });
    });

    describe('McpBridge Integration (StreamableHTTP + Tools)', () => {
        it('should allow tool discovery and execution over StreamableHTTP', async () => {
            // [T-021] Bridge now uses StreamableHTTP (stateless). No SSE, no session IDs.
            const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${activePort}/mcp`));
            const client = new Client(
                { name: "test-runner", version: "1.0.0" },
                { capabilities: {} }
            );

            await client.connect(transport);

            // 1. Discover Tools
            const tools = await client.listTools();
            const names = tools.tools.map(t => t.name);
            expect(names).toContain('say_this_loud');
            expect(names).toContain('get_injection_status');

            // 2. Inject Markdown
            const injectResult = await client.callTool({
                name: 'say_this_loud',
                arguments: {
                    content: '## Injected via Test',
                    snippet_name: 'integration_test',
                    sessionId: 'test_session'
                }
            }) as any;

            expect(injectResult.isError).toBeFalsy();
            expect(injectResult.content[0].type).toBe('text');
            expect(injectResult.content[0].text.toLowerCase()).toContain('successfully');

            // 3. Verify Status
            const statusResult = await client.callTool({
                name: 'get_injection_status',
                arguments: {}
            }) as any;

            expect(statusResult.isError).toBeFalsy();
            expect(statusResult.content[0].text).toContain('Disk Snippets:');

            await transport.close();
        }, 30000);
    });
});
