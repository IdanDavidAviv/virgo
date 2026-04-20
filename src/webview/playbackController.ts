import { WebviewStore, StoreState } from './core/WebviewStore';
import { MessageClient } from './core/MessageClient';
import { WebviewAudioEngine } from './core/WebviewAudioEngine';
import { OutgoingAction, IncomingCommand, AudioEngineEvent, AudioEngineEventType, UISyncPacket, WindowSentence } from '../common/types';
import { generateCacheKey } from '../common/cachePolicy';
import { debounce } from './utils';

/**
 * Hardened Playback Controller for Read Aloud Webview (Singleton)
 * Manages synchronous audio pausing, IPC throttling, and state reconciliation.
 * Restored logic from dashboard.js to ensure high-integrity sync parity.
 */
export enum PlaybackIntent {
    PLAYING = 'PLAYING',
    PAUSED = 'PAUSED',
    STOPPED = 'STOPPED'
}

export enum PlaybackMode {
    ACTIVE = 'active',
    PAUSED = 'paused',
    STOPPED = 'stopped'
}

export class PlaybackController {
    private static instance: PlaybackController;
    private watchdog: any = null;
    private intentExpiry: number = 0;
    private readonly INTENT_TIMEOUT_MS = 1500; // [STABILITY] Grant 1.5s of sovereignty to user intent
    private transitionExpiry: number = 0;
    private readonly TRANSITION_WINDOW_MS = 500; // [UI] 500ms window to ignore index syncs after a jump
    private synthesizingKeys: Set<string> = new Set();
    private readonly MAX_CONCURRENT_SYNTHESIS = 3;
    /** [AUTOPLAY GUARD] True only after the user has explicitly clicked Play/Jump or interacted with the webview. */
    private _userHasInteracted: boolean = false;

    public get userHasInteracted(): boolean {
        return this._userHasInteracted;
    }
    private constructor() {
        this.setupListeners();
        // [PASSIVE BINDING] Controllers bind to the Engine's event stream
        WebviewAudioEngine.getInstance().onEvent = (e) => this.handleEngineEvent(e);

        // [v2.3.2] AUTOPLAY PRIMING: Use the first click/mousedown anywhere in the webview to unlock audio.
        if (typeof window !== 'undefined') {
            const prime = () => {
                console.log('[PlaybackController] 🔑 User gesture detected. Unlocking Audio Engine...');
                this.userInteracted();
                window.removeEventListener('mousedown', prime);
                window.removeEventListener('touchstart', prime);
                window.removeEventListener('keydown', prime);
            };
            window.addEventListener('mousedown', prime);
            window.addEventListener('touchstart', prime, { passive: true });
            window.addEventListener('keydown', prime);
        }

        // [v2.3.1] Authoritative Voice Discovery
        if (typeof window !== 'undefined' && window.speechSynthesis) {
            window.speechSynthesis.onvoiceschanged = () => {
                console.log('[PlaybackController] 🔊 Browser voices updated. Scanning...');
                WebviewAudioEngine.getInstance().scanVoices();
            };
            // Initial scan
            WebviewAudioEngine.getInstance().scanVoices();
        }
    }

    public static getInstance(): PlaybackController {
        if (!this.instance) {
            this.instance = new PlaybackController();
            if (typeof window !== 'undefined') {
                (window as any).__PLAYBACK_CONTROLLER__ = this.instance;
            }
        }
        return this.instance;
    }

    public static resetInstance(): void {
        if (this.instance) {
            this.instance.clearIntent();
            this.instance.synthesizingKeys.clear();
            this.instance.dispose();
        }
        if (typeof window !== 'undefined' && (window as any).__PLAYBACK_CONTROLLER__) {
            const ctrl = (window as any).__PLAYBACK_CONTROLLER__;
            ctrl.clearIntent?.();
            ctrl.synthesizingKeys?.clear?.();
            ctrl.dispose?.();
            (window as any).__PLAYBACK_CONTROLLER__ = undefined;
        }
        this.instance = undefined as any;
    }

    public dispose(): void {
        this.clearWatchdog();
        WebviewAudioEngine.getInstance().onEvent = undefined;
    }

    public userInteracted(): void {
        if (!this._userHasInteracted) {
            this._userHasInteracted = true;
            // Prime the engine immediately on interaction
            WebviewAudioEngine.getInstance().ensureAudioContext().catch(err => {
                console.warn('[PlaybackController] ⚠️ Failed to prime AudioContext on interaction:', err);
            });
        }
    }

    public clearIntent(): void {
        const store = WebviewStore.getInstance();
        store.setIntentIds(0, 0);
        this.intentExpiry = 0;
        this.transitionExpiry = 0;
        store.updateUIState({ isAwaitingSync: false, playbackIntent: 'STOPPED' });
        this.clearWatchdog();
    }

    private setupListeners(): void {
        const client = MessageClient.getInstance();
        const store = WebviewStore.getInstance();

        // [SOVEREIGNTY] Centralized IPC Handlers
        client.onCommand(IncomingCommand.SYNTHESIS_READY, (data) => {
            this.handleSynthesisReady(data.cacheKey, data.intentId);
        });


        // --- IPC & LOGIC HELPERS ---

        client.onCommand<{ cacheKey: string, data: string, intentId: number, bakedRate?: number }>(IncomingCommand.DATA_PUSH, ({ cacheKey, data, intentId, bakedRate }) => {
            const engine = WebviewAudioEngine.getInstance();
            const store = WebviewStore.getInstance();

            // 1. [FIFO] Atomic Ingestion
            engine.ingestData(cacheKey, data, intentId);

            // 2. [INTENT GUARD] 
            const headKey = store.getSentenceKey();
            const { playbackIntent } = store.getUIState();
            const currentPlaybackId = store.getState().playbackIntentId;

            // [AUTHORITATIVE PLAYBACK]
            // We only trigger auto-play if we are actively PLAYING, this is the HEAD segment,
            // AND the user has already interacted (gesture gate for browser autoplay policy).
            if (playbackIntent === 'PLAYING' && cacheKey === headKey && intentId === currentPlaybackId) {
                if (this._userHasInteracted) {
                    console.log(`[PlaybackController] 🚀 HEAD MATCH: ${cacheKey}. Triggering Engine Play.`);
                    // [3.2.B] Pass bakedRate so the engine applies the correct effectiveRate.
                    engine.playFromCache(cacheKey, intentId, bakedRate);
                } else {
                    console.warn('[PlaybackController] 🚫 HEAD MATCH suppressed — awaiting first user gesture.');
                }
            }
        });

        // Unified Cache Stats handler
        const handleCacheStats = (data: { count: number, sizeBytes?: number, size?: number }) => {
            const bytes = Number(data.sizeBytes ?? data.size ?? 0);
            const safeBytes = Number.isFinite(bytes) ? bytes : 0;

            store.patchState({
                cacheCount: data.count,
                cacheSizeBytes: safeBytes
            });

            const sizeMb = Number((safeBytes / (1024 * 1024)).toFixed(2));
            store.updateUIState({
                neuralBuffer: { count: data.count, sizeMb: Number.isFinite(sizeMb) ? sizeMb : 0 }
            });
        };

        client.onCommand<any>(IncomingCommand.CACHE_STATS, handleCacheStats);
        client.onCommand<any>(IncomingCommand.CACHE_STATS_UPDATE, handleCacheStats);

        // [FIX] UI_SYNC is routed exclusively by CommandDispatcher.dispatch(),
        // which already calls both handleUiSync() and playback.handleSync().
        // Registering a second handler here caused double-firing on every packet,
        // leading to a cascading !hasChanges guard exit that silenced all UI updates.

        client.onCommand(IncomingCommand.CLEAR_CACHE_WIPE, () => {
            console.log('[PlaybackController] 🧹 Cache wipe requested');
            WebviewAudioEngine.getInstance().wipeCache();
        });

        client.onCommand(IncomingCommand.PURGE_MEMORY, () => {
            console.log('[PlaybackController] 🧠 Memory purge requested');
            WebviewAudioEngine.getInstance().purgeMemory();
        });

        client.onCommand(IncomingCommand.SNIPPET_SAVED, () => {
            console.log('[PlaybackController] 💾 Snippet saved. Refreshing history...');
            client.postAction(OutgoingAction.GET_ALL_SNIPPET_HISTORY);
        });

        client.onCommand<any>(IncomingCommand.SPEAK_LOCAL, (data) => {
            console.log(`[PlaybackController] 🔊 SPEAK_LOCAL received for intent ${data.intentId}`);
            WebviewAudioEngine.getInstance().speakLocal(data.text, data.voice, data.intentId);
        });
    }

    // --- AUTHORITATIVE UI INTENTS (SOVEREIGN HEAD) ---

    /**
     * jumpToSentence(): Moves the playback head to a specific row.
     * Centralizes Context Blessing -> Store Patch -> IPC dispatch.
     */
    public jumpToSentence(index: number): void {
        console.log(`[PlaybackController] jumpToSentence(${index}) requested`);
        const store = WebviewStore.getInstance();
        const currentState = store.getState();

        // 1. [SYNC] Universal Unlocker: Any jump is a gesture that primes the engine.
        // [AUTOPLAY GUARD] Jump is also a user gesture — unlock the gesture gate.
        this._userHasInteracted = true;
        WebviewAudioEngine.getInstance().ensureAudioContext();

        // 2. [SYNC] Authoritative State Patch
        if (currentState) {
            store.updateState({
                currentSentenceIndex: index,
                isPlaying: true, // Jump implies play
                isPaused: false
            }, 'local');
            store.updateUIState({ isAwaitingSync: true });
            this.transitionExpiry = Date.now() + this.TRANSITION_WINDOW_MS;
        }

        // 3. [FIFO] Atomic Flush
        this.flushQueue();

        // 4. [IPC] Sovereign Emission
        WebviewAudioEngine.getInstance().ensureAudioContext();
        const intentId = store.resetPlaybackIntent();
        MessageClient.getInstance().postAction(OutgoingAction.JUMP_TO_SENTENCE, {
            index,
            intentId,
            batchId: store.getState().batchIntentId
        });
    }

    /**
     * loadDocument(): Triggers authoritative document loading.
     */
    public loadDocument(): void {
        console.log('[PlaybackController] 📄 USER LOAD_DOCUMENT requested');
        const store = WebviewStore.getInstance();
        const intentId = store.resetPlaybackIntent();

        store.updateUIState({
            isAwaitingSync: true,
            activeMode: 'FILE'
        });

        MessageClient.getInstance().postAction(OutgoingAction.LOAD_DOCUMENT, { intentId });
        this.startWatchdog();
    }

    /**
     * resetContext(): Snappy UI clearing.
     */
    public resetContext(): void {
        console.log('[PlaybackController] 🧹 USER RESET_CONTEXT requested');
        const store = WebviewStore.getInstance();
        const intentId = store.resetPlaybackIntent();

        store.updateState({
            activeMode: 'FILE',
            activeDocumentUri: null as any,
            activeFileName: null as any
        });

        store.updateUIState({ isAwaitingSync: true });

        MessageClient.getInstance().postAction(OutgoingAction.RESET_CONTEXT, { intentId });
        this.startWatchdog();
    }

    /**
     * setMode() - Atomic transition between FILE and SNIPPET modes.
     */
    public setMode(mode: 'FILE' | 'SNIPPET'): void {
        console.log(`[PlaybackController] 🔄 Switching mode to: ${mode}`);
        WebviewStore.getInstance().updateUIState({ activeMode: mode });
    }

    /**
     * jumpToChapter(): Full chapter navigation logic.
     */
    public jumpToChapter(index: number): void {
        console.log(`[PlaybackController] jumpToChapter(${index}) requested`);
        const store = WebviewStore.getInstance();
        const currentState = store.getState();

        // 1. [SYNC] Universal Unlocker
        WebviewAudioEngine.getInstance().ensureAudioContext();

        // 2. [SOVEREIGNTY] Authoritative update replacing "optimisticPatch"
        if (currentState) {
            store.patchState({
                currentChapterIndex: index,
                currentSentenceIndex: 0,
                isPlaying: true,
                isPaused: false
            });
        }

        // 3. [FIFO] Atomic Flush
        this.flushQueue();

        WebviewAudioEngine.getInstance().ensureAudioContext();
        const batchId = store.resetBatchIntent();
        const intentId = store.resetPlaybackIntent();
        MessageClient.getInstance().postAction(OutgoingAction.JUMP_TO_CHAPTER, { index, intentId, batchId });
    }

    /**
     * selectVoice(): Switches the strategic voice ID.
     */
    public selectVoice(voiceId: string): void {
        console.log(`[PlaybackController] selectVoice(${voiceId}) requested`);
        const store = WebviewStore.getInstance();
        const state = store.getState();

        // 1. [SOVEREIGNTY] Authoritative update + Sampling Flag
        store.patchState({
            selectedVoice: voiceId,
            isSelectingVoice: true // Enter sampling mode
        });

        // 2. [INTERRUPT] Stop current engine activities
        WebviewAudioEngine.getInstance().stop();

        // 3. [SAMPLING] Synthesize current sentence for immediate feedback
        const currentSentence = state.currentSentences[state.currentSentenceIndex];
        if (currentSentence) {
            const intentId = store.resetPlaybackIntent();
            console.log(`[PlaybackController] 🧪 Sampling feedback for voice: ${voiceId}`);
            WebviewAudioEngine.getInstance().speakLocal(currentSentence, voiceId, intentId);
        }

        console.log(`[IPC:OUT] VOICE_CHANGED -> ${voiceId}`);
        MessageClient.getInstance().postAction(OutgoingAction.VOICE_CHANGED, {
            voice: voiceId,
            intentId: store.getState().playbackIntentId
        });
    }

    /**
     * setVolume(): Throttled volume orchestration.
     */
    private debouncedVolumeEmit = debounce((volume: number) => {
        console.log(`[IPC:OUT] VOLUME_CHANGED -> ${volume}`);
        MessageClient.getInstance().postAction(OutgoingAction.VOLUME_CHANGED, {
            volume,
            intentId: WebviewStore.getInstance().getState().playbackIntentId
        });
    }, 300);

    public setVolume(volume: number): void {
        const store = WebviewStore.getInstance();

        // [SOVEREIGNTY] Update store only. 
        // The AudioEngine's reactive subscription will handle applying it to the active strategy.
        store.patchState({ volume });

        // [SOVEREIGNTY] Throttled IPC emission
        this.debouncedVolumeEmit(volume);
    }

    /**
     * setRate(): Throttled rate orchestration.
     */
    private debouncedRateEmit = debounce((rate: number) => {
        console.log(`[IPC:OUT] RATE_CHANGED -> ${rate}x`);
        MessageClient.getInstance().postAction(OutgoingAction.RATE_CHANGED, {
            rate,
            intentId: WebviewStore.getInstance().getState().playbackIntentId
        });
    }, 300);

    public setRate(rate: number): void {
        const store = WebviewStore.getInstance();

        // [SOVEREIGNTY] Update store only.
        store.patchState({ rate });

        this.debouncedRateEmit(rate);
    }

    /**
     * setEngineMode(): Switches between Local (SpeechKit) and Neural (OpenAI/Cloud).
     */
    public setEngineMode(mode: 'neural' | 'local'): void {
        console.log(`[PlaybackController] setEngineMode(${mode}) requested`);
        const store = WebviewStore.getInstance();

        store.patchState({ engineMode: mode });
        MessageClient.getInstance().postAction(OutgoingAction.ENGINE_MODE_CHANGED, {
            mode,
            intentId: store.getState().playbackIntentId
        });
    }

    /**
     * clearCache(): Explicitly wipes the local and remote cache.
     */
    public clearCache(): void {
        console.log('[PlaybackController] clearCache() requested');
        WebviewAudioEngine.getInstance().wipeCache();
        const intentId = WebviewStore.getInstance().getState().playbackIntentId;
        MessageClient.getInstance().postAction(OutgoingAction.CLEAR_CACHE, { intentId });
    }

    /**
     * refreshVoices(): Triggers a manual re-scan of both local and neural voices.
     */
    public refreshVoices(): void {
        console.log('[PlaybackController] 🔄 Manual voice refresh requested');

        // 1. Scan browser local voices
        WebviewAudioEngine.getInstance().scanVoices();

        // 2. [UI] Immediate feedback
        WebviewStore.getInstance().patchState({ isLoadingVoices: true });

        // 3. Request extension to re-scan neural voices
        MessageClient.getInstance().postAction(OutgoingAction.REFRESH_VOICES);
    }


    /**
     * handleSynthesisReady() - Sovereign fetch orchestration.
     */
    private handleSynthesisReady(cacheKey: string, intentId: number): void {
        const store = WebviewStore.getInstance();
        const state = store.getState();
        const currentPlaybackId = state.playbackIntentId as number;

        // [Authoritative Magnitude Check]
        // Reject synthesis if it belongs to a stale intent (monotonic preemption).
        if (intentId < currentPlaybackId) {
            console.warn(`[PlaybackController] 💀 Rejecting zombie synthesis: ${intentId} < ${currentPlaybackId}`);
            return;
        }

        // [COLD-BOOT GATE] Block FETCH_AUDIO until playback is explicitly authorized by a user gesture.
        // Synthesis still runs on the extension side, warming the cache silently.
        // Audio data will flow when the user presses play and playbackAuthorized flips to true.
        if (!state.playbackAuthorized) {
            console.warn(`[PlaybackController] 🔕 SYNTHESIS_READY suppressed — not yet authorized. Cache warming silently for ${cacheKey}.`);
            this.synthesizingKeys.delete(cacheKey);
            return;
        }

        console.log(`[PlaybackController] 🟢 Synthesis ready for intent ${intentId}. Requesting audio fetch...`);
        this.synthesizingKeys.delete(cacheKey);
        this.setBuffering(true);
        MessageClient.getInstance().postAction(OutgoingAction.FETCH_AUDIO, {
            cacheKey,
            intentId,
            batchId: state.batchIntentId
        });

        // [FIFO] Trigger next pre-fetch
        this._processQueue();
    }

    /**
     * handleEngineEvent() - Authoritative state reconciliation from the playback engine.
     */
    private handleEngineEvent(event: AudioEngineEvent): void {
        const store = WebviewStore.getInstance();
        const currentPlaybackId = store.getState().playbackIntentId;

        console.log(`[PlaybackController] 🛰️ Sovereign Event: ${event.type} | Intent: ${event.intentId}`);

        // [v2.3.2] Authoritative Intent Adoption
        if (event.intentId !== undefined && event.intentId > currentPlaybackId) {
            console.log(`[PlaybackController] 📈 Adopting newer intent ${event.intentId} from engine event.`);
            store.setIntentIds(event.intentId);
        }

        switch (event.type) {
            case AudioEngineEventType.PLAYING:
                store.patchState({
                    playbackStalled: false,
                    playbackIntent: 'PLAYING'
                });
                store.updateUIState({
                    isBuffering: false,
                    isAwaitingSync: false
                });
                break;

            case AudioEngineEventType.PAUSED:
                store.patchState({
                    playbackStalled: false,
                    playbackIntent: 'PAUSED'
                });
                store.updateUIState({
                    isAwaitingSync: false
                });
                break;

            case AudioEngineEventType.ENDED:
                store.patchState({
                    playbackStalled: false,
                    playbackIntent: 'STOPPED'
                });
                store.updateUIState({
                    isAwaitingSync: false
                });
                if (!store.getState().isSelectingVoice) {
                    MessageClient.getInstance().postAction(OutgoingAction.SENTENCE_ENDED, { intentId: event.intentId });
                } else {
                    console.log('[PlaybackController] ⏸️ Suppression: Audio ended during voice selection. Auto-advance suppressed.');
                }
                break;

            case AudioEngineEventType.STALLED:
                store.patchState({ playbackStalled: true });
                store.updateUIState({ isBuffering: true });
                break;

            case AudioEngineEventType.ERROR:
                console.error(`[PlaybackController] 🔴 Engine error: ${event.message}`);

                // [v2.3.2] Non-Destructive Error Handling
                // We keep the intent as is; if it's PLAYING, we allow the next segment to attempt recovery.
                // We only clear the "waiting" states to avoid a permanent spinner.
                store.patchState({
                    playbackStalled: false
                });
                store.updateUIState({
                    isBuffering: false,
                    isAwaitingSync: false
                });
                break;
        }
    }

    /**
     * play() - Sovereign orchestration for playback.
     */
    public play(currentUri?: string): void {
        console.log('[PlaybackController] 🟢 USER PLAY requested');
        // [AUTOPLAY GUARD] User has explicitly clicked Play — unlock gesture gate.
        this._userHasInteracted = true;
        const store = WebviewStore.getInstance();

        // [v2.3.2] Voice Committal
        if (store.getState().isSelectingVoice) {
            console.log('[PlaybackController] 🗳️ Committing to new voice selection. Invalidating old cache.');
            store.resetBatchIntent(); // Invalidate old session cache (increment batchId)
            store.patchState({ isSelectingVoice: false });
        }

        const intentId = store.resetPlaybackIntent();
        this.intentExpiry = Date.now() + this.INTENT_TIMEOUT_MS;

        // [SYNC] Universal Unlocker: Priming on Play
        WebviewAudioEngine.getInstance().ensureAudioContext();

        // [SOVEREIGNTY] Optimistic State Flip for immediate reactive feedback
        store.updateUIState({
            isPlaying: true,
            isPaused: false,
            playbackIntent: 'PLAYING',
            isAwaitingSync: true,
            lastStallSource: 'USER'
        });

        this.startWatchdog();

        const resolvedUri = currentUri || store.getSentenceKey();

        // [Law 7.3 — Play Guard] Only invoke the local cache + REQUEST_SYNTHESIS path when
        // we have a valid, non-empty cache key. An empty key means no currentText has landed
        // yet (e.g., fresh LOAD_DOCUMENT with no sentenceChanged yet). In that case, the
        // extension's PLAY → continue() → audioBridge.start() path will handle everything
        // correctly using the docController chapters — no webview-side REQUEST_SYNTHESIS needed.
        if (resolvedUri) {
            WebviewAudioEngine.getInstance().playFromCache(resolvedUri, intentId).then(hit => {
                if (!hit) {
                    console.log(`[PlaybackController] Cache miss for ${resolvedUri}. Requesting synthesis...`);
                    MessageClient.getInstance().postAction(OutgoingAction.REQUEST_SYNTHESIS, {
                        cacheKey: resolvedUri,
                        intentId,
                        batchId: store.getState().batchIntentId
                    });
                }
            });
        } else {
            console.log('[PlaybackController] ⚠️ No resolved URI — skipping local cache check. Extension PLAY handler will drive synthesis via audioBridge.start().');
        }

        MessageClient.getInstance().postAction(OutgoingAction.PLAY, {
            cacheKey: resolvedUri,
            intentId,
            batchId: store.getState().batchIntentId
        });
    }

    public pause(): void {
        console.log('[PlaybackController] ⏸️ USER PAUSE requested');
        const store = WebviewStore.getInstance();
        const intentId = store.resetPlaybackIntent();
        this.intentExpiry = Date.now() + this.INTENT_TIMEOUT_MS;

        // [SYNC] Universal Unlocker: Priming on Pause
        WebviewAudioEngine.getInstance().ensureAudioContext();

        // [RECOVERY] Clear any previous persistent stall logic
        store.resetLoadingStates();

        // [SYNC] Authoritative update replacing "optimisticPatch"
        store.updateUIState({
            isPlaying: false,
            isPaused: true,
            playbackIntent: 'PAUSED',
            isAwaitingSync: true,
            lastStallSource: 'USER'
        });

        this.startWatchdog();

        WebviewAudioEngine.getInstance().pause();
        MessageClient.getInstance().postAction(OutgoingAction.PAUSE, { intentId });
    }

    public togglePlayPause(): void {
        const store = WebviewStore.getInstance();
        const { playbackIntent } = store.getState();
        if (playbackIntent === 'PLAYING') {
            this.pause();
        } else {
            this.play();
        }
    }

    public stop(): void {
        console.log('[PlaybackController] ⏹️ USER STOP requested');
        const store = WebviewStore.getInstance();
        const intentId = store.resetPlaybackIntent();
        this.intentExpiry = Date.now() + this.INTENT_TIMEOUT_MS;

        // [SYNC] Universal Unlocker: Priming on Stop
        WebviewAudioEngine.getInstance().ensureAudioContext();

        // [RECOVERY] Clear any previous persistent stall logic
        store.resetLoadingStates();

        // [SOVEREIGNTY] Optimistic State Flip for immediate reactive feedback
        store.updateUIState({
            playbackIntent: 'STOPPED',
            isPlaying: false,
            isPaused: false,
            isAwaitingSync: true
        });

        // [SOVEREIGNTY] Clear sampling mode on stop
        store.patchState({ isSelectingVoice: false });

        this.startWatchdog();

        WebviewAudioEngine.getInstance().stop();
        MessageClient.getInstance().postAction(OutgoingAction.STOP, { intentId });
    }

    /**
     * [SOVEREIGNTY] Navigation intents: Always increment intentId to prune async race conditions.
     */
    public prevChapter(): void {
        const store = WebviewStore.getInstance();
        const intentId = store.resetPlaybackIntent();
        this.startWatchdog();

        // [SYNC] Universal Unlocker: Priming on Prev Chapter
        WebviewAudioEngine.getInstance().ensureAudioContext();

        store.updateUIState({ isAwaitingSync: true });
        MessageClient.getInstance().postAction(OutgoingAction.PREV_CHAPTER, { intentId });
    }

    public nextChapter(): void {
        const store = WebviewStore.getInstance();
        const intentId = store.resetPlaybackIntent();
        this.startWatchdog();

        // [SYNC] Universal Unlocker: Priming on Next Chapter
        WebviewAudioEngine.getInstance().ensureAudioContext();

        store.updateUIState({ isAwaitingSync: true });
        MessageClient.getInstance().postAction(OutgoingAction.NEXT_CHAPTER, { intentId });
    }

    public prevSentence(): void {
        const store = WebviewStore.getInstance();
        const intentId = store.resetPlaybackIntent();
        this.startWatchdog();

        // [SYNC] Universal Unlocker: Priming on Prev Sentence
        WebviewAudioEngine.getInstance().ensureAudioContext();

        store.updateUIState({ isAwaitingSync: true });
        MessageClient.getInstance().postAction(OutgoingAction.PREV_SENTENCE, { intentId });
    }

    public nextSentence(): void {
        const store = WebviewStore.getInstance();
        const intentId = store.resetPlaybackIntent();
        this.startWatchdog();

        // [SYNC] Universal Unlocker: Priming on Next Sentence
        WebviewAudioEngine.getInstance().ensureAudioContext();

        store.updateUIState({ isAwaitingSync: true });
        MessageClient.getInstance().postAction(OutgoingAction.NEXT_SENTENCE, { intentId });
    }

    /**
     * setAutoPlayMode() - Sovereign intent for changing autoplay settings.
     */
    public setAutoPlayMode(mode: 'auto' | 'chapter' | 'row'): void {
        console.log(`[PlaybackController] setAutoPlayMode(${mode}) requested`);
        const store = WebviewStore.getInstance();

        // [SOVEREIGNTY] Authoritative update
        store.patchState({ autoPlayMode: mode });
        store.updateUIState({ isAwaitingSync: false }); // Instant feedback for toggle

        MessageClient.getInstance().postAction(OutgoingAction.SET_AUTO_PLAY_MODE, {
            mode,
            intentId: store.getState().playbackIntentId
        });
    }

    public setBuffering(value: boolean): void {
        WebviewStore.getInstance().updateUIState({ isBuffering: value });
    }

    public getActiveIntentId(): number {
        return WebviewStore.getInstance().getState().playbackIntentId;
    }

    public acquireLock(): void {
        this.setAwaitingSync(true);
        this.startWatchdog();
    }

    public loadSnippet(path: string): void {
        const store = WebviewStore.getInstance();
        const intentId = store.resetPlaybackIntent();
        console.log(`[PlaybackController] loadSnippet(${path}) requested`);
        store.updateUIState({ isAwaitingSync: true });
        this.startWatchdog();
        MessageClient.getInstance().postAction(OutgoingAction.LOAD_SNIPPET, {
            path,
            intentId
        });
    }

    public requestSnippetHistory(): void {
        console.log('[PlaybackController] requestSnippetHistory() requested');
        MessageClient.getInstance().postAction(OutgoingAction.GET_ALL_SNIPPET_HISTORY, {
            intentId: WebviewStore.getInstance().getState().playbackIntentId
        });
    }

    public releaseLock(): void {
        this.setAwaitingSync(false);
        this.clearWatchdog();
    }

    private setAwaitingSync(value: boolean): void {
        WebviewStore.getInstance().updateUIState({ isAwaitingSync: value });
    }

    /**
     * handleSync() - Core reconciliation logic from dashboard.js
     */
    public handleSync(packet: UISyncPacket): void {
        const store = WebviewStore.getInstance();
        if (!store.getState().isHydrated) {
            console.log('[PlaybackController] 🤝 Webview Hydrated');
            store.patchState({ isHydrated: true });
        }

        const currentPlaybackId = store.getState().playbackIntentId;
        const packetIntentId: number = packet.playbackIntentId ?? 0;

        // 1. [INTENT ADOPTION] Track authoritative intent IDs from extension
        if (packetIntentId > currentPlaybackId) {
            console.log(`[PlaybackController] 📈 Adopting newer playbackIntentId from authoritative sync: ${packetIntentId}`);
            store.setIntentIds(packetIntentId);
        }

        const currentBatchId = store.getState().batchIntentId;
        if (packet.batchIntentId !== undefined && packet.batchIntentId > currentBatchId) {
            console.log(`[PlaybackController] 📈 Adopting newer batchIntentId: ${packet.batchIntentId}`);
            store.setIntentIds(undefined, packet.batchIntentId);
        }

        // [FIFO] Update Authoritative Queue
        if (packet.windowSentences) {
            store.setQueue(packet.windowSentences);
            this._processQueue();
        }

        // 2. [FLUID SYNC] Delegate segmented sovereignty to the store
        // If the packet is stale, patchState will automatically strip disruptive fields
        // but allow telemetry (Voices, Stats, FileName) to flow through.

        const now = Date.now();
        const isTransitioning = now < this.transitionExpiry;

        // Sync intent with truth
        const modeFromPacket = packet.isPlaying && !packet.isPaused ? 'PLAYING' :
            packet.isPlaying && packet.isPaused ? 'PAUSED' : 'STOPPED';

        const syncPatch: Partial<StoreState> = {
            ...packet,
            playbackIntent: modeFromPacket
        };

        // [STABILITY] If we are transitioning (e.g. just jumped), we PROTECT indices 
        // with extra urgency beyond the standard intent guard.
        if (isTransitioning) {
            console.log('[PlaybackController] 🧱 Syncing playback state ONLY (Transition Lock Active)');
            delete syncPatch.currentSentenceIndex;
            delete syncPatch.currentChapterIndex;
        }

        // Apply the patch. WebviewStore.patchState handles the field-level intent filtering.
        store.patchState(syncPatch);

        // [SOVEREIGNTY BRIDGE] When the extension flips playbackAuthorized to true via UI_SYNC,
        // treat it as equivalent to a user gesture — unlock the interaction gate and prime audio.
        // Without this, PLAY_AUDIO blobs are ingested-only (blocked at CommandDispatcher L114)
        // because _userHasInteracted remains false even after the authorization gate opens.
        if (packet.playbackAuthorized && !this._userHasInteracted) {
            console.log('[PlaybackController] 🔓 playbackAuthorized → unlocking userHasInteracted + priming audio.');
            this._userHasInteracted = true;
            WebviewAudioEngine.getInstance().ensureAudioContext().catch(() => { });
        }

        this.releaseLock();
    }

    public getState() {
        const store = WebviewStore.getInstance();
        const state = store.getState();
        return {
            intent: state.playbackIntent,
            isAwaitingSync: state.isAwaitingSync
        };
    }

    private startWatchdog(): void {
        this.clearWatchdog();
        this.watchdog = setTimeout(() => {
            const store = WebviewStore.getInstance();
            if (store.getState().isAwaitingSync) {
                console.warn('[PlaybackController] ⏳ Sync Watchdog Fired: Lock released.');
                this.setAwaitingSync(false);
            }
        }, 5000);
    }

    private clearWatchdog(): void {
        if (this.watchdog) {
            clearTimeout(this.watchdog);
            this.watchdog = null;
        }
    }

    /**
     * [FIFO] Atomically flushes the playback queue and resets engine state.
     */
    public flushQueue(): void {
        console.log('[PlaybackController] 🚽 Flushing FIFO Queue');
        this.synthesizingKeys.clear();
        WebviewStore.getInstance().setQueue([]);
        WebviewAudioEngine.getInstance().purgeMemory();
    }

    /**
     * [FIFO] Throttled predictive synthesis scheduler.
     * Walks the activeQueue and requests synthesis for next candidates.
     */
    private _processQueue(): void {
        const store = WebviewStore.getInstance();
        const queue = store.getUIState().activeQueue;
        const { engineMode, selectedVoice, rate, currentChapterIndex, currentSentenceIndex, activeDocumentUri } = store.getState();

        if (engineMode !== 'neural' || queue.length === 0) { return; }

        // Find current index in window
        const currIdx = queue.findIndex(s => s.cIdx === currentChapterIndex && s.sIdx === currentSentenceIndex);
        if (currIdx === -1) { return; }

        // [Windowed Policy] Window Size: 5 (Current + Next 4)
        const candidates = queue.slice(currIdx, currIdx + 5);

        const engine = WebviewAudioEngine.getInstance();
        const client = MessageClient.getInstance();

        for (const s of candidates) {
            if (this.synthesizingKeys.size >= this.MAX_CONCURRENT_SYNTHESIS) { break; }

            const key = generateCacheKey(
                s.text,
                selectedVoice || 'default',
                rate,
                activeDocumentUri
            );

            if (!engine.isSegmentReady(key) && !this.synthesizingKeys.has(key)) {
                console.log(`[PlaybackController] 🔮 Pre-fetching: ${key.substring(0, 15)}...`);
                this.synthesizingKeys.add(key);
                client.postAction(OutgoingAction.REQUEST_SYNTHESIS, {
                    cacheKey: key,
                    intentId: store.getState().playbackIntentId,
                    batchId: store.getState().batchIntentId
                });
            }
        }
    }

}
