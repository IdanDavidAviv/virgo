import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';

import { McpBridge } from '../../src/extension/mcp/mcpBridge';
import { PendingInjectionStore } from '../../src/extension/mcp/core/sharedStore';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

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

    describe('McpBridge Integration (SSE + Tools)', () => {
        it('should allow tool discovery and execution over SSE', async () => {
            const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${activePort}/sse`));
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
            // Allow Gate 2 handshake lock to clear via SSE req.on('close')
            await new Promise(r => setTimeout(r, 100));
        }, 30000); // Higher timeout for CI/Windows throughput (v2.2.2 stabilization)

        it.skip('should absorb duplicate concurrent SSE probes via Gate 2', async () => {
            // [Gate 2] Validation: When a second SSE connection is attempted while
            // the handshake of the first is still in-flight, the bridge must absorb
            // the duplicate probe (HTTP 429) and keep the first session alive.
            const t1 = new SSEClientTransport(new URL(`http://127.0.0.1:${activePort}/sse`));
            const c1 = new Client({ name: "cli-primary", version: "1" }, { capabilities: {} });

            // 1. Start primary connection handshake (non-blocking)
            const connectPromise = c1.connect(t1);

            // Wait for Gate 3 storm debounce (100ms) + margin to ensure _isHandshaking = true
            await new Promise(r => setTimeout(r, 200));

            // 2. A second simultaneous probe should be absorbed by Gate 3 (204 No Content)
            // while the first handshake is still in-flight (_isHandshaking = true)
            const probeResponse = await fetch(`http://127.0.0.1:${activePort}/sse`);
            expect(probeResponse.status).toBe(204);

            // 3. Complete primary handshake
            await connectPromise;

            // Verify primary session is fully functional
            const r1 = await c1.callTool({ name: 'get_injection_status', arguments: {} }) as any;
            expect(r1.isError).toBeFalsy();
            expect(r1.content[0].text).toBeTruthy();

            await t1.close();
        }, 30000);
    });
});
