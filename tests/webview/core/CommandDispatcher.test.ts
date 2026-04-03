import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CommandDispatcher } from '../../../src/webview/core/CommandDispatcher';
import { IncomingCommand } from '../../../src/common/types';

/**
 * @vitest-environment jsdom
 */

describe('CommandDispatcher Logging (TDD)', () => {
    let dispatcher: CommandDispatcher;
    let logSpy: any;

    beforeEach(() => {
        CommandDispatcher.resetInstance();
        dispatcher = CommandDispatcher.getInstance();
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('SHOULD filter PROGRESS and CACHE_STATS commands from the log', () => {
        (dispatcher as any).logSafeMessage(IncomingCommand.PROGRESS, { progress: 50 });
        (dispatcher as any).logSafeMessage(IncomingCommand.CACHE_STATS, { count: 1 });
        
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('SHOULD format messages with [HOST -> WEBVIEW] prefix', () => {
        (dispatcher as any).logSafeMessage(IncomingCommand.PLAY_AUDIO, { cacheKey: 'test' });
        
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[HOST -> WEBVIEW]'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[PLAY_AUDIO]'));
    });

    it('SHOULD truncate large binary data or arrays', () => {
        const largeData = 'a'.repeat(2000);
        (dispatcher as any).logSafeMessage(IncomingCommand.PLAY_AUDIO, { data: largeData });
        
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[BIN:2KB]'));
    });

    it('SHOULD truncate large arrays in payloads', () => {
        const largeArray = new Array(10).fill('voice');
        (dispatcher as any).logSafeMessage(IncomingCommand.VOICES, { voices: largeArray });
        
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[CNT:10]'));
    });

    it('SHOULD handle null/undefined data safely', () => {
        (dispatcher as any).logSafeMessage(IncomingCommand.PURGE_MEMORY, null);
        // Expect no crash and no log (or handled log)
    });
});
