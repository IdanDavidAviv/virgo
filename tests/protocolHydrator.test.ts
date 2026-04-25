import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { hydrateProtocols, VIRGO_PROTOCOLS } from '../src/common/protocolHydrator';

// Mock fs and os
vi.mock('fs');
vi.mock('os');

describe('ProtocolHydrator Tests', () => {
    const mockUserHome = 'C:\\Users\\TestUser';
    const mockBaseDir = path.join(mockUserHome, '.gemini', 'antigravity', 'virgo', 'protocols');
    const logger = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        (os.homedir as any).mockReturnValue(mockUserHome);
        (fs.existsSync as any).mockReturnValue(false);
        (fs.readFileSync as any).mockReturnValue('');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('should create the directory if it does not exist', () => {
        hydrateProtocols(logger);
        
        expect(fs.mkdirSync).toHaveBeenCalledWith(mockBaseDir, { recursive: true });
        expect(logger).toHaveBeenCalledWith(expect.stringContaining('Creating global protocols directory'));
    });

    it('should write all protocol files if none exist', () => {
        (fs.existsSync as any).mockReturnValue(false);

        hydrateProtocols(logger);

        Object.entries(VIRGO_PROTOCOLS).forEach(([filename, content]) => {
            const filePath = path.join(mockBaseDir, filename);
            expect(fs.writeFileSync).toHaveBeenCalledWith(filePath, content, 'utf-8');
        });

        expect(logger).toHaveBeenCalledWith(expect.stringContaining('Global Protocols Synchronized Successfully'));
    });

    it('should overwrite a file if its content differs (drift recovery)', () => {
        const filename = Object.keys(VIRGO_PROTOCOLS)[0];
        const filePath = path.join(mockBaseDir, filename);
        const staleContent = 'stale content';

        (fs.existsSync as any).mockImplementation((p: string) => p === mockBaseDir || p === filePath);
        (fs.readFileSync as any).mockImplementation((p: string) => p === filePath ? staleContent : '');

        hydrateProtocols(logger);

        expect(fs.writeFileSync).toHaveBeenCalledWith(filePath, VIRGO_PROTOCOLS[filename], 'utf-8');
        expect(logger).toHaveBeenCalledWith(expect.stringContaining(`Version Drift: ${filename}`));
    });

    it('should skip writing if the content matches (idempotency)', () => {
        const filename = Object.keys(VIRGO_PROTOCOLS)[0];
        const filePath = path.join(mockBaseDir, filename);
        const correctContent = VIRGO_PROTOCOLS[filename];

        (fs.existsSync as any).mockImplementation((p: string) => p === mockBaseDir || p === filePath);
        (fs.readFileSync as any).mockImplementation((p: string) => p === filePath ? 'utf-8' : '');
        // Mocking readFileSync return value based on path
        (fs.readFileSync as any).mockImplementation((p: string, encoding: string) => {
            if (p === filePath && encoding === 'utf-8') {return correctContent;}
            {return '';}
        });

        hydrateProtocols(logger);

        expect(fs.writeFileSync).not.toHaveBeenCalledWith(filePath, correctContent, 'utf-8');
        expect(logger).toHaveBeenCalledWith(expect.stringContaining('Global Protocols Synchronized Successfully'));
    });

    it('should handle errors gracefully', () => {
        (fs.mkdirSync as any).mockImplementation(() => {
            throw new Error('Permission Denied');
        });

        hydrateProtocols(logger);

        expect(logger).toHaveBeenCalledWith(expect.stringContaining('Critical failure during protocol hydration: Permission Denied'));
    });
});
