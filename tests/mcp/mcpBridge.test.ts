import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { McpBridge, PendingInjectionStore } from '../../src/extension/mcp/mcpBridge';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// Use a distinct port for testing to avoid collisions with the dev environment
const TEST_PORT = 7414;

describe('McpBridge Tests', () => {
    let bridge: McpBridge;
    const logger = vi.fn((msg) => console.log(msg));
    const testPersistencePath = './tests/mcp/test_storage';

    beforeAll(async () => {
        bridge = new McpBridge(testPersistencePath, logger);
        await bridge.start(TEST_PORT);
    });

    afterAll(async () => {
        await bridge.stop();
    });

    describe('PendingInjectionStore (Unit)', () => {
        it('should add injections and increment index', () => {
            const store = new PendingInjectionStore(testPersistencePath);
            const idx1 = store.add('# First', 'first_snippet');
            const idx2 = store.add('# Second', 'second_snippet');

            expect(idx1).toBe(0);
            expect(idx2).toBe(1);
            expect(store.getAll()).toHaveLength(2);
            expect(store.getAll()[0].name).toBe('first_snippet');
        });

        it('should clear all injections', () => {
            const store = new PendingInjectionStore(testPersistencePath);
            store.add('tmp', 'clear_test');
            store.clear();
            expect(store.getAll()).toHaveLength(0);
        });
    });

    describe('McpBridge Integration (SSE + Tools)', () => {
        it('should allow tool discovery and execution over SSE', async () => {
            const transport = new SSEClientTransport(new URL(`http://localhost:${TEST_PORT}/sse`));
            const client = new Client(
                { name: "test-runner", version: "1.0.0" },
                { capabilities: {} }
            );

            await client.connect(transport);

            // 1. Discover Tools
            const tools = await client.listTools();
            const names = tools.tools.map(t => t.name);
            expect(names).toContain('inject_markdown');
            expect(names).toContain('get_injection_status');

            // 2. Inject Markdown
            const injectResult = await client.callTool({
                name: 'inject_markdown',
                arguments: {
                    content: '## Injected via Test',
                    snippet_name: 'integration_test'
                }
            }) as any;
            
            expect(injectResult.isError).toBeFalsy();
            expect(injectResult.content[0].type).toBe('text');
            expect(injectResult.content[0].text).toContain('Successfully injected');

            // 3. Verify Status
            const statusResult = await client.callTool({ 
                name: 'get_injection_status',
                arguments: {} 
            }) as any;
            
            expect(statusResult.isError).toBeFalsy();
            expect(statusResult.content[0].text).toContain('Active Store Size: 1');

            await transport.close();
        }, 10000); // Higher timeout for CI/Windows throughput

        it('should handle multiple concurrent sessions', async () => {
            const t1 = new SSEClientTransport(new URL(`http://localhost:${TEST_PORT}/sse`));
            const t2 = new SSEClientTransport(new URL(`http://localhost:${TEST_PORT}/sse`));
            
            const c1 = new Client({ name: "cli-1", version: "1" }, { capabilities: {} });
            const c2 = new Client({ name: "cli-2", version: "1" }, { capabilities: {} });

            await Promise.all([c1.connect(t1), c2.connect(t2)]);

            const r1 = await c1.callTool({ name: 'get_injection_status', arguments: {} }) as any;
            const r2 = await c2.callTool({ name: 'get_injection_status', arguments: {} }) as any;

            expect(r1.isError).toBeFalsy();
            expect(r2.isError).toBeFalsy();
            expect(r1.content[0].text).toBeTruthy();
            expect(r2.content[0].text).toBeTruthy();

            await Promise.all([t1.close(), t2.close()]);
        }, 15000);
    });
});
