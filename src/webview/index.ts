import { WebviewStore } from './core/WebviewStore';
import { MessageClient } from './core/MessageClient';
import { CommandDispatcher } from './core/CommandDispatcher';
import { WebviewAudioEngine } from './core/WebviewAudioEngine';
import { InteractionManager } from './core/InteractionManager';
import { LayoutManager } from './core/LayoutManager';
import { IncomingCommand, OutgoingAction } from '../common/types';
import { CacheManager } from './cacheManager';
import { PlaybackController } from './playbackController';

// Global Stylesheet — essential for bundling
import './style.css';

/**
 * Polyfill atob/btoa for restricted environments (Issue #21)
 */
if (typeof atob === 'undefined') {
  (window as any).atob = (str: string) => Buffer.from(str, 'base64').toString('binary');
}

// UI Components
import { SentenceNavigator } from './components/SentenceNavigator';
import { PlaybackControls } from './components/PlaybackControls';
import { ChapterList } from './components/ChapterList';
import { SettingsDrawer } from './components/SettingsDrawer';
import { FileContext } from './components/FileContext';
import { VoiceSelector } from './components/VoiceSelector';
import { ToastManager } from './components/ToastManager';
import { SnippetLookup } from './components/SnippetLookup';



/**
 * Read Aloud Webview Entry Point (ESM/TS)
 * Replaces legacy dashboard.js with a modular, strictly-typed bootstrap.
 */
export function bootstrap() {
  const start = performance.now();
  console.log('[ReadAloud] 🚀 Initializing High-Integrity Webview Engine...');

  // Global Error Boundary (Issue #42)
  window.onerror = (msg, url, line, col) => {
    const errorDetail = `[ReadAloud] CRITICAL ERROR: ${msg} at ${line}:${col}`;
    console.error(errorDetail);
    MessageClient.getInstance().postAction(OutgoingAction.LOG, errorDetail);
  };

  try {
    // 1. Initialize Infrastructure (Singletons)
    const client = MessageClient.getInstance();
    const store = WebviewStore.getInstance();
    const audioEngine = WebviewAudioEngine.getInstance();
    // [FIX] PlaybackController must be eager-initialized BEFORE dispatcher.mount().
    // If lazy (first instantiation inside dispatch()), setupListeners() runs after mount()
    // already registered all catch-all handlers — creating a permanent duplicate subscription.
    const playback = PlaybackController.getInstance();
    const dispatcher = CommandDispatcher.getInstance();
    const interaction = InteractionManager.getInstance();
    const cache = CacheManager.getInstance();

    // 1.1 Link Infrastructure (Decoupled IPC wiring)
    client.attachCacheManager(cache);
    cache.ready().then(() => {
        console.log('[BOOT] 🗄️ Cache system ready.');
    }).catch(e => console.error('[BOOT] Cache initialization failed:', e));

    // Initialize Toasts early
    const toastContainer = document.getElementById('toast-container');
    if (toastContainer) {
      ToastManager.setContainer(toastContainer);
    }

    // Debug Mode Indicator (Serverless Handshake)
    const config = (window as any).__BOOTSTRAP_CONFIG__;
    if (config && config.debugMode) {
      const debugTag = document.getElementById('debug-mode-tag');
      if (debugTag) {
        debugTag.style.display = 'inline-block';
      }

      // [PARITY] Legacy dashboard.js state sync logging
      store.subscribe((state) => state.isPlaying, (isPlaying) => {
        console.log(`%c[WebviewStore] State Sync -> isPlaying: ${isPlaying}`, 'color: #00ff00; background: #222; padding: 2px 5px; border-radius: 4px;');
      });
    }

    console.log('[BOOT] Infrastructure OK');

    // [SOVEREIGNTY] Component Registry for Lifecycle Management
    const registry: { unmount: () => void }[] = [];

    // 2. Map DOM Elements & Initialize Components
    const safeMount = (name: string, el: HTMLElement | null, factory: (el: HTMLElement) => any) => {
        if (!el) {
            console.warn(`[BOOT] SKIPPING ${name}: Element not found.`);
            return null;
        }
        try {
            const component = factory(el);
            console.log(`[BOOT] ${name} initialized.`);
            return component;
        } catch (e) {
            console.error(`[BOOT] ${name} FAILED:`, e);
            return null;
        }
    };

    const navigator = safeMount('navigator', document.getElementById('sentence-navigator'), (el) => new SentenceNavigator({
        navigator: el,
        prev: document.getElementById('sentence-prev'),
        current: document.getElementById('sentence-current'),
        next: document.getElementById('sentence-next')
    }));
    if (navigator) {registry.push(navigator);}

    const controls = safeMount('controls', document.getElementById('btn-play'), (el) => new PlaybackControls({
        btnPlay: el as HTMLButtonElement,
        btnPause: document.getElementById('btn-pause') as HTMLButtonElement,
        btnStop: document.getElementById('btn-stop') as HTMLButtonElement,
        btnPrev: document.getElementById('btn-prev') as HTMLButtonElement,
        btnNext: document.getElementById('btn-next') as HTMLButtonElement,
        btnPrevSentence: document.getElementById('btn-prev-sentence') as HTMLButtonElement,
        btnNextSentence: document.getElementById('btn-next-sentence') as HTMLButtonElement,
        btnAutoplay: document.getElementById('btn-autoplay') as HTMLButtonElement,
        waveContainer: document.getElementById('sentence-navigator') as HTMLElement,
        statusDot: document.getElementById('status-dot') as HTMLElement
    }));
    if (controls) {registry.push(controls);}

    const chapterList = safeMount('chapterList', document.getElementById('chapter-list'), (el) => new ChapterList({
        container: el,
        fullProgressHeader: document.getElementById('sentence-progress'),
        chapterOnlyHeader: document.getElementById('chapter-progress')
    }));
    if (chapterList) {registry.push(chapterList);}

    const settings = safeMount('settings', document.getElementById('settings-drawer'), (el) => new SettingsDrawer({
        drawer: el,
        btnOpen: document.getElementById('settings-toggle') as HTMLElement,
        volumeSlider: document.getElementById('volume-slider') as HTMLInputElement,
        rateSlider: document.getElementById('rate-slider') as HTMLInputElement,
        btnCloudEngine: document.getElementById('engine-neural') as HTMLButtonElement,
        btnLocalEngine: document.getElementById('engine-local') as HTMLButtonElement,
        rateVal: document.getElementById('rate-val'),
        volumeVal: document.getElementById('volume-val'),
        cacheDebugTag: document.getElementById('cache-debug-tag') as HTMLElement,
        stateDebugTag: document.getElementById('state-debug-tag') as HTMLElement,
        engineToggleGroup: document.querySelector('.engine-toggle-group') as HTMLElement
    }));
    if (settings) {registry.push(settings);}

    const fileContext = safeMount('fileContext', document.querySelector('.context-slot.selection'), (el) => new FileContext({
        activeSlot: el,
        activeFilename: document.getElementById('active-filename') as HTMLElement,
        activeDir: document.getElementById('active-dir') as HTMLElement,
        readerSlot: document.querySelector('.context-slot.reader') as HTMLElement,
        readerFilename: document.getElementById('reader-filename') as HTMLElement,
        readerDir: document.getElementById('reader-dir') as HTMLElement,
        btnLoadFile: document.getElementById('btn-load-file') as HTMLButtonElement,
        btnResetContext: document.getElementById('btn-clear-reader') as HTMLButtonElement,
        btnModeFile: document.getElementById('mode-file') as HTMLButtonElement,
        btnModeSnippet: document.getElementById('mode-snippet') as HTMLButtonElement,
        fileModeContainer: document.getElementById('file-mode-container') as HTMLElement,
        snippetLookupContainer: document.getElementById('snippet-lookup-container') as HTMLElement,
        transferLayer: document.querySelector('.transfer-layer') as HTMLElement
    }));
    if (fileContext) {registry.push(fileContext);}

    const snippetLookup = safeMount('snippetLookup', document.getElementById('snippet-lookup-container'), (el) => new SnippetLookup({
        container: el
    }));
    if (snippetLookup) {registry.push(snippetLookup);}

    const voiceSelector = safeMount('voiceSelector', document.getElementById('voice-list-container'), (el) => new VoiceSelector({
        voiceList: el,
        searchInput: document.getElementById('voice-search') as HTMLInputElement
    }));
    if (voiceSelector) {registry.push(voiceSelector);}

    console.log('[BOOT] Mapping Elements...');

    // Mount all components to attach event listeners.
    // [FIX] Removed premature unmount() call: calling unmount before any component has mounted
    // destroys subscriptions before they are established, causing a permanently silent UI.
    registry.forEach((c) => (c as any).mount());
    
    interaction.mount();
    dispatcher.mount(client);

    // 2a. Register with Layout Manager (Issue #15)
    const layout = LayoutManager.getInstance();
    if (settings) {
        layout.registerSettings(settings as any);
    }

    // 4. Cleanup Hook
    window.onbeforeunload = () => {
        console.log('[ReadAloud] 🧹 Performing global cleanup...');
        registry.forEach(c => c.unmount());
        interaction.unmount();
        audioEngine.purgeMemory();
    };

    const duration = (performance.now() - start).toFixed(1);
    console.log(`[ReadAloud] ✅ Webview Handshake Complete (${duration}ms).`);
    
    client.postAction(OutgoingAction.READY);

  } catch (err) {
    console.error('[FATAL] Webview Bootstrap Crashed:', err);
    throw err;
  }
}

// Start the engine
if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  console.log('[ReadAloud] 🧪 Test Environment Detected: Skipping auto-bootstrap.');
} else {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
}
