/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SentenceNavigator } from '@webview/components/SentenceNavigator';
import { WebviewStore } from '@webview/core/WebviewStore';
import { MessageClient } from '@webview/core/messageClient';
import { IncomingCommand, OutgoingAction } from '@common/types';

describe('SentenceNavigator', () => {
    let elements: any;

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="navigator">
                <div id="prev"></div>
                <div id="current"></div>
                <div id="next"></div>
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
        MessageClient.resetInstance();
        WebviewStore.resetInstance();
    });

    it('should render sentences from store', () => {
        const navigator = new SentenceNavigator(elements);
        navigator.mount();

        // Simulate state sync
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                currentSentences: ['S1', 'S2', 'S3'],
                state: { currentSentenceIndex: 1 }
            }
        }));

        expect(elements.prev.innerHTML).toContain('S1');
        expect(elements.current.innerHTML).toContain('S2');
        expect(elements.next.innerHTML).toContain('S3');
    });

    it('should handle jump on click', () => {
        const navigator = new SentenceNavigator(elements);
        navigator.mount();

        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                currentSentences: ['S1', 'S2', 'S3'],
                state: { currentSentenceIndex: 1 }
            }
        }));

        const postSpy = vi.spyOn(MessageClient.getInstance(), 'postAction');
        elements.prev.click();

        expect(postSpy).toHaveBeenCalledWith(OutgoingAction.JUMP_TO_SENTENCE, { index: 0 });
    });

    it('should reflect stalled state', () => {
        const navigator = new SentenceNavigator(elements);
        navigator.mount();

        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                currentSentences: ['S1', 'S2', 'S3'],
                state: { currentSentenceIndex: 1 },
                playbackStalled: true
            }
        }));

        expect(elements.navigator.classList.contains('stalled')).toBe(true);
        expect(elements.current.classList.contains('stalled')).toBe(true);
    });

    it('should show pending index during jump', () => {
        const navigator = new SentenceNavigator(elements);
        navigator.mount();

        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                currentSentences: ['S1', 'S2', 'S3'],
                state: { currentSentenceIndex: 0 }
            }
        }));

        navigator.jump(2);

        // Even before sync back, current should show S3 (pendingIndex takes precedence)
        expect(elements.current.innerHTML).toContain('S3');
    });
});
