import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { hydrateProtocols, READ_ALOUD_PROTOCOLS } from '../src/common/protocolHydrator';

/**
 * ProtocolHydrator Integration Test Suite
 * This suite tests the ACTUAL filesystem logic (no fs mocks).
 * It uses a temporary directory to simulate the user's home directory.
 */
// Hoisted mock for os.homedir
vi.mock('os', async () => {
    const actual = await vi.importActual('os') as any;
    return {
        ...actual,
        homedir: vi.fn()
    };
});

describe('ProtocolHydrator Integration Tests (Live Filesystem)', () => {
    let tempHome: string;
    let mockProtocolsDir: string;
    const logger = vi.fn();

    beforeEach(() => {
        // 1. Create a truly isolated temporary "Home" directory
        tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-test-'));
        mockProtocolsDir = path.join(tempHome, '.gemini', 'antigravity', 'read_aloud', 'protocols');
        
        // 2. Configure the mock to return our new temp folder
        (os.homedir as any).mockReturnValue(tempHome);

        vi.clearAllMocks();
    });

    afterEach(() => {
        // Cleanup: Remove the temporary directory after each test
        if (fs.existsSync(tempHome)) {
            fs.rmSync(tempHome, { recursive: true, force: true });
        }
    });

    it('should perform a full initial hydration in a clean environment', () => {
        hydrateProtocols(logger);

        // Verify directory creation
        expect(fs.existsSync(mockProtocolsDir)).toBe(true);

        // Verify all files are physically present and correct
        Object.entries(READ_ALOUD_PROTOCOLS).forEach(([filename, expectedContent]) => {
            const filePath = path.join(mockProtocolsDir, filename);
            expect(fs.existsSync(filePath)).toBe(true);
            const actualContent = fs.readFileSync(filePath, 'utf-8');
            expect(actualContent).toBe(expectedContent);
        });

        expect(logger).toHaveBeenCalledWith(expect.stringContaining('Global Protocols Synchronized Successfully'));
    });

    it('should recover from deleted assets (Self-Healing Deletion)', () => {
        // 1. Initial hydration
        hydrateProtocols();
        
        // 2. Simulate deletion of a key protocol
        const targetFile = path.join(mockProtocolsDir, 'boot.md');
        fs.unlinkSync(targetFile);
        expect(fs.existsSync(targetFile)).toBe(false);

        // 3. Hydrate again
        hydrateProtocols(logger);

        // 4. Verify restoration
        expect(fs.existsSync(targetFile)).toBe(true);
        expect(logger).toHaveBeenCalledWith(expect.stringContaining('Missing Asset: boot.md not found. Hydrating.'));
    });

    it('should overwrite modified assets (Self-Healing Drift)', () => {
        // 1. Initial hydration
        hydrateProtocols();
        
        // 2. Simulate corruption/drift
        const targetFile = path.join(mockProtocolsDir, 'manifest.md');
        const driftedContent = '⚠️ DRIFT DETECTED ⚠️';
        fs.writeFileSync(targetFile, driftedContent, 'utf-8');

        // 3. Hydrate again
        hydrateProtocols(logger);

        // 4. Verify correction
        const fixedContent = fs.readFileSync(targetFile, 'utf-8');
        expect(fixedContent).toBe(READ_ALOUD_PROTOCOLS['manifest.md']);
        expect(logger).toHaveBeenCalledWith(expect.stringContaining('Version Drift: manifest.md is out of sync. Re-hydrating.'));
    });

    it('should be idempotent (No unnecessary writes)', () => {
        // 1. Initial hydration
        hydrateProtocols();
        
        // Clear logger to track new actions
        logger.mockClear();

        // 2. Record mtimes of the files
        const mtimesBefore = Object.keys(READ_ALOUD_PROTOCOLS).map(f => 
            fs.statSync(path.join(mockProtocolsDir, f)).mtimeMs
        );

        // 3. Hydrate again (should do nothing)
        hydrateProtocols(logger);

        // 4. Record mtimes after
        const mtimesAfter = Object.keys(READ_ALOUD_PROTOCOLS).map(f => 
            fs.statSync(path.join(mockProtocolsDir, f)).mtimeMs
        );

        // Timestamps should remain identical if no write occurred
        expect(mtimesAfter).toEqual(mtimesBefore);
        expect(logger).toHaveBeenCalledWith(expect.stringContaining('Global Protocols Synchronized Successfully'));
        expect(logger).not.toHaveReturnedWith(expect.stringContaining('Hydrating'));
    });
});
