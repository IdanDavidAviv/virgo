import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaybackController, PlaybackIntent, PlaybackMode } from '@webview/playbackController';
import { MessageClient } from '@webview/core/MessageClient';
import { WebviewStore } from '@webview/core/WebviewStore';
import { OutgoingAction } from '@common/types';

/**
 * @vitest-environment jsdom
 */
describe('PlaybackController', () => {
    let vscode: any;
    let audio: any;
    let controller: PlaybackController;

    beforeEach(() => {
        WebviewStore.resetInstance();
        vi.mock('@webview/core/MessageClient', () => {
            const mockClient = {
                getInstance: vi.fn(),
                postAction: vi.fn(),
                onCommand: vi.fn(),
                handleMessage: vi.fn(),
                subscribe: vi.fn(() => vi.fn())
            };
            mockClient.getInstance.mockReturnValue(mockClient);
            return { MessageClient: mockClient };
        });
        audio = { pause: vi.fn(), play: vi.fn(), currentTime: 0 };
        controller = new PlaybackController(audio);
        vi.useFakeTimers();
    });

    it('should transition to PLAYING intent and set sync lock', () => {
        controller.play('test-uri');
        const state = controller.getState();
        expect(state.intent).toBe(PlaybackIntent.PLAYING);
        expect(state.isAwaitingSync).toBe(true);
        expect(MessageClient.getInstance().postAction).toHaveBeenCalledWith(OutgoingAction.CONTINUE);
    });

    it('should transition to STOPPED intent and clear lock immediately', () => {
        controller.play('test-uri');
        controller.stop();
        const state = controller.getState();
        expect(state.intent).toBe(PlaybackIntent.STOPPED);
        expect(state.isAwaitingSync).toBe(false);
        expect(audio.pause).toHaveBeenCalled();
    });

    it('should map handleSync correctly to ACTIVE mode', () => {
        controller.handleSync({ isPlaying: true, isPaused: false });
        expect(controller.getState().mode).toBe(PlaybackMode.ACTIVE);
        expect(controller.getState().intent).toBe(PlaybackIntent.PLAYING);
    });

    it('should map handleSync correctly to PAUSED mode', () => {
        controller.handleSync({ isPlaying: true, isPaused: true });
        expect(controller.getState().mode).toBe(PlaybackMode.PAUSED);
        expect(controller.getState().intent).toBe(PlaybackIntent.PAUSED);
    });

    it('should release lock via manual releaseLock()', () => {
        controller.play('test-uri');
        controller.releaseLock();
        expect(controller.getState().isAwaitingSync).toBe(false);
    });

    it('should release lock automatically after watchdog timeout', () => {
        controller.play('test-uri');
        vi.advanceTimersByTime(3501);
        expect(controller.getState().isAwaitingSync).toBe(false);
    });
});
