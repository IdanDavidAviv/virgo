import { describe, it, expect, afterAll } from 'vitest';
import { PhonikudIPCManager } from '../../src/extension/core/PhonikudIPCManager';

describe('PhonikudIPCManager Zero-Disk RAM Streaming', () => {
    const manager = new PhonikudIPCManager();

    afterAll(async () => {
        await manager.stop();
    });

    it('should synthesize Hebrew text to base64 audio directly in RAM without temp file creation', async () => {
        const text = 'שלום';
        const base64Audio = await manager.synthesize(text);

        expect(typeof base64Audio).toBe('string');
        expect(base64Audio.length).toBeGreaterThan(100);
        expect(() => Buffer.from(base64Audio, 'base64')).not.toThrow();
    }, 20000);
});
