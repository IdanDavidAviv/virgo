/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SettingsDrawer } from '@webview/components/SettingsDrawer';
import { ToastManager } from '@webview/components/ToastManager';
import { WebviewStore } from '@webview/core/WebviewStore';
import { MessageClient } from '@webview/core/MessageClient';
import { CommandDispatcher } from '@webview/core/CommandDispatcher';
import { IncomingCommand, OutgoingAction } from '@common/types';
import { resetAllSingletons, wireDispatcher } from '../testUtils';

describe('SettingsDrawer', () => {
    let elements: any;
    let ctrl: SettingsDrawer;

    beforeEach(() => {
        vi.useFakeTimers();
        resetAllSingletons();
        wireDispatcher();
        document.body.innerHTML = `
            <div id="settings-drawer">
                <button id="settings-toggle">Settings</button>
                <button id="settings-close">Close</button>
                <input type="range" id="volume-slider" min="0" max="100">
                <span id="volume-val">50%</span>
                <input type="range" id="rate-slider" min="-10" max="10">
                <span id="rate-val">1.0x</span>
                <button id="engine-neural">Neural</button>
                <button id="engine-local">Local</button>
                <div class="engine-toggle-group"></div>
                <span id="cache-debug-tag"></span>
                <span id="state-debug-tag"></span>
                <audio id="neural-player"></audio>
            </div>
        `;
        elements = {
            drawer: document.getElementById('settings-drawer'),
            btnOpen: document.getElementById('settings-toggle'),
            btnClose: document.getElementById('settings-close'),
            volumeSlider: document.getElementById('volume-slider'),
            volumeVal: document.getElementById('volume-val'),
            rateSlider: document.getElementById('rate-slider'),
            rateVal: document.getElementById('rate-val'),
            btnCloudEngine: document.getElementById('engine-neural'),
            btnLocalEngine: document.getElementById('engine-local'),
            engineToggleGroup: document.querySelector('.engine-toggle-group'),
            cacheDebugTag: document.getElementById('cache-debug-tag'),
            stateDebugTag: document.getElementById('state-debug-tag'),
            neuralPlayer: document.getElementById('neural-player')
        };
        (window as any).vscode = null;
        (window as any).acquireVsCodeApi = vi.fn(() => ({ postMessage: vi.fn() }));
        resetAllSingletons();
        wireDispatcher();

        // [SOVEREIGNTY] Hard-hydrate the store for testing
        WebviewStore.getInstance().updateState({ 
            isHydrated: true, 
            playbackIntentId: 12345,
            volume: 50,
            rate: 0,
            engineMode: 'neural'
        } as any);

        vi.useFakeTimers();
    });

    afterEach(() => {
        if (ctrl) {
            ctrl.unmount();
        }
        ToastManager.clearAll();
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it('should update volume label when slider changes (oninput)', () => {
        ctrl = new SettingsDrawer(elements);
        ctrl.mount();

        const slider = elements.volumeSlider as HTMLInputElement;
        slider.value = '75';
        slider.dispatchEvent(new Event('input'));

        expect(elements.volumeVal.textContent).toBe('75%');
    });

    it('should update rate label with correct scale when slider changes (oninput)', () => {
        ctrl = new SettingsDrawer(elements);
        ctrl.mount();

        const slider = elements.rateSlider as HTMLInputElement;
        
        // 0 -> 1.0x
        slider.value = '0';
        slider.dispatchEvent(new Event('input'));
        expect(elements.rateVal.textContent).toBe('1.0x');

        // 5 -> 1.5x (1 + 5/10)
        slider.value = '5';
        slider.dispatchEvent(new Event('input'));
        expect(elements.rateVal.textContent).toBe('1.5x');
    });

    it('should sync sliders and labels with Store state', () => {
        ctrl = new SettingsDrawer(elements);
        ctrl.mount();

        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                volume: 25,
                rate: -5,
                currentSentenceIndex: 0
            }
        }));

        expect(elements.volumeSlider.value).toBe('25');
        expect(elements.volumeVal.textContent).toBe('25%');
        expect(elements.rateSlider.value).toBe('-5');
        expect(elements.rateVal.textContent).toBe('0.5x');
    });

    it('should post action when volume slider changes', () => {
        const postActionSpy = vi.spyOn(MessageClient.getInstance(), 'postAction');
        ctrl = new SettingsDrawer(elements);
        ctrl.mount();

        const slider = elements.volumeSlider as HTMLInputElement;
        slider.value = '40';
        // Use 'change' (onchange) which fires postAction directly without the 40ms debounce
        slider.dispatchEvent(new Event('change'));
        
        // Advance timers for debounced setVolume() in PlaybackController
        vi.advanceTimersByTime(200);

        expect(postActionSpy).toHaveBeenCalledWith(
            OutgoingAction.VOLUME_CHANGED,
            expect.objectContaining({ volume: 40, intentId: expect.any(Number) })
        );
    });

    it('should toggle "active" class on engine buttons based on store state', () => {
        ctrl = new SettingsDrawer(elements);
        ctrl.mount();

        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                engineMode: 'neural',
                currentSentenceIndex: 0
            }
        }));

        expect(elements.btnCloudEngine.classList.contains('active')).toBe(true);
        expect(elements.btnLocalEngine.classList.contains('active')).toBe(false);

        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                engineMode: 'local',
                currentSentenceIndex: 0
            }
        }));

        expect(elements.btnCloudEngine.classList.contains('active')).toBe(false);
        expect(elements.btnLocalEngine.classList.contains('active')).toBe(true);
    });
});
