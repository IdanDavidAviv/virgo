import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { MessageClient } from '../../src/webview/core/MessageClient';
import { CommandDispatcher } from '../../src/webview/core/CommandDispatcher';
import { InteractionManager } from '../../src/webview/core/InteractionManager';
import { LayoutManager } from '../../src/webview/core/LayoutManager';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';
import { IncomingCommand, OutgoingAction } from '../../src/common/types';

// Components
import { SettingsDrawer } from '../../src/webview/components/SettingsDrawer';
import { PlaybackControls } from '../../src/webview/components/PlaybackControls';
import { FileContext } from '../../src/webview/components/FileContext';
import { VoiceSelector } from '../../src/webview/components/VoiceSelector';

/**
 * @vitest-environment jsdom
 */

// ─── Full DOM Scaffold ───────────────────────────────────────────────────────
const FULL_DOM = `
    <div id="settings-drawer" class="settings-drawer"></div>
    <span id="settings-toggle" class="settings-toggle-btn">⚙</span>
    <div class="engine-toggle-group" style="display:none"></div>

    <button id="btn-play"></button>
    <button id="btn-pause" style="display:none"></button>
    <button id="btn-stop"></button>
    <button id="btn-prev"></button>
    <button id="btn-next"></button>
    <button id="btn-prev-sentence"></button>
    <button id="btn-next-sentence"></button>
    <button id="btn-autoplay" class="ctrl-btn toggle active" data-active="true">AUTO</button>
    <div id="status-dot" class="status-dot-mini"></div>

    <div class="context-slot selection">
        <button id="btn-load-file"></button>
        <span id="active-filename"></span>
        <span id="active-dir"></span>
    </div>
    <div class="context-slot reader">
        <button id="btn-clear-reader"></button>
        <span id="reader-filename"></span>
        <span id="reader-dir"></span>
    </div>

    <div id="sentence-navigator"></div>
    <div id="sentence-prev"></div>
    <div id="sentence-current"></div>
    <div id="sentence-next"></div>

    <div id="chapter-list"></div>
    <span id="sentence-progress"></span>
    <span id="chapter-progress"></span>

    <input id="volume-slider" type="range" min="0" max="100" value="50">
    <input id="rate-slider" type="range" min="-10" max="10" value="0">
    <span id="volume-val"></span>
    <span id="rate-val"></span>
    <button id="engine-neural"></button>
    <button id="engine-local"></button>
    <span id="cache-debug-tag"></span>
    <span id="state-debug-tag"></span>

    <div id="voice-list-container" class="voice-list-container"></div>
    <input id="voice-search" type="text">

    <div id="toast-container"></div>
    <audio id="neural-player"></audio>
`;

describe('Read Aloud Integration v3 (Full Stability & Parity)', () => {
    let store: WebviewStore;
    let client: MessageClient;
    let dispatcher: CommandDispatcher;

    beforeEach(() => {
        // 1. Reset all singletons
        WebviewStore.resetInstance();
        MessageClient.resetInstance();
        CommandDispatcher.resetInstance();
        LayoutManager.resetInstance();
        InteractionManager.resetInstance();
        WebviewAudioEngine.resetInstance();

        // 2. Full DOM scaffold
        document.body.innerHTML = FULL_DOM;

        // 3. Polyfill Audio for JSDOM
        if (!global.Audio) {
            (global as any).Audio = class {
                play = vi.fn().mockResolvedValue(undefined);
                pause = vi.fn();
                load = vi.fn();
                addEventListener = vi.fn();
                removeEventListener = vi.fn();
                setAttribute = vi.fn();
                removeAttribute = vi.fn();
                src = '';
                volume = 1;
                playbackRate = 1;
                id = '';
                onplay: any = null;
                onended: any = null;
                onerror: any = null;
            };
        }

        // Mock HTMLMediaElement prototype methods
        vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
        vi.spyOn(window.HTMLMediaElement.prototype, 'load').mockImplementation(() => {});

        store = WebviewStore.getInstance();
        client = MessageClient.getInstance();
        dispatcher = CommandDispatcher.getInstance();

        // Mock postAction globally for all tests
        vi.spyOn(client, 'postAction').mockImplementation(() => {});

        // ─── Global Store Hydration ───────────────────────────────────────────
        // The store is null until the first updateState() call (by design).
        // Hydrate with minimal defaults so patchState/getState() work in all suites.
        store.updateState({
            isPlaying: false,
            isPaused: false,
            playbackStalled: false,
            autoPlayMode: 'auto',
            engineMode: 'local',
            currentSentences: [{ text: 'Hello', key: 's1' }],
            allChapters: [{ title: 'C1', index: 0, sentences: [{ text: 'Hello', key: 's1' }] }],
            currentText: '',
            totalChapters: 0,
            canPrevChapter: false,
            canNextChapter: false,
            canPrevSentence: false,
            canNextSentence: false,
            availableVoices: { local: [], neural: [] },
            cacheCount: 0,
            cacheSizeBytes: 0,
            state: {
                focusedFileName: '',
                focusedRelativeDir: '',
                focusedDocumentUri: null,
                focusedIsSupported: false,
                activeFileName: '',
                activeRelativeDir: '',
                activeDocumentUri: null,
                currentChapterIndex: 0,
                currentSentenceIndex: 0,
                isRefreshing: false,
                isPreviewing: false
            }
        } as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ─── Helper Factories ────────────────────────────────────────────────────

    function mountSettingsDrawer() {
        const drawer = new SettingsDrawer({
            drawer: document.getElementById('settings-drawer') as HTMLElement,
            btnOpen: document.getElementById('settings-toggle') as HTMLElement,
            volumeSlider: document.getElementById('volume-slider') as HTMLInputElement,
            rateSlider: document.getElementById('rate-slider') as HTMLInputElement,
            btnCloudEngine: document.getElementById('engine-neural') as HTMLButtonElement,
            btnLocalEngine: document.getElementById('engine-local') as HTMLButtonElement,
            rateVal: document.getElementById('rate-val'),
            volumeVal: document.getElementById('volume-val'),
            cacheDebugTag: document.getElementById('cache-debug-tag') as HTMLElement,
            stateDebugTag: document.getElementById('state-debug-tag') as HTMLElement,
            engineToggleGroup: document.querySelector('.engine-toggle-group')
        });
        drawer.mount();
        return drawer;
    }

    function mountPlaybackControls() {
        const controls = new PlaybackControls({
            btnPlay: document.getElementById('btn-play') as HTMLButtonElement,
            btnPause: document.getElementById('btn-pause') as HTMLButtonElement,
            btnStop: document.getElementById('btn-stop') as HTMLButtonElement,
            btnPrev: document.getElementById('btn-prev') as HTMLButtonElement,
            btnNext: document.getElementById('btn-next') as HTMLButtonElement,
            btnPrevSentence: document.getElementById('btn-prev-sentence') as HTMLButtonElement,
            btnNextSentence: document.getElementById('btn-next-sentence') as HTMLButtonElement,
            btnAutoplay: document.getElementById('btn-autoplay') as HTMLButtonElement,
            waveContainer: document.getElementById('sentence-navigator') as HTMLElement,
            statusDot: document.getElementById('status-dot') as HTMLElement
        });
        controls.mount();
        return controls;
    }

    function mountFileContext() {
        const context = new FileContext({
            activeSlot: document.querySelector('.context-slot.selection') as HTMLElement,
            readerSlot: document.querySelector('.context-slot.reader') as HTMLElement,
            activeFilename: document.getElementById('active-filename') as HTMLElement,
            activeDir: document.getElementById('active-dir') as HTMLElement,
            readerFilename: document.getElementById('reader-filename') as HTMLElement,
            readerDir: document.getElementById('reader-dir') as HTMLElement,
            btnLoadFile: document.getElementById('btn-load-file') as HTMLButtonElement,
            btnClearReader: document.getElementById('btn-clear-reader') as HTMLButtonElement
        });
        context.mount();
        return context;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 1: Settings Drawer
    // ─────────────────────────────────────────────────────────────────────────
    describe('Suite 1: Settings Drawer', () => {
        it('T1.1 — should toggle the drawer open on ⚙ click', () => {
            mountSettingsDrawer();
            const toggle = document.getElementById('settings-toggle')!;
            const drawer = document.getElementById('settings-drawer')!;

            expect(drawer.classList.contains('open')).toBe(false);
            toggle.click();
            expect(drawer.classList.contains('open')).toBe(true);
        });

        it('T1.2 — should toggle the drawer closed on second ⚙ click', () => {
            mountSettingsDrawer();
            const toggle = document.getElementById('settings-toggle')!;
            const drawer = document.getElementById('settings-drawer')!;

            toggle.click();
            toggle.click(); // <-- close
            expect(drawer.classList.contains('open')).toBe(false);
        });

        it('T1.3 — should update rate display on volume store change', () => {
            mountSettingsDrawer();
            store.patchState({ volume: 75 });
            expect(document.getElementById('volume-val')!.textContent).toBe('75%');
        });

        it('T1.4 — should update rate display on rate store change', () => {
            mountSettingsDrawer();
            store.patchState({ rate: 5 });
            expect(document.getElementById('rate-val')!.textContent).toBe('1.5x');
        });

        it('T1.5 — should mark engine-neural as active when engineMode is neural', () => {
            mountSettingsDrawer();
            store.patchState({ engineMode: 'neural' });
            expect(document.getElementById('engine-neural')!.classList.contains('active')).toBe(true);
            expect(document.getElementById('engine-local')!.classList.contains('active')).toBe(false);
        });

        it('T1.6 — should post ENGINE_MODE_CHANGED when neural engine button is clicked', () => {
            mountSettingsDrawer();
            document.getElementById('engine-neural')!.click();
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.ENGINE_MODE_CHANGED, { mode: 'neural' });
        });

        it('T1.7 — should post ENGINE_MODE_CHANGED when local engine button is clicked', () => {
            mountSettingsDrawer();
            document.getElementById('engine-local')!.click();
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.ENGINE_MODE_CHANGED, { mode: 'local' });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 2: Playback Controls — Button Matrix
    // ─────────────────────────────────────────────────────────────────────────
    describe('Suite 2: Playback Controls — Button Matrix', () => {
        it('T2.1 — PLAY button posts OutgoingAction.PLAY with metadata', () => {
            mountPlaybackControls();
            document.getElementById('btn-play')!.click();
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.PLAY, 
                expect.objectContaining({ cacheKey: expect.any(String) })
            );
        });

        it('T2.2 — PAUSE button posts OutgoingAction.PAUSE', () => {
            mountPlaybackControls();
            document.getElementById('btn-pause')!.click();
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.PAUSE);
        });

        it('T2.3 — STOP button posts OutgoingAction.STOP', () => {
            mountPlaybackControls();
            document.getElementById('btn-stop')!.click();
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.STOP);
        });

        it('T2.4 — PREV CHAPTER button posts OutgoingAction.PREV_CHAPTER', () => {
            mountPlaybackControls();
            document.getElementById('btn-prev')!.click();
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.PREV_CHAPTER);
        });

        it('T2.5 — NEXT CHAPTER button posts OutgoingAction.NEXT_CHAPTER', () => {
            mountPlaybackControls();
            document.getElementById('btn-next')!.click();
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.NEXT_CHAPTER);
        });

        it('T2.6 — PREV SENTENCE button posts OutgoingAction.PREV_SENTENCE', () => {
            mountPlaybackControls();
            document.getElementById('btn-prev-sentence')!.click();
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.PREV_SENTENCE);
        });

        it('T2.7 — NEXT SENTENCE button posts OutgoingAction.NEXT_SENTENCE', () => {
            mountPlaybackControls();
            document.getElementById('btn-next-sentence')!.click();
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.NEXT_SENTENCE);
        });

        it('T2.8 — AUTOPLAY button cycles from auto → chapter and posts SET_AUTO_PLAY_MODE', () => {
            mountPlaybackControls();
            store.patchState({ autoPlayMode: 'auto' });
            document.getElementById('btn-autoplay')!.click();
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.SET_AUTO_PLAY_MODE, { mode: 'chapter' });
        });

        it('T2.9 — AUTOPLAY button cycles from chapter → row', () => {
            mountPlaybackControls();
            store.patchState({ autoPlayMode: 'chapter' });
            document.getElementById('btn-autoplay')!.click();
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.SET_AUTO_PLAY_MODE, { mode: 'row' });
        });

        it('T2.10 — AUTOPLAY button cycles from row → auto', () => {
            mountPlaybackControls();
            store.patchState({ autoPlayMode: 'row' });
            document.getElementById('btn-autoplay')!.click();
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.SET_AUTO_PLAY_MODE, { mode: 'auto' });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 3: Playback Controls — State-Reactive UI
    // ─────────────────────────────────────────────────────────────────────────
    describe('Suite 3: Playback Controls — Reactive State', () => {
        it('T3.1 — Should show PAUSE button and hide PLAY when isPlaying=true, isPaused=false', () => {
            mountPlaybackControls();
            dispatcher.dispatch(IncomingCommand.PLAYBACK_STATE_CHANGED, { isPlaying: true, isPaused: false });
            expect(document.getElementById('btn-play')!.style.display).toBe('none');
            expect(document.getElementById('btn-pause')!.style.display).toBe('inline-block');
        });

        it('T3.2 — Should show PLAY button and hide PAUSE when paused', () => {
            mountPlaybackControls();
            dispatcher.dispatch(IncomingCommand.PLAYBACK_STATE_CHANGED, { isPlaying: true, isPaused: true });
            expect(document.getElementById('btn-play')!.style.display).toBe('inline-block');
            expect(document.getElementById('btn-pause')!.style.display).toBe('none');
        });

        it('T3.3 — Status dot gets "online" class when actively playing', () => {
            mountPlaybackControls();
            store.patchState({ isPlaying: true, isPaused: false });
            const dot = document.getElementById('status-dot')!;
            expect(dot.classList.contains('online')).toBe(true);
        });

        it('T3.4 — Status dot loses "online" class when stopped', () => {
            mountPlaybackControls();
            store.patchState({ isPlaying: true, isPaused: false });
            store.patchState({ isPlaying: false, isPaused: false });
            const dot = document.getElementById('status-dot')!;
            expect(dot.classList.contains('online')).toBe(false);
        });

        it('T3.5 — Status dot gets "stalled" class when playbackStalled=true', () => {
            mountPlaybackControls();
            store.patchState({ isPlaying: true, isPaused: false, playbackStalled: true });
            const dot = document.getElementById('status-dot')!;
            expect(dot.classList.contains('stalled')).toBe(true);
        });

        it('T3.6 — Autoplay button visual updates to "1 CH" mode-chapter on chapter mode', () => {
            mountPlaybackControls();
            store.patchState({ autoPlayMode: 'chapter' });
            const btn = document.getElementById('btn-autoplay')!;
            expect(btn.textContent).toBe('1 CH');
            expect(btn.classList.contains('mode-chapter')).toBe(true);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 4: Keyboard Shortcuts
    // ─────────────────────────────────────────────────────────────────────────
    describe('Suite 4: Keyboard Shortcuts', () => {
        it('T4.1 — Space key triggers PLAY when currently stopped', () => {
            const interaction = InteractionManager.getInstance();
            interaction.mount();
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.PLAY, 
                expect.objectContaining({ cacheKey: expect.any(String) })
            );
        });

        it('T4.2 — ArrowLeft triggers PREV_SENTENCE', () => {
            const interaction = InteractionManager.getInstance();
            interaction.mount();
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', bubbles: true }));
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.PREV_SENTENCE);
        });

        it('T4.3 — ArrowRight triggers NEXT_SENTENCE', () => {
            const interaction = InteractionManager.getInstance();
            interaction.mount();
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.NEXT_SENTENCE);
        });

        it('T4.4 — ArrowUp triggers PREV_CHAPTER', () => {
            const interaction = InteractionManager.getInstance();
            interaction.mount();
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.PREV_CHAPTER);
        });

        it('T4.5 — ArrowDown triggers NEXT_CHAPTER', () => {
            const interaction = InteractionManager.getInstance();
            interaction.mount();
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true }));
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.NEXT_CHAPTER);
        });

        it('T4.6 — Repeat guard: second immediate ArrowRight is suppressed', () => {
            const interaction = InteractionManager.getInstance();
            interaction.mount();
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
            // Only one call should go through within the 100ms throttle window
            const calls = (client.postAction as ReturnType<typeof vi.fn>).mock.calls.filter(
                ([action]) => action === OutgoingAction.NEXT_SENTENCE
            );
            expect(calls).toHaveLength(1);
        });

        it('T4.7 — e.repeat guard: auto-repeat keydown events are suppressed', () => {
            const interaction = InteractionManager.getInstance();
            interaction.mount();
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', repeat: true, bubbles: true }));
            expect(client.postAction).not.toHaveBeenCalledWith(OutgoingAction.NEXT_SENTENCE);
        });

        it('T4.8 — Escape key closes settings drawer via LayoutManager', () => {
            const drawer = mountSettingsDrawer();
            // Must register with LayoutManager so closeOverlays() can reach it
            LayoutManager.getInstance().registerSettings(drawer);
            drawer.open();
            expect(document.getElementById('settings-drawer')!.classList.contains('open')).toBe(true);

            const interaction = InteractionManager.getInstance();
            interaction.mount();
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
            expect(document.getElementById('settings-drawer')!.classList.contains('open')).toBe(false);
        });

        it('T4.9 — Shortcut is suppressed when an input field is focused', () => {
            const interaction = InteractionManager.getInstance();
            interaction.mount();
            const input = document.getElementById('voice-search') as HTMLInputElement;
            input.focus();
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
            expect(client.postAction).not.toHaveBeenCalledWith(OutgoingAction.NEXT_SENTENCE);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 5: File Loading Lifecycle
    // ─────────────────────────────────────────────────────────────────────────
    describe('Suite 5: File Loading Lifecycle', () => {
        it('T5.1 — LOAD FILE button posts LOAD_DOCUMENT when a focused file exists', () => {
            mountFileContext();
            dispatcher.dispatch(IncomingCommand.UI_SYNC, {
                state: {
                    focusedFileName: 'test.md',
                    focusedRelativeDir: '/docs',
                    focusedDocumentUri: 'file:///docs/test.md',
                    focusedIsSupported: true,
                    activeFileName: '',
                    activeRelativeDir: '',
                    activeDocumentUri: null,
                    currentChapterIndex: 0,
                    currentSentenceIndex: 0,
                    isRefreshing: false,
                    isPreviewing: false
                }
            } as any);

            document.getElementById('btn-load-file')!.click();
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.LOAD_DOCUMENT, undefined);
        });

        it('T5.2 — CLEAR READER button posts RESET_CONTEXT', () => {
            mountFileContext();
            const btn = document.getElementById('btn-clear-reader') as HTMLButtonElement;
            expect(btn).not.toBeNull();
            btn.click();
            // BaseComponent.postAction calls MessageClient.getInstance().postAction
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.RESET_CONTEXT, undefined);
        });

        it('T5.3 — Active filename updates when UI_SYNC delivers focusedFileName', () => {
            mountFileContext();
            dispatcher.dispatch(IncomingCommand.UI_SYNC, {
                state: {
                    focusedFileName: 'README.md',
                    focusedRelativeDir: '/src',
                    focusedDocumentUri: 'file:///src/README.md',
                    focusedIsSupported: true,
                    activeFileName: '',
                    activeRelativeDir: '',
                    activeDocumentUri: null,
                    currentChapterIndex: 0,
                    currentSentenceIndex: 0,
                    isRefreshing: false,
                    isPreviewing: false
                }
            } as any);
            expect(document.getElementById('active-filename')!.textContent).toBe('README.md');
        });

        it('T5.4 — Global file link click delegates OPEN_FILE with uri', () => {
            const interaction = InteractionManager.getInstance();
            interaction.mount();

            const link = document.createElement('a');
            link.className = 'file-link';
            link.dataset.uri = 'file:///path/to/extra.md';
            link.href = 'file:///path/to/extra.md';
            link.textContent = 'Linked File';
            document.body.appendChild(link);

            link.click();
            expect(client.postAction).toHaveBeenCalledWith(OutgoingAction.OPEN_FILE, {
                uri: 'file:///path/to/extra.md'
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 6: Voice Selector & Filtering
    // ─────────────────────────────────────────────────────────────────────────
    describe('Suite 6: Voice Selector & Filtering', () => {
        const MOCK_VOICES = [
            { name: 'Microsoft David', lang: 'en-US' },
            { name: 'Microsoft Zira', lang: 'en-US' },
            { name: 'Google Deutsch', lang: 'de-DE' },
        ];

        it('T6.1 — Voice list renders all voices on VOICES command', async () => {
            const selector = new VoiceSelector({
                voiceList: document.getElementById('voice-list-container') as HTMLElement,
                searchInput: document.getElementById('voice-search') as HTMLInputElement
            });
            selector.mount();

            await dispatcher.dispatch(IncomingCommand.VOICES, {
                voices: MOCK_VOICES,
                neuralVoices: []
            });

            const container = document.getElementById('voice-list-container')!;
            expect(container.querySelectorAll('.voice-item').length).toBe(3);
        });

        it('T6.2 — Voice list filters on search input', async () => {
            const selector = new VoiceSelector({
                voiceList: document.getElementById('voice-list-container') as HTMLElement,
                searchInput: document.getElementById('voice-search') as HTMLInputElement
            });
            selector.mount();

            await dispatcher.dispatch(IncomingCommand.VOICES, {
                voices: MOCK_VOICES,
                neuralVoices: []
            });

            const searchInput = document.getElementById('voice-search') as HTMLInputElement;
            searchInput.value = 'Deutsch';
            searchInput.dispatchEvent(new Event('input'));

            // VoiceSelector re-renders only the filtered subset (no display:none logic)
            const container = document.getElementById('voice-list-container')!;
            const items = container.querySelectorAll('.voice-item');
            expect(items.length).toBe(1);
            expect(items[0].textContent).toContain('Google Deutsch');
        });

        it('T6.3 — Clicking a voice item posts VOICE_CHANGED action', async () => {
            const VOICES_WITH_ID = [
                { name: 'Microsoft David', lang: 'en-US', id: 'david' },
                { name: 'Microsoft Zira', lang: 'en-US', id: 'zira' },
            ];
            const selector = new VoiceSelector({
                voiceList: document.getElementById('voice-list-container') as HTMLElement,
                searchInput: document.getElementById('voice-search') as HTMLInputElement
            });
            selector.mount();

            await dispatcher.dispatch(IncomingCommand.VOICES, {
                voices: VOICES_WITH_ID,
                neuralVoices: []
            });

            const firstVoice = document.getElementById('voice-list-container')!.querySelector('.voice-item') as HTMLElement;
            firstVoice.click();
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.VOICE_CHANGED,
                { voice: 'david' }
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 7: IPC Command Dispatcher
    // ─────────────────────────────────────────────────────────────────────────
    describe('Suite 7: IPC Command Dispatcher', () => {
        it('T7.1 — UI_SYNC hydrates store with isPlaying=true', async () => {
            await dispatcher.dispatch(IncomingCommand.UI_SYNC, {
                isPlaying: true,
                isPaused: false,
                state: {
                    currentChapterIndex: 2,
                    currentSentenceIndex: 5,
                    focusedFileName: '',
                    focusedRelativeDir: '',
                    focusedDocumentUri: null,
                    focusedIsSupported: false,
                    activeFileName: '',
                    activeRelativeDir: '',
                    activeDocumentUri: null,
                    isRefreshing: false,
                    isPreviewing: false
                }
            } as any);
            expect(store.getState()?.isPlaying).toBe(true);
        });

        it('T7.2 — STOP command sets isPlaying=false in store', async () => {
            store.patchState({ isPlaying: true });
            await dispatcher.dispatch(IncomingCommand.STOP, null);
            expect(store.getState()?.isPlaying).toBe(false);
        });

        it('T7.3 — PURGE_MEMORY command calls audioEngine.purgeMemory()', async () => {
            const engine = WebviewAudioEngine.getInstance();
            const purgeSpy = vi.spyOn(engine, 'purgeMemory').mockImplementation(() => {});
            await dispatcher.dispatch(IncomingCommand.PURGE_MEMORY, null);
            expect(purgeSpy).toHaveBeenCalled();
        });

        it('T7.4 — VOICES command updates availableVoices in store', async () => {
            await dispatcher.dispatch(IncomingCommand.VOICES, {
                voices: [{ name: 'LocalVoice', lang: 'en' }],
                neuralVoices: [{ name: 'NeuralVoice', lang: 'en' }],
                engineMode: 'local'
            });
            const voices = store.getState()?.availableVoices;
            expect(voices?.local).toHaveLength(1);
            expect(voices?.neural).toHaveLength(1);
        });

        it('T7.5 — SYNTHESIS_ERROR shows a Toast (does not crash)', async () => {
            // Should not throw
            await expect(
                dispatcher.dispatch(IncomingCommand.SYNTHESIS_ERROR, {
                    error: 'TTS service unavailable',
                    isFallingBack: true
                })
            ).resolves.not.toThrow();
        });

        it('T7.6 — PLAYBACK_STATE_CHANGED updates isPlaying and isPaused', async () => {
            await dispatcher.dispatch(IncomingCommand.PLAYBACK_STATE_CHANGED, {
                isPlaying: false,
                isPaused: false
            });
            expect(store.getState()?.isPlaying).toBe(false);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 8: Store Integrity
    // ─────────────────────────────────────────────────────────────────────────
    describe('Suite 8: Store Integrity & Default State', () => {
        // The store requires a UI_SYNC hydration before getState() returns non-null.
        // This mirrors real production behavior where the extension sends UI_SYNC on load.
        const HYDRATION_PACKET = {
            isPlaying: false,
            isPaused: false,
            playbackStalled: false,
            autoPlayMode: 'auto',
            engineMode: 'local',
            currentSentences: [],
            allChapters: [],
            currentText: '',
            totalChapters: 0,
            canPrevChapter: false,
            canNextChapter: false,
            canPrevSentence: false,
            canNextSentence: false,
            availableVoices: { local: [], neural: [] },
            cacheCount: 0,
            cacheSizeBytes: 0,
            // rate/volume intentionally omitted to verify normalization defaults
            state: {
                focusedFileName: '',
                focusedRelativeDir: '',
                focusedDocumentUri: null,
                focusedIsSupported: false,
                activeFileName: '',
                activeRelativeDir: '',
                activeDocumentUri: null,
                currentChapterIndex: 0,
                currentSentenceIndex: 0,
                isRefreshing: false,
                isPreviewing: false
            }
        } as any;

        beforeEach(() => {
            store.updateState(HYDRATION_PACKET);
        });

        it('T8.1 — After hydration, rate defaults to 0 (normalized by updateState)', () => {
            expect(store.getState()?.rate).toBe(0);
        });

        it('T8.2 — After hydration, volume defaults to 50 (normalized by updateState)', () => {
            expect(store.getState()?.volume).toBe(50);
        });

        it('T8.3 — After hydration, isPlaying is false', () => {
            expect(store.getState()?.isPlaying).toBe(false);
        });

        it('T8.4 — After hydration, autoPlayMode is auto', () => {
            expect(store.getState()?.autoPlayMode).toBe('auto');
        });

        it('T8.5 — patchState merges without clobbering other fields', () => {
            store.patchState({ volume: 80 });
            store.patchState({ rate: 3 });
            expect(store.getState()?.volume).toBe(80);
            expect(store.getState()?.rate).toBe(3);
        });

        it('T8.6 — subscribe callback fires on relevant slice change', () => {
            const cb = vi.fn();
            store.subscribe((s) => s.volume, cb);
            cb.mockClear(); // ignore the subscription initial call if any
            store.patchState({ volume: 60 });
            expect(cb).toHaveBeenCalledWith(60);
        });

        it('T8.7 — subscribe callback does NOT fire when unrelated slice changes', () => {
            const cb = vi.fn();
            store.subscribe((s) => s.volume, cb);
            cb.mockClear();
            store.patchState({ rate: 2 });
            expect(cb).not.toHaveBeenCalled();
        });
    });
});
