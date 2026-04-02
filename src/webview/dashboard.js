import { CacheManager } from './cacheManager';
import { MessageClient } from './core/MessageClient';
import { WebviewStore } from './core/WebviewStore';
import { OutgoingAction } from '../common/types';
import { ChapterList } from './components/ChapterList';
import { PlaybackControls } from './components/PlaybackControls';
import { SentenceNavigator } from './components/SentenceNavigator';
import { FileContext } from './components/FileContext';
import { SettingsDrawer } from './components/SettingsDrawer';
import { VoiceSelector } from './components/VoiceSelector';
import { ToastManager } from './components/ToastManager';
import { PlaybackController } from './playbackController';


(function () {
    window.onerror = function (msg, url, line, col) {
        const errorDetail = `[DASHBOARD] CRITICAL ERROR: ${msg} at line ${line}:${col}`;
        console.error(errorDetail);
        if (window.vscode) {
            try { window.vscode.postMessage({ command: 'error', message: errorDetail }); } catch (e) { }
        }
    };

    // --- High-Integrity Infrastructure (Phase 5.1 & 5.2) ---
    const client = MessageClient.getInstance();
    const store = WebviewStore.getInstance();
    const cache = new CacheManager();

    // Helper: getEl (shorthand for document.getElementById)
    const getEl = (id) => document.getElementById(id);

    // Helper: base64ToBlob (to handle raw audio data from extension)
    function base64ToBlob(base64, mime) {
        const byteChars = atob(base64);
        const byteArrays = [];
        for (let offset = 0; offset < byteChars.length; offset += 512) {
            const slice = byteChars.slice(offset, offset + 512);
            const byteNumbers = new Array(slice.length);
            for (let i = 0; i < slice.length; i++) {
                byteNumbers[i] = slice.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            byteArrays.push(byteArray);
        }
        return new Blob(byteArrays, { type: mime });
    }

    // State Variables
    let currentAudioUrl = null;
    const activeObjectURLs = new Set();

    // Controllers (Scoped)
    let readAloudController;
    let sentenceNavigatorController;
    let chapterListController;
    let playbackControlsController;
    let fileContextController;
    let settingsDrawerController;
    let voiceSelectorController;

    // UI Elements Selector (Early references)
    const neuralPlayer = getEl('neural-player');
    const waveContainer = getEl('sentence-navigator');
    const btnPlay = getEl('btn-play');
    const btnPause = getEl('btn-pause');
    const voiceSearch = getEl('voice-search');
    const cacheDebugTag = getEl('cache-debug-tag');

    // Verification Probe: Reactive logging for state synchronization
    store.subscribe((state) => state.isPlaying, (isPlaying) => {
        console.log(`%c[WebviewStore] State Sync -> isPlaying: ${isPlaying}`, 'color: #00ff00; background: #222; padding: 2px 5px; border-radius: 4px;');
    });

    const vscode = window.vscode;
    
    try {
        // --- Core Playback (Legacy Adapter) ---
        readAloudController = new PlaybackController(neuralPlayer);
        window.readAloudController = readAloudController;

        // --- Component Initialization ---
        
        // 1. Sentence Navigator
        sentenceNavigatorController = new SentenceNavigator({
            navigator: getEl('sentence-navigator'),
            prev: getEl('sentence-prev'),
            current: getEl('sentence-current'),
            next: getEl('sentence-next')
        });
        sentenceNavigatorController.mount();

        // 2. Chapter List
        chapterListController = new ChapterList({ 
            container: getEl('chapter-list'),
            fullProgressHeader: getEl('sentence-progress'),
            chapterOnlyHeader: getEl('chapter-progress')
        });
        chapterListController.mount();

        // 3. Playback Controls
        playbackControlsController = new PlaybackControls({
            btnPlay: getEl('btn-play'),
            btnPause: getEl('btn-pause'),
            btnStop: getEl('btn-stop'),
            btnPrev: getEl('btn-prev'),
            btnNext: getEl('btn-next'),
            btnPrevSentence: getEl('btn-prev-sentence'),
            btnNextSentence: getEl('btn-next-sentence'),
            btnAutoplay: getEl('btn-autoplay'),
            waveContainer: getEl('sentence-navigator'),
            statusDot: getEl('status-dot')
        });
        playbackControlsController.mount();

        // 4. Status & Context
        fileContextController = new FileContext({
            activeSlot: document.querySelector('.context-slot.selection'),
            readerSlot: document.querySelector('.context-slot.reader'),
            activeFilename: getEl('active-filename'),
            activeDir: getEl('active-dir'),
            readerFilename: getEl('reader-filename'),
            readerDir: getEl('reader-dir'),
            btnLoadFile: getEl('btn-load-file'),
            btnClearReader: getEl('btn-clear-reader')
        });
        fileContextController.mount();

        // 5. Settings & Voice
        settingsDrawerController = new SettingsDrawer({
            btnOpen: getEl('settings-toggle'),
            drawer: getEl('settings-drawer'),
            rateSlider: getEl('rate-slider'),
            volumeSlider: getEl('volume-slider'),
            btnCloudEngine: getEl('engine-neural'),
            btnLocalEngine: getEl('engine-local'),
            cacheDebugTag: getEl('cache-debug-tag'),
            stateDebugTag: document.getElementById('state-debug-tag')
        });
        settingsDrawerController.mount();

        voiceSelectorController = new VoiceSelector({
            voiceSelect: getEl('voice-select'),
            searchInput: getEl('voice-search')
        });
        voiceSelectorController.mount();

        // 6. Global Utils
        ToastManager.setContainer(getEl('toast-container'));

        console.log('[DASHBOARD] Component Tree Mounted.');

        // Debug Mode Indicator (Serverless Handshake)
        const config = window.__BOOTSTRAP_CONFIG__;
        if (config && config.debugMode) {
            const debugTag = document.getElementById('debug-mode-tag');
            if (debugTag) {
                debugTag.style.display = 'inline-block';
            }
        }
    } catch (e) {
        const errorDetail = `[DASHBOARD] CRITICAL INITIALIZATION FAILURE: ${e.message}\n${e.stack}`;
        console.error(errorDetail);
        if (window.vscode) {
            window.vscode.postMessage({ command: 'error', message: errorDetail });
        }
    }





    // --- Message Handler ---
    async function handleCommand(message) {
        switch (message.command) {
            case 'UI_SYNC':
                // Handled by Components (WebviewStore)
                readAloudController.handleSync(message);
                break;

            case 'stop':
                // Extension host ordered a stop — ground the audio element immediately.
                console.log('[DASHBOARD] Received STOP command — halting audio.');
                readAloudController.releaseLock();
                if (neuralPlayer) {
                    neuralPlayer.pause();
                    neuralPlayer.currentTime = 0;
                    neuralPlayer.src = '';
                }
                if (waveContainer) { waveContainer.classList.remove('speaking'); }
                if (btnPlay)  { btnPlay.style.display = 'inline-block'; }
                if (btnPause) { btnPause.style.display = 'none'; }
                break;

            case 'playbackStateChanged':
                // Lightweight authoritative state push from extension host.
                console.log('[DASHBOARD] playbackStateChanged received:', message);
                readAloudController.handleSync(message);
                break;

            case 'voices':
                // Standalone voice list push from extension host (e.g. after engine switch).
                // Surgically patch the store so VoiceSelector re-renders without a full UI_SYNC.
                if (message.neuralVoices || message.voices) {
                    const voices = store.getState()?.availableVoices || { local: [], neural: [] };
                    store.patchState({
                        availableVoices: {
                            neural: message.neuralVoices || voices.neural,
                            local: message.voices || voices.local
                        },
                        ...(message.selectedVoice && { selectedVoice: message.selectedVoice }),
                        ...(message.engineMode && { engineMode: message.engineMode })
                    });
                }
                break;


            case 'playAudio':
                readAloudController.releaseLock();
                // Zombie Guard: If user stopped while we were synthesizing, ignore the audio.
                if (readAloudController.getState().intent === 'STOPPED') {
                    console.log('[DASHBOARD] Ignoring Zombie Audio (Intent was STOPPED)');
                    return;
                }

                if (neuralPlayer) {
                    const cacheKey = message.cacheKey;
                    
                    const handleBuffer = async (blob) => {
                        if (currentAudioUrl) {
                            URL.revokeObjectURL(currentAudioUrl);
                            activeObjectURLs.delete(currentAudioUrl);
                        }
                        currentAudioUrl = URL.createObjectURL(blob);
                        activeObjectURLs.add(currentAudioUrl);
                        neuralPlayer.src = currentAudioUrl;

                        if (store.getState()) {
                              const state = store.getState();
                              const vol = state.volume ?? 50;
                              neuralPlayer.volume = Math.max(0, Math.min(1, vol / 100));
                              const r = state.rate ?? 0;
                              neuralPlayer.playbackRate = r >= 0 ? 1 + (r / 10) : 1 + (r / 20);
                        }

                        neuralPlayer.play().catch(e => {
                             console.error('Audio Playback Blocked:', e);
                             client.postAction(OutgoingAction.LOG, `[DASHBOARD] Playback Error: ${e.message}`);
                        });

                        if (waveContainer) { waveContainer.classList.add('speaking'); }
                        btnPlay.style.display = 'none';
                        btnPause.style.display = 'inline-block';
                    };

                    // CASE 1: Data provided by extension (Cache Hit in Extension or Fresh Synthesis)
                    if (message.data) {
                        const blob = base64ToBlob(message.data, 'audio/mpeg');
                        handleBuffer(blob);
                        // Save to cache if we have a key
                        if (cacheKey) {
                            cache.set(cacheKey, blob);
                        }
                    } 
                    // CASE 2: No data provided (Zero-IPC Prefetch Hit)
                    else if (cacheKey) {
                        const cachedBlob = await cache.get(cacheKey);
                        if (cachedBlob) {
                            handleBuffer(cachedBlob);
                            cacheDebugTag?.classList.add('pulse');
                            setTimeout(() => cacheDebugTag?.classList.remove('pulse'), 400);
                        } else {
                            // Cache miss in Webview but extension host thought it was there?
                            // Request full synthesis
                            client.postAction(OutgoingAction.REQUEST_SYNTHESIS, { cacheKey });
                        }
                    } else {
                        console.error('[DASHBOARD] Critical Protocol Failure: [playAudio] received with neither data nor cacheKey.');
                    }
                }
                break;

            case 'synthesisError':
                readAloudController.releaseLock();
                ToastManager.show(message.error, message.isFallingBack ? 'warning' : 'error');
                if (message.isFallingBack) {
                    console.warn(`[DASHBOARD] Neural failure at ${message.chapterIndex}:${message.sentenceIndex} for key ${message.cacheKey}. Falling back to SAPI.`);
                } else {
                    console.error(`[DASHBOARD] Critical synthesis failure at ${message.chapterIndex}:${message.sentenceIndex}. Error: ${message.error}`);
                }
                break;
            
            case 'PURGE_MEMORY':
                console.log('[DASHBOARD] PURGING ALL AUDIO OBJECTS...');
                if (neuralPlayer) {
                    neuralPlayer.pause();
                    neuralPlayer.src = '';
                    neuralPlayer.load();
                }
                activeObjectURLs.forEach(url => {
                    try { URL.revokeObjectURL(url); } catch(e) {}
                });
                activeObjectURLs.clear();
                currentAudioUrl = null;
                break;
        }
    }



    // --- Global Signals ---
    // No manual listeners needed - components handle local events.
    // Keyboard shortcuts remain at the top level for accessibility.

    // --- Keyboard Shortcuts ---
    window.addEventListener('keydown', (e) => {
        // Don't trigger if typing in search input
        if (document.activeElement === voiceSearch) { return; }
        if (e.repeat) { return; }

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                if (store.getState()?.isPlaying && !store.getState()?.isPaused) {
                    client.postAction(OutgoingAction.PAUSE);
                } else {
                    client.postAction(OutgoingAction.PLAY);
                }
                break;
            case 'ArrowRight':
                e.preventDefault();
                client.postAction(OutgoingAction.NEXT_SENTENCE);
                break;
            case 'ArrowLeft':
                e.preventDefault();
                client.postAction(OutgoingAction.PREV_SENTENCE);
                break;
            case 'ArrowDown':
                e.preventDefault();
                client.postAction(OutgoingAction.NEXT_CHAPTER);
                break;
            case 'ArrowUp':
                e.preventDefault();
                client.postAction(OutgoingAction.PREV_CHAPTER);
                break;
        }
    });

    if (vscode) {
        window.addEventListener('message', event => {
            // Hook new infrastructure into the main event loop
            client.handleMessage(event.data);
            handleCommand(event.data);
        });
        
        // Delegated click listener for file links
        document.body.addEventListener('click', (e) => {
            const link = e.target.closest('.file-link');
            if (link && link.dataset.uri) {
                e.preventDefault();
                client.postAction(OutgoingAction.OPEN_FILE, { uri: link.dataset.uri });
            }
        });

        // Initial 'ready' signal using high-integrity client
        client.postAction(OutgoingAction.READY);
    }
}());
