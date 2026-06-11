import { describe, it, expect } from 'vitest';
import { createVirgoMcpServer } from '../../src/extension/mcp/core/mcpFactory';
import { PendingInjectionStore } from '../../src/extension/mcp/core/sharedStore';
import * as path from 'path';
import * as os from 'os';

describe('Virgo MCP Server Factory & Resources (T-106)', () => {
    const tempDir = path.join(os.tmpdir(), 'virgo_mcp_factory_test_' + Math.random().toString(36).substring(7));
    const store = new PendingInjectionStore(tempDir);

    it('SHOULD create a server instance with the expected tools and resources', () => {
        const server = createVirgoMcpServer({
            persistencePath: tempDir,
            sessionsRoot: tempDir,
            logger: () => {},
            store,
            version: '2.9.5'
        });

        // 1. Verify Tools are registered
        const registeredTools = (server as any)._registeredTools || new Map();
        const hasTool = (name: string) => {
            if (registeredTools instanceof Map) {
                return registeredTools.has(name);
            }
            return registeredTools[name] !== undefined;
        };
        expect(hasTool('say_this_loud')).toBe(true);
        expect(hasTool('self_diagnostic')).toBe(true);
        expect(hasTool('get_injection_status')).toBe(true);

        // 2. Verify Resources / Templates
        const registeredResources = (server as any)._registeredResources || new Map();
        const hasResource = (uri: string) => {
            if (registeredResources instanceof Map) {
                return registeredResources.has(uri);
            }
            return registeredResources[uri] !== undefined;
        };
        expect(hasResource('virgo://logs/live_log')).toBe(true);

        const registeredTemplates = (server as any)._registeredResourceTemplates || new Map();
        const hasTemplate = (uriPattern: string) => {
            if (registeredTemplates instanceof Map) {
                return registeredTemplates.has(uriPattern);
            }
            if (Array.isArray(registeredTemplates)) {
                return registeredTemplates.some((t: any) => {
                    const temp = t.resourceTemplate || t;
                    const uriTmp = temp.uriTemplate?.uriTemplate || temp.uriTemplate || temp.template;
                    return String(uriTmp) === uriPattern;
                });
            }
            // Support check for keys/values
            for (const val of Object.values(registeredTemplates)) {
                const temp = (val as any).resourceTemplate || val;
                const uriTmp = temp.uriTemplate?.uriTemplate || temp.uriTemplate || temp.template;
                if (String(uriTmp) === uriPattern) return true;
            }
            return false;
        };

        // session-state template is registered
        expect(hasTemplate('virgo://session/{sessionId}/state')).toBe(true);

        // injected-snippets should NOT be registered as a template
        expect(hasTemplate('virgo://session/{sessionId}/snippets/{name}')).toBe(false);
    });
});
