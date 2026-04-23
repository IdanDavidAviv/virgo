import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { LogReporter } from '../../src/common/mcp/logReporter';
 
// Mock vscode
vi.mock('vscode', () => ({
    ExtensionMode: {
        Production: 1,
        Development: 2,
        Test: 3
    }
}));

describe('LogReporter Unit Tests', () => {
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
        const content = LogReporter.build('native', { nativeLogUri: { fsPath: nativeLogPath } });
        
        expect(content).toContain('PID:');
        expect(content).toContain('Unit Test Native Log');
        expect(content).toContain('--- [READ ALOUD NATIVE LOGS');
    });

    it('should correctly build debug log content with PID header and path', async () => {
        const content = LogReporter.build('debug', { debugLogPath });
        
        expect(content).toContain('PID:');
        expect(content).toContain('Unit Test Debug Log');
        expect(content).toContain('PATH:');
        expect(content).toContain(debugLogPath);
    });

    it('should handle missing native logUri gracefully', async () => {
        const content = LogReporter.build('native', { nativeLogUri: undefined });
        
        expect(content).toContain('Native log URI not initialized');
    });

    it('should handle missing debug log file gracefully', async () => {
        const nonExistentPath = path.join(testDir, 'ghost.log');
        const content = LogReporter.build('debug', { debugLogPath: nonExistentPath });
        
        expect(content).toContain('Debug log file not found at project root');
    });

    it('should handle native log file missing from disk gracefully', async () => {
        const nonExistentNativePath = path.join(testDir, 'ghost_native.log');
        const content = LogReporter.build('native', { nativeLogUri: { fsPath: nonExistentNativePath } });
        
        expect(content).toContain('Native log URI not initialized or inaccessible.');
    });
});
