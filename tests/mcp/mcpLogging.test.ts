import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { McpBridge } from '../../src/extension/mcp/mcpBridge';

describe('McpBridge Logging Unit Tests', () => {
    const logger = (msg: string) => console.log(`[UNIT_TEST_LOG] ${msg}`);
    const testDir = path.resolve('./tests/mcp/unit_logs_tmp');
    const nativeLogPath = path.join(testDir, 'native.log');
    const debugLogPath = path.join(testDir, 'diagnostics.log');

    beforeAll(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
        fs.mkdirSync(testDir, { recursive: true });
        
        fs.writeFileSync(nativeLogPath, 'Unit Test Native Log');
        fs.writeFileSync(debugLogPath, 'Unit Test Debug Log');
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    it('should correctly build native log content with PID header', async () => {
        const bridge = new McpBridge(testDir, logger, { fsPath: nativeLogPath } as any, debugLogPath);
        const content = await bridge.getLogContent('native');
        
        expect(content).toContain('PID:');
        expect(content).toContain('Unit Test Native Log');
        expect(content).toContain('--- [READ ALOUD NATIVE LOGS');
    });

    it('should correctly build debug log content with PID header and path', async () => {
        const bridge = new McpBridge(testDir, logger, { fsPath: nativeLogPath } as any, debugLogPath);
        const content = await bridge.getLogContent('debug');
        
        expect(content).toContain('PID:');
        expect(content).toContain('Unit Test Debug Log');
        expect(content).toContain('PATH:');
        expect(content).toContain(debugLogPath);
    });

    it('should handle missing native logUri gracefully', async () => {
        const bridge = new McpBridge(testDir, logger, undefined, debugLogPath);
        const content = await bridge.getLogContent('native');
        
        expect(content).toContain('Native log URI not initialized');
    });

    it('should handle missing debug log file gracefully', async () => {
        const nonExistentPath = path.join(testDir, 'ghost.log');
        const bridge = new McpBridge(testDir, logger, { fsPath: nativeLogPath } as any, nonExistentPath);
        const content = await bridge.getLogContent('debug');
        
        expect(content).toContain('Debug log file not found at project root');
    });

    it('should handle native log file missing from disk gracefully', async () => {
        const nonExistentNativePath = path.join(testDir, 'ghost_native.log');
        const bridge = new McpBridge(testDir, logger, { fsPath: nonExistentNativePath } as any, debugLogPath);
        const content = await bridge.getLogContent('native');
        
        expect(content).toContain(`Native log file not found at ${nonExistentNativePath}`);
    });
});
