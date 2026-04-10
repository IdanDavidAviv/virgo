import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { MessageClient } from '../../src/webview/core/MessageClient';
import { PlaybackController } from '../../src/webview/playbackController';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';
import { vi } from 'vitest';

import { CommandDispatcher } from '../../src/webview/core/CommandDispatcher';
import { CacheManager } from '../../src/webview/cacheManager';
import { LayoutManager } from '../../src/webview/core/LayoutManager';
import { InteractionManager } from '../../src/webview/core/InteractionManager';

/**
 * Consolidated Authority for Webview DOM structure.
 * This should include ALL elements expected by bootstrap() and core components.
 */
export const FULL_DOM_TEMPLATE = `
    <div id="debug-mode-tag" style="display: none;"></div>
    <div id="toast-container"></div>
    
    <div id="settings-drawer" class="settings-drawer">
        <span id="settings-toggle">⚙</span>
        <button id="settings-close">X</button>
        <input id="volume-slider" type="range" min="0" max="100" value="50">
        <input id="rate-slider" type="range" min="0.1" max="10" value="1.0" step="0.1">
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
        <div id="sentence-navigator" class="sentence-navigator">
            <div id="sentence-prev"></div>
            <div id="sentence-current"></div>
            <div id="sentence-next"></div>
        </div>
    </div>

    <div class="context-slot selection active">
        <span id="active-filename"></span>
        <span id="active-dir"></span>
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
        <div id="transfer-layer" class="transfer-layer"></div>
    </div>

    <div id="voice-list-container">
        <ul id="voice-list"></ul>
    </div>
    <input id="voice-search" type="text">
    <div id="wave-container"></div>
    <audio id="neural-player"></audio>
`;

/**
 * Resets all webview-layer singletons to their default states.
 * This MUST be called in beforeEach() of every webview test to avoid state leakage.
 */
export function resetAllSingletons() {
    // 1. Hard purge window globals before and after resets
    if (typeof window !== 'undefined') {
        const win = window as any;
        delete win.vscode;
        delete win.acquireVsCodeApi;
        delete win.__BOOTSTRAP_CONFIG__;
        delete win.__MESSAGE_CLIENT__;
        delete win.__WEBVIEW_STORE__;
        delete win.__PLAYBACK_CONTROLLER__;
        delete win.__LAYOUT_MANAGER__;
        delete win.__INTERACTION_MANAGER__;
    }

    // [SOVEREIGNTY] Polyfill SpeechSynthesisUtterance for jsdom BEFORE singletons capture it
    if (typeof window !== 'undefined') {
        (window as any).SpeechSynthesisUtterance = class {
            text: string;
            volume = 1;
            rate = 1;
            onstart: (() => void) | null = null;
            onend: (() => void) | null = null;
            onerror: ((e: any) => void) | null = null;
            constructor(text: string) { this.text = text; }
        };
        (window as any).speechSynthesis = {
            speak: vi.fn((utterance: any) => {
                // Ensure events are dispatched to trigger resolve/release
                setTimeout(() => {
                    if (utterance.onstart) { utterance.onstart(); }
                    setTimeout(() => {
                        if (utterance.onend) { utterance.onend(); }
                    }, 10);
                }, 10);
            }),
            cancel: vi.fn(),
            pause: vi.fn(),
            resume: vi.fn(),
            getVoices: vi.fn(() => []),
            pending: false,
            speaking: false,
            paused: false
        };
    }

    WebviewStore.resetInstance();
    MessageClient.resetInstance();
    PlaybackController.resetInstance();
    WebviewAudioEngine.resetInstance();
    CommandDispatcher.resetInstance();
    CacheManager.resetInstance();
    LayoutManager.resetInstance();
    InteractionManager.resetInstance();

    // Reset vitest mocks
    vi.clearAllMocks();
    vi.restoreAllMocks();
}

import { IncomingCommand } from '@common/types';

/**
 * Wires the CommandDispatcher to the MessageClient, replicating the production event loop.
 * Essential for testing components that rely on state synchronization.
 */
export function wireDispatcher() {
    const client = MessageClient.getInstance();
    const dispatcher = CommandDispatcher.getInstance();

    client.onCommand(IncomingCommand.UI_SYNC, (data) => dispatcher.dispatch(IncomingCommand.UI_SYNC, data));
    client.onCommand(IncomingCommand.VOICES, (data) => dispatcher.dispatch(IncomingCommand.VOICES, data));
    client.onCommand(IncomingCommand.PLAYBACK_STATE_CHANGED, (data) => dispatcher.dispatch(IncomingCommand.PLAYBACK_STATE_CHANGED, data));
    client.onCommand(IncomingCommand.SENTENCE_CHANGED, (data) => dispatcher.dispatch(IncomingCommand.SENTENCE_CHANGED, data));
}

/**
 * Safely acquires the singleton instances after a reset.
 */
export function getCoreSystems() {
    return {
        store: WebviewStore.getInstance(),
        client: MessageClient.getInstance(),
        controller: PlaybackController.getInstance(),
        engine: WebviewAudioEngine.getInstance()
    };
}

import { UISyncPacket } from '../../src/common/types';

/**
 * Creates a valid, flat UISyncPacket for use in tests.
 */
export function createMockSyncPacket(overrides: Partial<UISyncPacket> = {}): UISyncPacket {
    return {
        // [SOVEREIGNTY] Intent Baselines
        playbackIntentId: 1,
        batchIntentId: 1,
        
        // FOCUSED
        focusedFileName: '',
        focusedRelativeDir: '',
        focusedDocumentUri: null,
        focusedIsSupported: true,

        // ACTIVE
        activeFileName: 'test.md',
        activeRelativeDir: '',
        activeDocumentUri: 'file:///test.md',

        // State Flags
        currentChapterIndex: 0,
        currentSentenceIndex: 0,
        isPlaying: false,
        isPaused: false,
        playbackStalled: false,
        isRefreshing: false,
        isPreviewing: false,
        isLooping: false,
        activeMode: 'FILE',
        engineMode: 'neural',
        autoPlayMode: 'auto',

        // Settings
        volume: 50,
        rate: 1.0,

        // Data
        availableVoices: { local: [], neural: [] },
        allChapters: [],
        currentSentences: [],
        
        // Stats
        cacheCount: 0,
        cacheSizeBytes: 0,
        logLevel: 1,
        isSelectingVoice: false,
        
        ...overrides
    };
}
