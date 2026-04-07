import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebviewStore, DEFAULT_SYNC_PACKET } from '../../src/webview/core/WebviewStore';
import { MessageClient } from '../../src/webview/core/MessageClient';
import { CommandDispatcher } from '../../src/webview/core/CommandDispatcher';
import { InteractionManager } from '../../src/webview/core/InteractionManager';
import { LayoutManager } from '../../src/webview/core/LayoutManager';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';
import { PlaybackController } from '../../src/webview/playbackController';
import { IncomingCommand, OutgoingAction } from '../../src/common/types';

// Components
import { SettingsDrawer } from '../../src/webview/components/SettingsDrawer';
import { PlaybackControls } from '../../src/webview/components/PlaybackControls';
import { FileContext } from '../../src/webview/components/FileContext';
import { VoiceSelector } from '../../src/webview/components/VoiceSelector';

/**
 * @vitest-environment jsdom
 */

const FULL_DOM = `
    <div id="settings-drawer" class="settings-drawer">
        <span id="settings-toggle">⚙</span>
        <button id="settings-close">X</button>
        <input id="volume-slider" type="range" min="0" max="100" value="50">
        <input id="rate-slider" type="range" min="-10" max="10" value="0">
        <span id="volume-val">50%</span>
        <span id="rate-val">1.0x</span>
        <button id="engine-neural">Neural</button>
        <button id="engine-local">Local</button>
        <span id="cache-debug-tag"></span>
        <span id="state-debug-tag"></span>
        <div class="engine-toggle-group"></div>
    </div>

    <div class="playback-controls">
        <button id="btn-play">Play</button>
        <button id="btn-pause" style="display:none">Pause</button>
        <button id="btn-stop">Stop</button>
        <button id="btn-prev">Prev</button>
        <button id="btn-next">Next</button>
        <button id="btn-prev-sentence">Prev Sentence</button>
        <button id="btn-next-sentence">Next Sentence</button>
        <button id="btn-autoplay">Auto</button>
        <div id="status-dot"></div>
    </div>

    <div class="context-slot selection active">
        <span id="active-filename">test.md</span>
        <span id="active-dir">/docs</span>
        <button id="btn-load-file">Load</button>
    </div>
    <div class="context-slot reader">
        <span id="reader-filename"></span>
        <span id="reader-dir"></span>
        <button id="btn-clear-reader">Clear</button>
        <button id="btn-mode-file">File</button>
        <button id="btn-mode-snippet">Snippet</button>
        <div id="file-mode-container"></div>
        <div id="snippet-lookup-container" style="display:none"></div>
        <div id="transfer-layer"></div>
    </div>

    <div id="voice-list-container">
        <ul id="voice-list"></ul>
    </div>
    <input id="voice-search" type="text">
    <div id="wave-container"></div>
    <audio id="neural-player"></audio>
`;

describe('E2E Handshake & UI Integrity', () => {
    let store: WebviewStore;
    let mockVscode: any;
    let components: Record<string, any> = {};

    beforeEach(() => {
        document.body.innerHTML = FULL_DOM;
        
        // 1. HARD RESET
        delete (window as any).vscode;
        delete (window as any).acquireVsCodeApi;
        delete (window as any).__MESSAGE_CLIENT__;
        delete (window as any).__WEBVIEW_STORE__;
        delete (window as any).__PLAYBACK_CONTROLLER__;

        // 2. Mock VS Code API
        mockVscode = { postMessage: vi.fn() };
        (window as any).acquireVsCodeApi = () => mockVscode;

        // 3. Reset Singletons
        WebviewStore.resetInstance();
        MessageClient.resetInstance();
        CommandDispatcher.resetInstance();
        InteractionManager.resetInstance();
        LayoutManager.resetInstance();
        WebviewAudioEngine.resetInstance();
        PlaybackController.resetInstance();

        store = WebviewStore.getInstance();
        (store as any)._isHydrated = true;

        // 4. Activate Controller (Triggers listeners)
        PlaybackController.getInstance();
        
        // Setup components with real DOM elements
        const getEl = (id: string) => document.getElementById(id);

        components.settings = new SettingsDrawer({
            drawer: getEl('settings-drawer')!,
            btnOpen: getEl('settings-toggle')!,
            btnClose: getEl('settings-close'),
            volumeSlider: getEl('volume-slider') as HTMLInputElement,
            rateSlider: getEl('rate-slider') as HTMLInputElement,
            volumeVal: getEl('volume-val')!,
            rateVal: getEl('rate-val')!,
            btnCloudEngine: getEl('engine-neural') as HTMLButtonElement,
            btnLocalEngine: getEl('engine-local') as HTMLButtonElement,
            cacheDebugTag: getEl('cache-debug-tag')!,
            stateDebugTag: getEl('state-debug-tag')!,
            engineToggleGroup: document.querySelector('.engine-toggle-group'),
            neuralPlayer: getEl('neural-player') as HTMLMediaElement
        });

        components.playback = new PlaybackControls({
            btnPlay: getEl('btn-play') as HTMLButtonElement,
            btnPause: getEl('btn-pause') as HTMLButtonElement,
            btnStop: getEl('btn-stop') as HTMLButtonElement,
            btnPrev: getEl('btn-prev') as HTMLButtonElement,
            btnNext: getEl('btn-next') as HTMLButtonElement,
            btnPrevSentence: getEl('btn-prev-sentence') as HTMLButtonElement,
            btnNextSentence: getEl('btn-next-sentence') as HTMLButtonElement,
            btnAutoplay: getEl('btn-autoplay') as HTMLButtonElement,
            waveContainer: getEl('wave-container')!,
            statusDot: getEl('status-dot')!
        });

        components.fileContext = new FileContext({
            activeSlot: document.querySelector('.context-slot.selection') as HTMLElement,
            activeFilename: getEl('active-filename')!,
            activeDir: getEl('active-dir')!,
            readerSlot: document.querySelector('.context-slot.reader') as HTMLElement,
            readerFilename: getEl('reader-filename')!,
            readerDir: getEl('reader-dir')!,
            btnLoadFile: getEl('btn-load-file') as HTMLButtonElement,
            btnResetContext: getEl('btn-clear-reader') as HTMLButtonElement,
            btnModeFile: getEl('btn-mode-file') as HTMLButtonElement,
            btnModeSnippet: getEl('btn-mode-snippet') as HTMLButtonElement,
            fileModeContainer: getEl('file-mode-container')!,
            snippetLookupContainer: getEl('snippet-lookup-container')!,
            transferLayer: getEl('transfer-layer')!
        });

        components.voiceSelector = new VoiceSelector({
            container: getEl('voice-list-container')!,
            voiceList: getEl('voice-list') as HTMLUListElement,
            searchInput: getEl('voice-search') as HTMLInputElement
        });

        Object.values(components).forEach(c => c.mount());

        vi.useFakeTimers();
        vi.spyOn(WebviewAudioEngine.getInstance(), 'play');
        vi.spyOn(WebviewAudioEngine.getInstance(), 'pause');
        vi.spyOn(WebviewAudioEngine.getInstance(), 'stop');
    });

    afterEach(() => {
        Object.values(components).forEach((c: any) => c.unmount());
        InteractionManager.resetInstance();
        WebviewAudioEngine.resetInstance();
        MessageClient.resetInstance();
        WebviewStore.resetInstance();
        LayoutManager.resetInstance();
        CommandDispatcher.resetInstance();
        PlaybackController.resetInstance();
        vi.clearAllMocks();
        vi.resetAllMocks();
        vi.useFakeTimers();
    });

    // --- 📂 FILE CONTEXT TESTS ---
    describe('File Context Interactions', () => {
        it('should trigger OutgoingAction.LOAD_DOCUMENT when load button is clicked', () => {
            const btn = document.getElementById('btn-load-file');
            btn?.click();
            expect(mockVscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: OutgoingAction.LOAD_DOCUMENT
            }));
        });

        it('should trigger OutgoingAction.RESET_CONTEXT when clear button is clicked', () => {
            const btn = document.getElementById('btn-clear-reader');
            btn?.click();
            expect(mockVscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: OutgoingAction.RESET_CONTEXT
            }));
        });

        it('should pulse the load button when a mismatch is detected', async () => {
            const btn = document.getElementById('btn-load-file') as HTMLElement;
            const current = store.getState();
            store.patchState({ 
                state: { 
                    ...(current?.state || {}),
                    activeDocumentUri: 'file:///path/a.md',
                    focusedDocumentUri: 'file:///path/b.md',
                    focusedIsSupported: true
                } as any
            });
            
            vi.advanceTimersByTime(200);
            expect(btn.classList.contains('mismatch')).toBe(true);
        });

        it('should update rate when slider is changed', () => {
            const slider = document.getElementById('rate-slider') as HTMLInputElement;
            slider.value = '5';
            slider.dispatchEvent(new Event('input'));
            
            vi.advanceTimersByTime(200);
            expect(store.getState().rate).toBe(5);
        });
    });

    // --- ⏯️ PLAYBACK CONTROL TESTS ---
    describe('Playback Controls Handshake', () => {
        it('should trigger OutgoingAction.PLAY when play is clicked', async () => {
            const btn = document.getElementById('btn-play');
            btn?.click();
            // Wait for optimistic state patch and postAction
            vi.advanceTimersByTime(200);
            expect(store.getState().isPlaying).toBe(true);
            expect(mockVscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: OutgoingAction.PLAY
            }));
        });

        it('should trigger OutgoingAction.STOP when stop is clicked', () => {
            const btn = document.getElementById('btn-stop');
            btn?.click();
            expect(mockVscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: OutgoingAction.STOP
            }));
        });

        it('should trigger sentence skip actions', () => {
            document.getElementById('btn-next-sentence')?.click();
            expect(mockVscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: OutgoingAction.NEXT_SENTENCE
            }));
        });

        it('should trigger chapter skip actions', () => {
            document.getElementById('btn-next')?.click();
            expect(mockVscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: OutgoingAction.NEXT_CHAPTER
            }));
        });
    });

    // --- ⚙️ SETTINGS & DRAWER TESTS ---
    describe('Settings Drawer Logic', () => {
        it('should toggle the drawer open class when clicking the gear icon', () => {
            const toggle = document.getElementById('settings-toggle');
            const drawer = document.getElementById('settings-drawer');
            const btnLoad = document.getElementById('btn-load-file') as HTMLElement;
            
            // First click: Open
            toggle?.click();
            expect(drawer?.classList.contains('open')).toBe(true);

            // [SYNC] Check isAwaitingSync on the Button explicitly
            expect(btnLoad.classList.contains('is-loading')).toBe(false);

            // Second click: Close
            toggle?.click();
            expect(drawer?.classList.contains('open')).toBe(false);
        });
    });
});
