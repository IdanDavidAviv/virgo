/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceSelector } from '@webview/components/VoiceSelector';
import { ToastManager } from '@webview/components/ToastManager';
import { WebviewStore } from '@webview/core/WebviewStore';
import { MessageClient } from '@webview/core/MessageClient';
import { CommandDispatcher } from '@webview/core/CommandDispatcher';
import { IncomingCommand, OutgoingAction } from '@common/types';

describe('VoiceSelector', () => {
    let elements: any;
    let ctrl: VoiceSelector;

    beforeEach(() => {
        HTMLElement.prototype.scrollIntoView = vi.fn();
        document.body.innerHTML = `
            <div id="voice-list-container" class="voice-list-container"></div>
            <input type="text" id="voice-search">
        `;
        elements = {
            voiceList: document.getElementById('voice-list-container'),
            searchInput: document.getElementById('voice-search')
        };
        (window as any).vscode = null;
        (window as any).acquireVsCodeApi = vi.fn(() => ({ postMessage: vi.fn() }));
        MessageClient.resetInstance();
        WebviewStore.resetInstance();
        CommandDispatcher.resetInstance();
        // Wire up the dispatcher so UI_SYNC/VOICES messages reach the store
        CommandDispatcher.getInstance();
    });

    afterEach(() => {
        if (ctrl) {
            ctrl.unmount();
        }
        ToastManager.clearAll();
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('should render a list of custom "voice-item" elements', () => {
        ctrl = new VoiceSelector(elements);
        ctrl.mount();

        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                availableVoices: {
                    local: [
                        { id: 'v1', name: 'Voice 1', lang: 'en-US' },
                        { id: 'v2', name: 'Voice 2', lang: 'fr-FR' }
                    ],
                    neural: []
                },
                engineMode: 'local',
                state: { currentSentenceIndex: 0 }
            }
        }));

        const items = elements.voiceList.querySelectorAll('.voice-item');
        expect(items.length).toBe(2);
        expect(items[0].textContent).toContain('Voice 1');
        expect(items[1].textContent).toContain('Voice 2');
    });

    it('should show sparkle icon for neural voices', () => {
        ctrl = new VoiceSelector(elements);
        ctrl.mount();

        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                availableVoices: {
                    local: [],
                    neural: [
                        { id: 'n1', name: 'Neural Voice', lang: 'en-GB' }
                    ]
                },
                engineMode: 'neural',
                state: { currentSentenceIndex: 0 }
            }
        }));

        const sparkle = elements.voiceList.querySelector('.sparkle');
        expect(sparkle).not.toBeNull();
        expect(sparkle.textContent).toBe('✨');
        expect(elements.voiceList.textContent).toContain('Neural Voice');
    });

    it('should filter the list based on search term', () => {
        ctrl = new VoiceSelector(elements);
        ctrl.mount();

        // Initial sync with two voices
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                availableVoices: {
                    local: [
                        { id: 'en', name: 'English Voice', lang: 'en-US' },
                        { id: 'fr', name: 'French Voice', lang: 'fr-FR' }
                    ],
                    neural: []
                },
                engineMode: 'local',
                state: { currentSentenceIndex: 0 }
            }
        }));

        // Search for 'English'
        elements.searchInput.value = 'English';
        elements.searchInput.dispatchEvent(new Event('input'));

        let items = elements.voiceList.querySelectorAll('.voice-item');
        expect(items.length).toBe(1);
        expect(items[0].textContent).toContain('English Voice');

        // Search for 'French'
        elements.searchInput.value = 'French';
        elements.searchInput.dispatchEvent(new Event('input'));

        items = elements.voiceList.querySelectorAll('.voice-item');
        expect(items.length).toBe(1);
        expect(items[0].textContent).toContain('French Voice');

        // Search for 'None'
        elements.searchInput.value = 'None';
        elements.searchInput.dispatchEvent(new Event('input'));

        items = elements.voiceList.querySelectorAll('.voice-item');
        expect(items.length).toBe(0);
        expect(elements.voiceList.innerHTML).toContain('No voices found');
    });

    it('should post action when a voice item is clicked', () => {
        const postActionSpy = vi.spyOn(MessageClient.getInstance(), 'postAction');
        ctrl = new VoiceSelector(elements);
        ctrl.mount();

        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                availableVoices: {
                    local: [{ id: 'v1', name: 'V1', lang: '' }],
                    neural: []
                },
                engineMode: 'local',
                state: { currentSentenceIndex: 0 }
            }
        }));

        const item = elements.voiceList.querySelector('.voice-item');
        item.click();

        expect(postActionSpy).toHaveBeenCalledWith(OutgoingAction.VOICE_CHANGED, { voice: 'v1' });
        // Re-query: the original item is detached due to optimistic re-render
        const selected = elements.voiceList.querySelector('.voice-item.selected');
        expect(selected).not.toBeNull();
        expect(selected.textContent).toContain('V1');
    });

    it('should scroll selected voice into view using timers', () => {
        vi.useFakeTimers();
        ctrl = new VoiceSelector(elements);
        ctrl.mount();

        const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');

        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                availableVoices: {
                    local: [{ id: 'v1', name: 'V1', lang: '' }],
                    neural: []
                },
                engineMode: 'local',
                selectedVoice: 'v1'
            }
        }));

        vi.advanceTimersByTime(50);
        expect(scrollSpy).toHaveBeenCalled();
        scrollSpy.mockRestore();
    });
});
