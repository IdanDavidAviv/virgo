/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetAllSingletons, getCoreSystems } from './testUtils';
import { IncomingCommand } from '../../src/common/types';
import { CommandDispatcher } from '../../src/webview/core/CommandDispatcher';

describe('Autoplay Hardening Audit', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="btn-play"></div>';
        resetAllSingletons();
        
        // Mock Audio element play to return a resolving promise
        const { engine } = getCoreSystems();
        (engine as any)._audio.play = vi.fn().mockResolvedValue(undefined);
        
        // Mock ingestData to prevent actual blob creation/cache interaction
        vi.spyOn(engine, 'ingestData').mockResolvedValue(undefined);
        vi.spyOn(engine, 'playFromBase64').mockResolvedValue(undefined);
    });

    it('should initially have userHasInteracted set to false', () => {
        const { controller } = getCoreSystems();
        expect(controller.userHasInteracted).toBe(false);
    });

    it('should suppress PLAY_AUDIO commands if userHasInteracted is false', async () => {
        const { controller } = getCoreSystems();
        const dispatcher = CommandDispatcher.getInstance();
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        
        const mockData = { cacheKey: 'test', intentId: 1, data: 'base64...' };

        await dispatcher.dispatch(IncomingCommand.PLAY_AUDIO, mockData);

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Playback Blocked'));
        expect(controller.userHasInteracted).toBe(false);
    });

    it('should unlock the gate after a simulated user interaction', async () => {
        const { controller } = getCoreSystems();
        
        // Simulate global interaction
        const event = new MouseEvent('mousedown', { bubbles: true });
        window.dispatchEvent(event);

        expect(controller.userHasInteracted).toBe(true);
    });

    it('should allow commands to pass once the gate is unlocked', async () => {
        const { controller } = getCoreSystems();
        const dispatcher = CommandDispatcher.getInstance();
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        
        // 1. Unlock gate
        window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(controller.userHasInteracted).toBe(true);

        // 2. Dispatch command
        const mockData = { cacheKey: 'test', intentId: 1, data: 'base64...' };

        // We expect dispatch to NOT log the suppression warning
        await dispatcher.dispatch(IncomingCommand.PLAY_AUDIO, mockData);
        expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Playback Blocked'));
    });
});
