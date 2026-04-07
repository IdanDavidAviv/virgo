/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaybackControls } from '@webview/components/PlaybackControls';
import { WebviewStore } from '@webview/core/WebviewStore';
import { PlaybackController } from '@webview/playbackController';
import { MessageClient } from '@webview/core/MessageClient';
import { IncomingCommand } from '@common/types';
import { resetAllSingletons, wireDispatcher, FULL_DOM_TEMPLATE } from '../testUtils';

describe('PlaybackControls', () => {
    let elements: any;

    beforeEach(() => {
        document.body.innerHTML = FULL_DOM_TEMPLATE;
        
        // 1. Reset everything FIRST
        resetAllSingletons();
        
        // 2. Mock Globals specifically for this test
        const mockVscode = { postMessage: vi.fn() };
        (window as any).acquireVsCodeApi = vi.fn(() => mockVscode);
        (window as any).vscode = mockVscode;

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
        
        wireDispatcher();
        // Initialize instance to trigger listeners
        PlaybackController.getInstance();
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

    describe('Optimistic UI & Haptics (Phase 2)', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should optimistically cycle autoplay mode on click', () => {
            const ctrl = new PlaybackControls(elements);
            ctrl.mount();

            const store = WebviewStore.getInstance();
            store.updateState({ autoPlayMode: 'auto' } as any); // Pre-hydrate for patchState safety

            const setAutoPlaySpy = vi.spyOn(PlaybackController.getInstance(), 'setAutoPlayMode');

            // Default is 'auto' (implied)
            elements.btnAutoplay.click();

            // 1. Should call controller immediately
            expect(setAutoPlaySpy).toHaveBeenCalledWith('chapter');
            
            // 2. UI should update instantly via store notification (which controller handles)
            expect(elements.btnAutoplay.textContent).toBe('1 CH');
            expect(elements.btnAutoplay.classList.contains('pulse')).toBe(true);
        });

        it('should trigger pulse haptics on statusDot for transport actions', () => {
            const ctrl = new PlaybackControls(elements);
            ctrl.mount();

            // Test Pause
            elements.btnPause.click();
            expect(elements.btnPause.classList.contains('pulse')).toBe(true);
            expect(elements.statusDot.classList.contains('pulse')).toBe(true);

            vi.advanceTimersByTime(400);
            expect(elements.btnPause.classList.contains('pulse')).toBe(false);
            expect(elements.statusDot.classList.contains('pulse')).toBe(false);

            // Test Next
            elements.btnNext.click();
            expect(elements.btnNext.classList.contains('pulse')).toBe(true);
            expect(elements.statusDot.classList.contains('pulse')).toBe(true);
        });
    });
});
