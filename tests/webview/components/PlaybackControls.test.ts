/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaybackControls } from '@webview/components/PlaybackControls';
import { WebviewStore } from '@webview/core/WebviewStore';
import { MessageClient } from '@webview/core/messageClient';
import { IncomingCommand } from '@common/types';

describe('PlaybackControls', () => {
    let elements: any;

    beforeEach(() => {
        document.body.innerHTML = `
            <button id="btn-play">Play</button>
            <button id="btn-pause">Pause</button>
            <button id="btn-stop">Stop</button>
            <button id="btn-prev">Prev</button>
            <button id="btn-next">Next</button>
            <button id="btn-prev-sentence">PrevS</button>
            <button id="btn-next-sentence">NextS</button>
            <button id="btn-autoplay">AUTO</button>
            <div id="wave-container"></div>
            <span id="status-dot"></span>
        `;
        elements = {
            btnPlay: document.getElementById('btn-play'),
            btnPause: document.getElementById('btn-pause'),
            btnStop: document.getElementById('btn-stop'),
            btnPrev: document.getElementById('btn-prev'),
            btnNext: document.getElementById('btn-next'),
            btnPrevSentence: document.getElementById('btn-prev-sentence'),
            btnNextSentence: document.getElementById('btn-next-sentence'),
            btnAutoplay: document.getElementById('btn-autoplay'),
            waveContainer: document.getElementById('wave-container'),
            statusDot: document.getElementById('status-dot')
        };
        (window as any).vscode = null;
        (window as any).acquireVsCodeApi = vi.fn(() => ({ postMessage: vi.fn() }));
        MessageClient.resetInstance();
        WebviewStore.resetInstance();
    });

    describe('status-dot indicator (#1 regression guard)', () => {
        it('should add "online" class when actively playing', () => {
            const ctrl = new PlaybackControls(elements);
            ctrl.mount();

            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    command: IncomingCommand.UI_SYNC,
                    isPlaying: true,
                    isPaused: false,
                    state: { currentSentenceIndex: 0 }
                }
            }));

            expect(elements.statusDot.classList.contains('online')).toBe(true);
            expect(elements.statusDot.classList.contains('stalled')).toBe(false);
        });

        it('should remove "online" class when paused', () => {
            const ctrl = new PlaybackControls(elements);
            ctrl.mount();

            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    command: IncomingCommand.UI_SYNC,
                    isPlaying: true,
                    isPaused: true,
                    state: { currentSentenceIndex: 0 }
                }
            }));

            expect(elements.statusDot.classList.contains('online')).toBe(false);
        });

        it('should add "stalled" class when playback is stalled', () => {
            const ctrl = new PlaybackControls(elements);
            ctrl.mount();

            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    command: IncomingCommand.UI_SYNC,
                    isPlaying: true,
                    isPaused: false,
                    playbackStalled: true,
                    state: { currentSentenceIndex: 0 }
                }
            }));

            expect(elements.statusDot.classList.contains('stalled')).toBe(true);
        });

        it('should remove "online" and "stalled" when stopped', () => {
            const ctrl = new PlaybackControls(elements);
            ctrl.mount();

            // First play...
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    command: IncomingCommand.UI_SYNC,
                    isPlaying: true,
                    isPaused: false,
                    state: { currentSentenceIndex: 0 }
                }
            }));
            // ...then stop
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    command: IncomingCommand.UI_SYNC,
                    isPlaying: false,
                    isPaused: false,
                    state: { currentSentenceIndex: 0 }
                }
            }));

            expect(elements.statusDot.classList.contains('online')).toBe(false);
            expect(elements.statusDot.classList.contains('stalled')).toBe(false);
        });

        it('should not throw if statusDot element is null', () => {
            const ctrlNoEl = new PlaybackControls({ ...elements, statusDot: null });
            ctrlNoEl.mount();

            expect(() => {
                window.dispatchEvent(new MessageEvent('message', {
                    data: {
                        command: IncomingCommand.UI_SYNC,
                        isPlaying: true,
                        isPaused: false,
                        state: { currentSentenceIndex: 0 }
                    }
                }));
            }).not.toThrow();
        });
    });
});
