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
import { SnippetLookup } from '../../src/webview/components/SnippetLookup';

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
        <div class="mode-toggles">
            <button id="btn-mode-file"></button>
            <button id="btn-mode-snippet"></button>
        </div>
        <div id="file-mode-container">
            <button id="btn-clear-reader"></button>
            <span id="reader-filename"></span>
            <span id="reader-dir"></span>
        </div>
        <div id="snippet-lookup-container" style="display:none"></div>
        <div id="transfer-layer"></div>
    </div>

    <div id="sentence-navigator"></div>
    <div id="sentence-prev"></div>
    <div id="sentence-current"></div>
    <div id="sentence-next"></div>

    <div id="chapter-list"></div>
    <span id="sentence-progress"></span>
    <span id="chapter-progress"></span>

    <input id="volume-slider" type="range" min="0" max="100" value="50">
    <input id="rate-slider" type="range" min="0.5" max="2.0" value="1.0" step="0.05">
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
        PlaybackController.resetInstance();
        CommandDispatcher.resetInstance();
        LayoutManager.resetInstance();
        InteractionManager.resetInstance();
        WebviewAudioEngine.resetInstance();

        // 2. Full DOM scaffold
        document.body.innerHTML = FULL_DOM;

        // Mock HTMLMediaElement prototype methods
        vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => { });
        vi.spyOn(window.HTMLMediaElement.prototype, 'load').mockImplementation(() => { });

        store = WebviewStore.getInstance();
        store.updateState({
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
            isPreviewing: false,
            isPlaying: false,
            isPaused: false,
            rate: 1.0,
            volume: 50,
            autoPlayMode: 'auto',
            engineMode: 'local',
            availableVoices: { local: [], neural: [] }
        } as any);
        client = MessageClient.getInstance();
        dispatcher = CommandDispatcher.getInstance();

        // Mock postAction globally for all tests
        vi.spyOn(client, 'postAction').mockImplementation(() => { });

        // ─── Global Store Hydration ───────────────────────────────────────────
        // The store is null until the first updateState() call (by design).
        // Hydrate with full defaults so patchState/getState() work in all suites.
        store.updateState({
            ...DEFAULT_SYNC_PACKET,
            currentSentences: ['Hello'],
            allChapters: [{ title: 'C1', level: 1, index: 0, count: 1 }],
            focusedIsSupported: true
        });
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
            btnResetContext: document.getElementById('btn-clear-reader') as HTMLButtonElement,
            btnModeFile: document.getElementById('btn-mode-file') as HTMLButtonElement,
            btnModeSnippet: document.getElementById('btn-mode-snippet') as HTMLButtonElement,
            fileModeContainer: document.getElementById('file-mode-container') as HTMLElement,
            snippetLookupContainer: document.getElementById('snippet-lookup-container') as HTMLElement,
            transferLayer: document.getElementById('transfer-layer') as HTMLElement
        });
        context.mount();
        return context;
    }

    function mountSnippetLookup() {
        const lookup = new SnippetLookup({
            container: document.getElementById('snippet-lookup-container') as HTMLElement
        });
        lookup.mount();
        return lookup;
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
            expect(document.getElementById('rate-val')!.textContent).toBe('5.0x');
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
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.ENGINE_MODE_CHANGED, 
                expect.objectContaining({ mode: 'neural', intentId: expect.any(Number) })
            );
        });

        it('T1.7 — should post ENGINE_MODE_CHANGED when local engine button is clicked', () => {
            mountSettingsDrawer();
            document.getElementById('engine-local')!.click();
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.ENGINE_MODE_CHANGED, 
                expect.objectContaining({ mode: 'local', intentId: expect.any(Number) })
            );
        });

        it('T1.8 — rate slider input event patches store with the slider value', () => {
            mountSettingsDrawer();
            const slider = document.getElementById('rate-slider') as HTMLInputElement;
            // Simulate user dragging slider to 1.5x (within 0.5–2.0 range)
            slider.value = '1.5';
            slider.dispatchEvent(new Event('input'));
            expect(store.getState()?.rate).toBe(1.5);
        });

        it('T1.9 — rate slider change event (mouse release) emits RATE_CHANGED via postAction', () => {
            vi.useFakeTimers();
            mountSettingsDrawer();
            const slider = document.getElementById('rate-slider') as HTMLInputElement;
            // Simulate committed change (mouseup / touch end)
            slider.value = '1.5';
            slider.dispatchEvent(new Event('change'));
            // Flush the 150ms debounce in PlaybackController.debouncedRateEmit
            vi.runAllTimers();
            vi.useRealTimers();
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.RATE_CHANGED,
                expect.objectContaining({ rate: 1.5, intentId: expect.any(Number) })
            );
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
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.PAUSE,
                expect.objectContaining({ intentId: expect.any(Number) })
            );
        });

        it('T2.3 — STOP button posts OutgoingAction.STOP', () => {
            mountPlaybackControls();
            document.getElementById('btn-stop')!.click();
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.STOP,
                expect.objectContaining({ intentId: expect.any(Number) })
            );
        });

        it('T2.4 — PREV CHAPTER button posts OutgoingAction.PREV_CHAPTER', () => {
            mountPlaybackControls();
            document.getElementById('btn-prev')!.click();
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.PREV_CHAPTER,
                expect.objectContaining({ intentId: expect.any(Number) })
            );
        });

        it('T2.5 — NEXT CHAPTER button posts OutgoingAction.NEXT_CHAPTER', () => {
            mountPlaybackControls();
            document.getElementById('btn-next')!.click();
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.NEXT_CHAPTER,
                expect.objectContaining({ intentId: expect.any(Number) })
            );
        });

        it('T2.6 — PREV SENTENCE button posts OutgoingAction.PREV_SENTENCE', () => {
            mountPlaybackControls();
            document.getElementById('btn-prev-sentence')!.click();
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.PREV_SENTENCE,
                expect.objectContaining({ intentId: expect.any(Number) })
            );
        });

        it('T2.7 — NEXT SENTENCE button posts OutgoingAction.NEXT_SENTENCE', () => {
            mountPlaybackControls();
            document.getElementById('btn-next-sentence')!.click();
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.NEXT_SENTENCE,
                expect.objectContaining({ intentId: expect.any(Number) })
            );
        });

        it('T2.8 — AUTOPLAY button cycles from auto → chapter and posts SET_AUTO_PLAY_MODE', () => {
            mountPlaybackControls();
            store.patchState({ autoPlayMode: 'auto' });
            document.getElementById('btn-autoplay')!.click();
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.SET_AUTO_PLAY_MODE, 
                expect.objectContaining({ mode: 'chapter', intentId: expect.any(Number) })
            );
        });

        it('T2.9 — AUTOPLAY button cycles from chapter → row', () => {
            mountPlaybackControls();
            store.patchState({ autoPlayMode: 'chapter' });
            document.getElementById('btn-autoplay')!.click();
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.SET_AUTO_PLAY_MODE, 
                expect.objectContaining({ mode: 'row', intentId: expect.any(Number) })
            );
        });

        it('T2.10 — AUTOPLAY button cycles from row → auto', () => {
            mountPlaybackControls();
            store.patchState({ autoPlayMode: 'row' });
            document.getElementById('btn-autoplay')!.click();
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.SET_AUTO_PLAY_MODE, 
                expect.objectContaining({ mode: 'auto', intentId: expect.any(Number) })
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 3: Playback Controls — State-Reactive UI
    // ─────────────────────────────────────────────────────────────────────────
    describe('Suite 3: Playback Controls — Reactive State', () => {
        it('T3.1 — Should show PAUSE button and hide PLAY when isPlaying=true, isPaused=false', async () => {
            mountPlaybackControls();
            await dispatcher.dispatch(IncomingCommand.PLAYBACK_STATE_CHANGED, { isPlaying: true, isPaused: false });
            await vi.waitFor(() => {
                expect(document.getElementById('btn-play')!.style.display).toBe('none');
                expect(document.getElementById('btn-pause')!.style.display).toBe('inline-block');
            });
        });

        it('T3.2 — Should show PLAY button and hide PAUSE when paused', async () => {
            mountPlaybackControls();
            await dispatcher.dispatch(IncomingCommand.PLAYBACK_STATE_CHANGED, { isPlaying: true, isPaused: true });
            await vi.waitFor(() => {
                expect(document.getElementById('btn-play')!.style.display).toBe('inline-block');
                expect(document.getElementById('btn-pause')!.style.display).toBe('none');
            });
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
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.PREV_SENTENCE,
                expect.objectContaining({ intentId: expect.any(Number) })
            );
        });

        it('T4.3 — ArrowRight triggers NEXT_SENTENCE', () => {
            const interaction = InteractionManager.getInstance();
            interaction.mount();
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.NEXT_SENTENCE,
                expect.objectContaining({ intentId: expect.any(Number) })
            );
        });

        it('T4.4 — ArrowUp triggers PREV_CHAPTER', () => {
            const interaction = InteractionManager.getInstance();
            interaction.mount();
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.PREV_CHAPTER,
                expect.objectContaining({ intentId: expect.any(Number) })
            );
        });

        it('T4.5 — ArrowDown triggers NEXT_CHAPTER', () => {
            const interaction = InteractionManager.getInstance();
            interaction.mount();
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true }));
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.NEXT_CHAPTER,
                expect.objectContaining({ intentId: expect.any(Number) })
            );
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
            } as any);

            document.getElementById('btn-load-file')!.click();
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.LOAD_DOCUMENT,
                expect.objectContaining({ intentId: expect.any(Number) })
            );
        });

        it('T5.2 — CLEAR READER button posts RESET_CONTEXT', () => {
            mountFileContext();
            const btn = document.getElementById('btn-clear-reader') as HTMLButtonElement;
            expect(btn).not.toBeNull();
            btn.click();
            // BaseComponent.postAction calls MessageClient.getInstance().postAction
            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.RESET_CONTEXT,
                expect.objectContaining({ intentId: expect.any(Number) })
            );
        });

        it('T5.3 — Active filename updates when UI_SYNC delivers focusedFileName', () => {
            mountFileContext();
            dispatcher.dispatch(IncomingCommand.UI_SYNC, {
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
                expect.objectContaining({ voice: 'david', intentId: expect.any(Number) })
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
            const purgeSpy = vi.spyOn(engine, 'purgeMemory').mockImplementation(() => Promise.resolve());
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
            isPreviewing: false,
            snippetHistory: [
                {
                    id: 'session-1',
                    sessionName: 'Session 1',
                    snippets: []
                }
            ]
        } as any;

        beforeEach(() => {
            store.updateState(HYDRATION_PACKET);
        });

        it('T8.1 — After hydration, rate defaults to 1.0 (normalized by updateState)', () => {
            expect(store.getState()?.rate).toBe(1.0);
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
    describe('Snippet Mode Integration (#2 Regression Guard)', () => {
        let fileContext: any;
        let snippetLookup: any;
        let elements: any;

        beforeEach(() => {
            fileContext = mountFileContext();
            snippetLookup = mountSnippetLookup();
            elements = {
                btnModeSnippet: document.getElementById('btn-mode-snippet') as HTMLButtonElement,
                btnModeFile: document.getElementById('btn-mode-file') as HTMLButtonElement,
                fileModeContainer: document.getElementById('file-mode-container') as HTMLElement,
                snippetLookupContainer: document.getElementById('snippet-lookup-container') as HTMLElement
            };
        });

        it('should enable Snippet Mode, discover history, and navigate to a specific snippet', async () => {
            // 0. Wire dispatcher (needed for ui-sync to reach store/components if using client, 
            // but we use dispatcher.dispatch directly which also works if store is registered)
            
            // 1. Initial State: Mode selection
            elements.btnModeSnippet.click();
            expect(elements.snippetLookupContainer.style.display).toBe('block');
            expect(elements.fileModeContainer.style.display).toBe('none');

            // 2. Mock full sync with snippet history
            const mockHistory = [
                { 
                    id: 'session-dna', 
                    sessionName: 'DNA Fix', 
                    snippets: [
                        { name: 'Fragment_A.md', fsPath: 'c:/Fragment_A.md', timestamp: Date.now() },
                        { name: 'Fragment_B.md', fsPath: 'c:/Fragment_B.md', timestamp: Date.now() }
                    ] 
                }
            ];

            dispatcher.dispatch(IncomingCommand.UI_SYNC, { 
                ...DEFAULT_SYNC_PACKET,
                snippetHistory: mockHistory,
                activeSessionId: 'session-dna',
                activeMode: 'SNIPPET'
            } as any);

            // 3. Verify session card rendered
            const sessionCard = elements.snippetLookupContainer.querySelector('.snippet-session-card') as HTMLElement;
            expect(sessionCard).not.toBeNull();
            expect(sessionCard.textContent).toContain('DNA Fix');
            expect(sessionCard.classList.contains('is-active')).toBe(true);
            expect(sessionCard.textContent).toContain('2 snippets');

            // 4. Navigate into session
            sessionCard.click();
            expect(elements.snippetLookupContainer.querySelector('.snippet-layer-snippets')).not.toBeNull();
            expect(elements.snippetLookupContainer.textContent).toContain('Fragment_A');
            expect(elements.snippetLookupContainer.textContent).toContain('Fragment_B');

            // 5. Verify icons assigned correctly (Generic icon for content snippets)
            const icons = elements.snippetLookupContainer.querySelectorAll('.snippet-icon');
            expect(icons[0].textContent).toBe('📝');
            expect(icons[1].textContent).toBe('📝');

            // 6. Select a snippet (should trigger IPC)
            const snippetItem = elements.snippetLookupContainer.querySelector('.snippet-item') as HTMLElement;
            snippetItem.click();

            expect(client.postAction).toHaveBeenCalledWith(
                OutgoingAction.LOAD_SNIPPET,
                expect.objectContaining({ path: 'c:/Fragment_A.md', intentId: expect.any(Number) })
            );

            // 7. Test Back Button
            const backBtn = elements.snippetLookupContainer.querySelector('.snippet-back-button') as HTMLElement;
            backBtn.click();
            expect(elements.snippetLookupContainer.querySelector('.snippet-layer-sessions')).not.toBeNull();
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 9: WebviewAudioEngine — Rate Mode Isolation
    // Verifies the Neural Guard: neural mode must NOT mutate audio.playbackRate
    // (rate is already baked into SSML prosody). Local mode MUST apply it.
    // ─────────────────────────────────────────────────────────────────────────
    describe('Suite 9: WebviewAudioEngine — Rate Mode Isolation', () => {
        // jsdom does not implement HTMLAudioElement.playbackRate as a real setter,
        // so vi.spyOn(HTMLAudioElement.prototype, 'playbackRate', 'set') silently no-ops.
        // The engine exposes its internal Audio instance via window.__AUDIO_ENGINE__.
        // We reify playbackRate as a trackable data descriptor on that specific instance
        // and verify writes directly.
        let writtenValues: number[];

        beforeEach(() => {
            WebviewAudioEngine.resetInstance();
            const engine = WebviewAudioEngine.getInstance(); // creates new instance, sets window.__AUDIO_ENGINE__
            const internalAudio = (engine as any)._audio as HTMLAudioElement;
            writtenValues = [];
            // Reify playbackRate as a trackable data descriptor
            Object.defineProperty(internalAudio, 'playbackRate', {
                get: () => writtenValues[writtenValues.length - 1] ?? 1.0,
                set: (v: number) => { writtenValues.push(v); },
                configurable: true,
            });
        });

        it('T9.1 — local mode: setRate() writes to audio.playbackRate', () => {
            store.patchState({ engineMode: 'local' });
            const engine = WebviewAudioEngine.getInstance();
            engine.setRate(2.0);
            expect(writtenValues).toContain(2.0);
        });

        it('T9.2 — neural mode: setRate() does NOT write to audio.playbackRate', () => {
            store.patchState({ engineMode: 'neural' });
            const engine = WebviewAudioEngine.getInstance();
            engine.setRate(3.0);
            expect(writtenValues).toHaveLength(0);
        });

        it('T9.3 — switching from neural to local re-enables playbackRate writes', () => {
            const engine = WebviewAudioEngine.getInstance();
            // Neural — must be suppressed
            store.patchState({ engineMode: 'neural' });
            engine.setRate(3.0);
            expect(writtenValues).toHaveLength(0);

            // Local — must be written
            store.patchState({ engineMode: 'local' });
            engine.setRate(1.5);
            expect(writtenValues).toContain(1.5);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 10 — Rate/Volume Application: State Inspection
// Verifies rate/volume flow by directly inspecting engine internals rather than
// console.log (which is captured by vitest and not spy-able reliably in jsdom).
// ─────────────────────────────────────────────────────────────────────────────
describe('Suite 10 — Rate/Volume Application Trace', () => {
    let engine: WebviewAudioEngine;
    // Suite 10 is outside the outer describe, so we access the store directly.
    const s10store = () => WebviewStore.getInstance();

    beforeEach(() => {
        s10store().patchState({ engineMode: 'local', rate: 1.0, volume: 50 });
        WebviewAudioEngine.resetInstance();
        engine = WebviewAudioEngine.getInstance();
    });

    afterEach(() => {
        engine?.dispose();
    });

    it('T10.1 — setRate() writes to audio.playbackRate in local mode', () => {
        const audio = (engine as any)._audio as HTMLAudioElement;
        // Reify into a trackable descriptor
        const written: number[] = [];
        Object.defineProperty(audio, 'playbackRate', {
            get: () => written[written.length - 1] ?? 1.0,
            set: (v: number) => written.push(v),
            configurable: true,
        });

        engine.setRate(1.75);
        expect(written).toContain(1.75);
    });

    it('T10.2 — store patchState(rate) → subscription → setRate → audio.playbackRate updated', () => {
        const audio = (engine as any)._audio as HTMLAudioElement;
        const written: number[] = [];
        Object.defineProperty(audio, 'playbackRate', {
            get: () => written[written.length - 1] ?? 1.0,
            set: (v: number) => written.push(v),
            configurable: true,
        });

        s10store().patchState({ rate: 1.75 });
        expect(written).toContain(1.75);
    });

    it('T10.3 — neural mode: store patchState(rate) does NOT mutate audio.playbackRate', () => {
        s10store().patchState({ engineMode: 'neural' });

        const audio = (engine as any)._audio as HTMLAudioElement;
        const written: number[] = [];
        Object.defineProperty(audio, 'playbackRate', {
            get: () => written[written.length - 1] ?? 1.0,
            set: (v: number) => written.push(v),
            configurable: true,
        });

        s10store().patchState({ rate: 1.5 });
        expect(written).toHaveLength(0); // Neural guard suppressed write
    });

    it('T10.4 — store.rate flows correctly: getState() returns patched rate for baking', () => {
        // SpeechSynthesisUtterance is not available in jsdom; test the upstream guarantee:
        // that after patchState({rate}), getState().rate returns the value that speakLocal
        // will bake into the utterance at line 306 of WebviewAudioEngine.ts.
        s10store().patchState({ rate: 1.5, volume: 60 });

        const state = s10store().getState();
        // Simulate the exact bake formulae from speakLocal (lines 306-307):
        const bakedRate = state.rate;           // utterance.rate = state.rate
        const bakedVolume = state.volume / 100; // utterance.volume = state.volume / 100

        expect(bakedRate).toBe(1.5);
        expect(bakedVolume).toBeCloseTo(0.60);
    });

    it('T10.5 — setVolume() applies to audio.volume (normalized to 0-1)', () => {
        const audio = (engine as any)._audio as HTMLAudioElement;
        engine.setVolume(75);
        expect(audio.volume).toBeCloseTo(0.75);
    });

    it('T10.6 — store patchState(volume) → subscription → setVolume → audio.volume updated', () => {
        const audio = (engine as any)._audio as HTMLAudioElement;
        s10store().patchState({ volume: 80 });
        expect(audio.volume).toBeCloseTo(0.80);
    });
});
