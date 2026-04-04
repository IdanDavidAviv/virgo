/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Core imports
import { MessageClient } from '../../src/webview/core/MessageClient';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { LayoutManager } from '../../src/webview/core/LayoutManager';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';
import { InteractionManager } from '../../src/webview/core/InteractionManager';
import { CommandDispatcher } from '../../src/webview/core/CommandDispatcher';
import { PlaybackController } from '../../src/webview/playbackController';

// Component imports
import { SentenceNavigator } from '../../src/webview/components/SentenceNavigator';
import { ChapterList } from '../../src/webview/components/ChapterList';
import { PlaybackControls } from '../../src/webview/components/PlaybackControls';
import { FileContext } from '../../src/webview/components/FileContext';
import { SettingsDrawer } from '../../src/webview/components/SettingsDrawer';
import { VoiceSelector } from '../../src/webview/components/VoiceSelector';
import { ToastManager } from '../../src/webview/components/ToastManager';

import { IncomingCommand, OutgoingAction } from '../../src/common/types';

// Mock CacheManager to avoid IndexedDB issues in JSDOM
vi.mock('../../src/webview/cacheManager', () => ({
    CacheManager: class {
        initDB = vi.fn().mockResolvedValue(null);
        get = vi.fn().mockResolvedValue(null);
        set = vi.fn().mockResolvedValue(null);
        clear = vi.fn().mockResolvedValue(null);
        getStats = vi.fn().mockResolvedValue({ count: 0, size: 0 });
    }
}));

describe('Handshake Audit: Full UI & Logic Synchronization', () => {
    let components: any = {};
    let mockVscode: any;

    beforeEach(() => {
        // ... (setup document, timers, vscode mock, singletons) ...

        // NEW: Load actual production HTML
        const htmlPath = resolve(__dirname, '../../src/webview/speechEngine.html');
        const html = readFileSync(htmlPath, 'utf8');
        document.body.innerHTML = html;

        vi.useFakeTimers();
        mockVscode = { postMessage: vi.fn() };
        (window as any).acquireVsCodeApi = vi.fn(() => mockVscode);
        (window as any).vscode = mockVscode;

        MessageClient.resetInstance();
        WebviewStore.resetInstance();
        LayoutManager.resetInstance();
        InteractionManager.resetInstance();
        WebviewAudioEngine.resetInstance();
        CommandDispatcher.resetInstance();
        PlaybackController.resetInstance();


        const getEl = (id: string) => document.getElementById(id) as HTMLElement;

        components.navigator = new SentenceNavigator({
            navigator: getEl('sentence-navigator'),
            prev: getEl('sentence-prev'),
            current: getEl('sentence-current'),
            next: getEl('sentence-next')
        });

        components.chapters = new ChapterList({
            container: getEl('chapter-list'),
            fullProgressHeader: getEl('sentence-progress'),
            chapterOnlyHeader: getEl('chapter-progress')
        });

        components.controls = new PlaybackControls({
            btnPlay: getEl('btn-play') as HTMLButtonElement,
            btnPause: getEl('btn-pause') as HTMLButtonElement,
            btnStop: getEl('btn-stop') as HTMLButtonElement,
            btnPrev: getEl('btn-prev') as HTMLButtonElement,
            btnNext: getEl('btn-next') as HTMLButtonElement,
            btnPrevSentence: getEl('btn-prev-sentence') as HTMLButtonElement,
            btnNextSentence: getEl('btn-next-sentence') as HTMLButtonElement,
            btnAutoplay: getEl('btn-autoplay') as HTMLButtonElement,
            waveContainer: getEl('sentence-navigator'),
            statusDot: getEl('status-dot')
        });

        components.fileContext = new FileContext({
            activeSlot: document.querySelector('.context-slot.selection') as HTMLElement,
            readerSlot: document.querySelector('.context-slot.reader') as HTMLElement,
            activeFilename: getEl('active-filename'),
            activeDir: getEl('active-dir'),
            readerFilename: getEl('reader-filename'),
            readerDir: getEl('reader-dir'),
            btnLoadFile: getEl('btn-load-file') as HTMLButtonElement,
            btnClearReader: getEl('btn-clear-reader') as HTMLButtonElement
        });

        components.settings = new SettingsDrawer({
            btnOpen: getEl('settings-toggle') as HTMLButtonElement,
            btnClose: getEl('settings-toggle') as HTMLButtonElement, 
            drawer: getEl('settings-drawer'),
            rateSlider: getEl('rate-slider') as HTMLInputElement,
            volumeSlider: getEl('volume-slider') as HTMLInputElement,
            rateVal: getEl('rate-val'),
            volumeVal: getEl('volume-val'),
            btnCloudEngine: getEl('engine-neural') as HTMLButtonElement,
            btnLocalEngine: getEl('engine-local') as HTMLButtonElement,
            cacheDebugTag: getEl('cache-debug-tag'),
            stateDebugTag: getEl('state-debug-tag'),
            engineToggleGroup: document.querySelector('.engine-toggle-group') as HTMLElement,
            neuralPlayer: getEl('neural-player') as HTMLMediaElement
        });

        components.voice = new VoiceSelector({
            voiceList: getEl('voice-list-container'),
            searchInput: getEl('voice-search') as HTMLInputElement
        });

        LayoutManager.getInstance().registerOverlay('settings', components.settings);

        Object.values(components).forEach((c: any) => c.mount());
        InteractionManager.getInstance().mount();
        ToastManager.setContainer(getEl('toast-container'));

        // 4. Hydrate WebviewStore with UI_SYNC AFTER component mounting (Surgical Order #4)
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                state: {
                    focusedFileName: 'doc.md',
                    focusedRelativeDir: '/',
                    focusedDocumentUri: 'file:///path/to/doc.md',
                    focusedIsSupported: true,
                    activeFileName: 'doc.md',
                    activeRelativeDir: '/',
                    activeDocumentUri: 'file:///path/to/doc.md',
                    currentChapterIndex: 0,
                    currentSentenceIndex: 0,
                    isRefreshing: false,
                    isPreviewing: false
                },
                isPlaying: false,
                isPaused: false,
                playbackStalled: false,
                currentSentences: [],
                allChapters: [],
                currentText: '',
                totalChapters: 0,
                canPrevChapter: false,
                canNextChapter: false,
                canPrevSentence: false,
                canNextSentence: false,
                autoPlayMode: 'auto',
                isFocusedSupported: true,
                volume: 50,
                rate: 10,
                engineMode: 'neural',
                voiceName: 'V1',
                availableVoices: {
                    neural: [{ id: 'V1', name: 'Voice 1' }],
                    local: []
                },
                chapters: [],
                activeChapterIndex: 0
            }
        }));
        
        // Wait for MessageClient microtask
        vi.advanceTimersByTime(50);

        const dispatcher = CommandDispatcher.getInstance();
        const client = MessageClient.getInstance();
        client.onCommand(IncomingCommand.PLAY_AUDIO, (data) => dispatcher.dispatch(IncomingCommand.PLAY_AUDIO, data));
        client.onCommand(IncomingCommand.SYNTHESIS_ERROR, (data) => dispatcher.dispatch(IncomingCommand.SYNTHESIS_ERROR, data));

        vi.spyOn(WebviewAudioEngine.getInstance(), 'setVolume');
        vi.spyOn(WebviewAudioEngine.getInstance(), 'setRate');
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
            // Use WebviewStore.getInstance().patchState to simulate sync
            const current = WebviewStore.getInstance().getState();
            WebviewStore.getInstance().patchState({ 
                state: { 
                    ...(current?.state || {}),
                    activeDocumentUri: 'file:///path/a.md',
                    focusedDocumentUri: 'file:///path/b.md',
                    focusedIsSupported: true
                } as any
            });
            
            // Wait for subscription notification
            vi.advanceTimersByTime(50);
            expect(btn.classList.contains('mismatch')).toBe(true);
        });
    });

    // --- ⏯️ PLAYBACK CONTROL TESTS ---
    describe('Playback Controls Handshake', () => {
        it('should trigger OutgoingAction.PLAY when play is clicked', async () => {
            const btn = document.getElementById('btn-play');
            btn?.click();
            // Wait for optimistic state patch and postAction
            vi.advanceTimersByTime(10);
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
            
            // First click: Open
            toggle?.click();
            expect(drawer?.classList.contains('open')).toBe(true);

            // Second click: Close
            toggle?.click();
            expect(drawer?.classList.contains('open')).toBe(false);
        });

        it('should notify extension and update engine when sliders are moved', () => {
            const volSlider = document.getElementById('volume-slider') as HTMLInputElement;
            volSlider.value = '80';
            volSlider.dispatchEvent(new Event('input'));

            // Real-time engine update
            expect(WebviewAudioEngine.getInstance().setVolume).toHaveBeenCalledWith(80);
            
            // Throttled notification (Wait, this is debounced, may need a wait or use vi.advanceTimersByTime)
            vi.advanceTimersByTime(100);
            expect(mockVscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: OutgoingAction.VOLUME_CHANGED,
                volume: 80
            }));
        });

        it('should switch engine mode via toggle pills', () => {
            const neuralBtn = document.getElementById('engine-neural');
            neuralBtn?.click();
            expect(mockVscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: OutgoingAction.ENGINE_MODE_CHANGED,
                mode: 'neural'
            }));
        });
    });

    // --- 🔊 AUDIO COMMAND BRIDGE TESTS ---
    describe('Audio Command Bridge', () => {
        it('should begin playback when playAudio command is received', async () => {
            // 0. Use fake timers consistently
            vi.useFakeTimers();
            const dispatcher = CommandDispatcher.getInstance();
            const engine = WebviewAudioEngine.getInstance();
            const playSpy = vi.spyOn(WebviewAudioEngine.prototype, 'playFromBase64').mockResolvedValue();
            
            // 1. MUST set intent to PLAYING otherwise Zombie Guard blocks it
            PlaybackController.getInstance().play();
            engine.prepareForPlayback();
            
            console.log('--- TEST START ---');

            // 2. Call dispatcher directly to bypass IPC layer in JSDOM (Module Identity check)
            await dispatcher.dispatch(IncomingCommand.PLAY_AUDIO, {
                data: 'base64data...',
                cacheKey: 'test-key'
            });
            
            // 3. Await the async dispatch microtask
            vi.advanceTimersByTime(100);
            
            expect(playSpy).toHaveBeenCalled();
        });

        it('should show toast notification on synthesisError', async () => {
            // Restore real timers — fake timers block dynamic import() microtask resolution
            vi.useRealTimers();
            const toastSpy = vi.spyOn(ToastManager, 'show');
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    command: 'synthesisError',
                    error: 'DeepMind API Offline',
                    isFallingBack: false
                }
            }));
            // Flush dynamic import() microtasks in CommandDispatcher.SYNTHESIS_ERROR
            await new Promise(resolve => setTimeout(resolve, 10));
            
            expect(toastSpy).toHaveBeenCalledWith('DeepMind API Offline', 'error');
        });
    });

    // --- ⌨️ INTERACTION & HOTKEY TESTS (Expected to Fail Currently) ---
    describe('Global Interactions', () => {
        it('should toggle play/pause when Space is pressed', () => {
            const event = new KeyboardEvent('keydown', { 
                key: ' ', 
                code: 'Space', 
                bubbles: true,
                cancelable: true 
            });
            window.dispatchEvent(event);
            
            expect(mockVscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                command: OutgoingAction.PLAY
            }));
        });

        it('should ignore hotkeys when user is focused on the search box', () => {
            const search = document.getElementById('voice-search') as HTMLElement;
            search.focus();
            
            const event = new KeyboardEvent('keydown', { code: 'ArrowRight' });
            window.dispatchEvent(event);
            
            expect(mockVscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
                command: OutgoingAction.NEXT_SENTENCE
            }));
        });
    });
});
