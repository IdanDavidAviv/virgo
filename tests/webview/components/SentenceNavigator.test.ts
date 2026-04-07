/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SentenceNavigator } from '@webview/components/SentenceNavigator';
import { WebviewStore } from '@webview/core/WebviewStore';
import { MessageClient } from '@webview/core/MessageClient';
import { PlaybackController } from '@webview/playbackController';
import { IncomingCommand, OutgoingAction } from '@common/types';
import { resetAllSingletons, wireDispatcher } from '../testUtils';

describe('SentenceNavigator', () => {
    let elements: any;

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="navigator">
                <button id="prev"></button>
                <div id="current"></div>
                <button id="next"></button>
            </div>
        `;
        elements = {
            navigator: document.getElementById('navigator'),
            prev: document.getElementById('prev'),
            current: document.getElementById('current'),
            next: document.getElementById('next')
        };
        (window as any).vscode = null;
        (window as any).acquireVsCodeApi = vi.fn(() => ({
            postMessage: vi.fn()
        }));
        resetAllSingletons();
        wireDispatcher();
    });

    it('should render sentences from store', () => {
        const navigator = new SentenceNavigator(elements);
        navigator.mount();

        // Directly update store instead of event (to avoid racing in tests)
        WebviewStore.getInstance().updateState({
            currentSentences: ['S1', 'S2', 'S3'],
            state: { currentSentenceIndex: 1 } as any
        });

        expect(elements.prev.innerHTML).toContain('S1');
        expect(elements.current.innerHTML).toContain('S2');
        expect(elements.next.innerHTML).toContain('S3');
    });

    it('should handle jump on click', () => {
        const navigator = new SentenceNavigator(elements);
        navigator.mount();

        // Populate store
        WebviewStore.getInstance().updateState({
            currentSentences: ['S1', 'S2', 'S3'],
            state: { currentSentenceIndex: 1 } as any
        });

        const postSpy = vi.spyOn(MessageClient.getInstance(), 'postAction');
        elements.prev.click();

        expect(postSpy).toHaveBeenCalledWith(OutgoingAction.JUMP_TO_SENTENCE, expect.objectContaining({ index: 0 }));
    });

    it('should reflect stalled state', () => {
        const navigator = new SentenceNavigator(elements);
        navigator.mount();

        WebviewStore.getInstance().updateState({
            currentSentences: ['S1', 'S2', 'S3'],
            state: { currentSentenceIndex: 1 } as any,
            playbackStalled: true
        });

        // Our store logic deriving isSyncing might set it to true if playbackStalled is true
        // But SentenceNavigator listens specifically to playbackStalled for 'stalled' class
        expect(elements.navigator.classList.contains('stalled')).toBe(true);
        expect(elements.current.classList.contains('stalled')).toBe(true);
    });

    it('should show pending index during jump', () => {
        const navigator = new SentenceNavigator(elements);
        navigator.mount();

        // Populate store first
        WebviewStore.getInstance().updateState({
            currentSentences: ['S1', 'S2', 'S3'],
            state: { currentSentenceIndex: 0 } as any
        });

        // Initialize controller to handle the jump
        PlaybackController.getInstance();

        navigator.jump(2);

        // UI should reflect the jump immediately via the local store update in PlaybackController
        // even before sync arrives.
        expect(elements.current.innerHTML).toContain('S3');
    });
});
