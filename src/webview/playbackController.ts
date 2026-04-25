import { WebviewStore, StoreState } from './core/WebviewStore';
import { MessageClient } from './core/MessageClient';
import { WebviewAudioEngine } from './core/WebviewAudioEngine';
import { OutgoingAction, IncomingCommand, AudioEngineEvent, AudioEngineEventType, UISyncPacket, WindowSentence } from '../common/types';
import { generateCacheKey } from '../common/cachePolicy';
import { debounce } from './utils';
import { ToastManager } from './components/ToastManager';

/**
 * Hardened Playback Controller for Virgo Webview (Singleton)
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
    // [SIMPLIFICATION] _activePlayKey removed — HEAD_MATCH deleted. DATA_PUSH is cache-only.
    // PLAY_AUDIO in CommandDispatcher is the sole entity that triggers playBlob().
    
    /** [DIAGNOSTICS] Monotonic counter for incoming synthesis handshakes */
    public synthesisHandshakeCount: number = 0;
    /** [DIAGNOSTICS] Monotonic counter for engine events */
    public engineEventCount: number = 0;

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

        // [IPC-DEDUP] SYNTHESIS_READY and DATA_PUSH are handled exclusively by CommandDispatcher.dispatch().
        // Registering them here caused EVERY message to fire TWICE:
        //   1) CommandDispatcher.mount() registers all IncomingCommand values via client.onCommand()
        //   2) setupListeners() registered them again independently
        // Result: 2× FETCH_AUDIO per synthesis, 2× ingestData() per DATA_PUSH, double canplay.
        // REMOVED: SYNTHESIS_READY handler (was lines 132-134)
        // REMOVED: DATA_PUSH handler (was lines 143-146)
        // Both are now sole-authority of CommandDispatcher.

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

        // [IPC-DEDUP] CLEAR_CACHE_WIPE and PURGE_MEMORY also handled by CommandDispatcher.
        // REMOVED: CLEAR_CACHE_WIPE handler
        // REMOVED: PURGE_MEMORY handler
        // Kept only the handlers NOT present in CommandDispatcher:

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
        WebviewAudioEngine.getInstance().ensureAudioContext(); // single call — promise-gated, safe to call once

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

        // 4. [IPC] Sovereign Emission — single ensureAudioContext call above handles priming
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

        // 1. [SYNC] Universal Unlocker — only prime if user has already interacted.
        if (this._userHasInteracted) {
            WebviewAudioEngine.getInstance().ensureAudioContext();
        }

        // 2. [SOVEREIGNTY] Authoritative update replacing "optimisticPatch"
        // [BUG-FIX] Do NOT unconditionally set isPlaying:true.
        // jumpToChapter() is used both as a user "play chapter" action AND as a
        // programmatic head-reset (e.g. after file load from a stopped state).
        // Forcing isPlaying:true caused the extension to auto-start synthesis after every
        // file load regardless of user intent — the "weird sequence" regression.
        // We preserve the current playing state: a stopped session stays stopped,
        // a playing session continues playing at the new chapter position.
        const wasPlaying = currentState?.playbackIntent === 'PLAYING';
        if (currentState) {
            store.patchState({
                currentChapterIndex: index,
                currentSentenceIndex: 0,
                isPlaying: wasPlaying,
                isPaused: false
            });
        }

        // 3. [FIFO] Atomic Flush
        this.flushQueue();

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
    private handleSynthesisReady(cacheKey: string, intentId: number, isPriority: boolean): void {
        const store = WebviewStore.getInstance();
        const state = store.getState();
        const currentPlaybackId = state.playbackIntentId as number;

        // [Authoritative Magnitude Check]
        // Reject synthesis if it belongs to a stale intent (monotonic preemption).
        if (intentId < currentPlaybackId) {
            console.warn(`[PlaybackController] 💀 Rejecting zombie synthesis: ${intentId} < ${currentPlaybackId}`);
            return;
        }

        // [MONOTONIC HANDSHAKE] Only increment the handshake counter for the priority path.
        // This ensures a 1:1 ratio between intent starts and handshake completion for the head segment.
        if (isPriority && intentId === currentPlaybackId) {
            console.log(`[PlaybackController] 🤝 High-Integrity Handshake: Intent ${intentId}`);
            this.synthesisHandshakeCount++;
        }

        // [COLD-BOOT GATE] Block FETCH_AUDIO until playback is explicitly authorized.
        // We allow if either the extension has synced authorization OR we have a local user gesture.
        if (!state.playbackAuthorized && !this._userHasInteracted) {
            console.warn(`[PlaybackController] 🔕 SYNTHESIS_READY suppressed — not yet authorized. Cache warming silently for ${cacheKey}.`);
            this.synthesizingKeys.delete(cacheKey);
            return;
        }

        console.log(`[PlaybackController] 🟢 Synthesis ready for intent ${intentId} (Priority: ${isPriority}). Requesting audio fetch...`);
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
        this.engineEventCount++;

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
    public async play(currentUri?: string): Promise<void> {
        console.log('[PlaybackController] 🟢 USER PLAY requested');
        // [AUTOPLAY GUARD] User has explicitly clicked Play — unlock gesture gate.
        this._userHasInteracted = true;
        const store = WebviewStore.getInstance();

        // [FIRST-RUN UX] Guard: if no sentences are loaded AFTER hydration, surface a friendly
        // hint instead of sending a PLAY IPC that silently goes nowhere.
        // isHydrated guard is critical — before the extension syncs we don't know if content
        // exists yet, and tests run without hydration so we must not block them.
        const { currentSentences, focusedIsSupported, isHydrated } = store.getState();
        if (isHydrated && (!currentSentences || currentSentences.length === 0)) {
            if (focusedIsSupported === false) {
                ToastManager.show('This file type is not supported for reading', 'warning');
            } else {
                ToastManager.show('Open a file in VS Code to get started', 'info');
            }
            return;
        }

        // [v2.3.2] Voice Committal
        if (store.getState().isSelectingVoice) {
            console.log('[PlaybackController] 🗳️ Committing to new voice selection. Invalidating old cache.');
            store.resetBatchIntent(); // Invalidate old session cache (increment batchId)
            store.patchState({ isSelectingVoice: false });
        }

        // [FIFO] Atomic Flush before new session
        this.flushQueue();

        // [SOVEREIGNTY] Reset both intent counters for a fresh authoritative session
        const batchId = store.resetBatchIntent();
        const intentId = store.resetPlaybackIntent();
        
        this.intentExpiry = Date.now() + this.INTENT_TIMEOUT_MS;

        // [GESTURE] Prime the audio context immediately on user interaction.
        // [SOVEREIGNTY] Mandating atomic priming BEFORE IPC emission to prevent silent 1-press failures.
        await WebviewAudioEngine.getInstance().ensureAudioContext().catch(() => { });

        // [SOVEREIGNTY] Optimistic State Flip
        // Note: isAwaitingSync is removed here to prevent "stale sync" release during the extension's stop() handshake.
        // WebviewStore.calculateSyncingState() will handle the spinner if isPlaying remains false.
        store.updateUIState({
            isPlaying: true,
            isPaused: false,
            playbackIntent: 'PLAYING',
            lastStallSource: 'USER'
        });

        this.startWatchdog();

        const resolvedUri = currentUri || store.getSentenceKey();
        
        console.log(`[PlaybackController] 🚀 Initiating authoritative PLAY | Intent: ${intentId} | Batch: ${batchId}`);
        MessageClient.getInstance().postAction(OutgoingAction.PLAY, {
            cacheKey: resolvedUri,
            intentId,
            batchId
        });
    }

    public pause(): void {
        console.log('[PlaybackController] ⏸️ USER PAUSE requested');
        const store = WebviewStore.getInstance();
        // [INTENT-DISCIPLINE] Pause is a CONTINUATION, not a cancellation.
        // Do NOT call resetPlaybackIntent() — that bumps the counter, which causes
        // any in-flight PLAY_AUDIO (with the previous intentId) to be rejected.
        // Pause must use the current intentId unchanged.
        const intentId = store.getState().playbackIntentId;

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

    public requestSnippetHistory(force: boolean = false): void {
        console.log(`[PlaybackController] requestSnippetHistory(force=${force}) requested`);
        MessageClient.getInstance().postAction(OutgoingAction.GET_ALL_SNIPPET_HISTORY, {
            intentId: WebviewStore.getInstance().getState().playbackIntentId,
            force
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

        // [LOCK-DISCIPLINE] Only release the play-protection lock if we are NOT actively playing.
        // Without this gate, every UI_SYNC heartbeat (~2s) calls releaseLock() unconditionally,
        // destroying the isAwaitingSync guard set by play() and flipping the button back to ▶.
        const uiState = store.getUIState();
        if (uiState.playbackIntent !== 'PLAYING' || packet.isPlaying) {
            this.releaseLock();
        }
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

        if (engineMode !== 'neural' || queue.length === 0 || !(store.getState().playbackAuthorized || this._userHasInteracted)) { return; }

        // Find current index in window
        const currIdx = queue.findIndex(s => s.cIdx === currentChapterIndex && s.sIdx === currentSentenceIndex);
        if (currIdx === -1) { return; }

        // [HEAD-EXCLUSION] Window starts at currIdx+1: the HEAD sentence (N+0) is the extension's
        // sovereign domain — audioBridge.start() handles it on every play(). _processQueue() is
        // strictly a prefetch scheduler for N+1 onward. Including currIdx caused dual synthesis
        // authority (RC-1) and was the root cause of the double-playback regression.
        const candidates = queue.slice(currIdx + 1, currIdx + 5);

        const engine = WebviewAudioEngine.getInstance();
        const client = MessageClient.getInstance();

        for (const s of candidates) {
            if (this.synthesizingKeys.size >= this.MAX_CONCURRENT_SYNTHESIS) { break; }

            // [SCHEMA-FIX] Pass isNeural so the key matches the extension's cache key exactly.
            // Neural audio is always synthesized at rate=1.0 regardless of the UI rate slider;
            // omitting this flag caused a hash mismatch (RC-2) that bypassed all dedup guards.
            const isNeural = engineMode === 'neural';
            const key = generateCacheKey(
                s.text,
                selectedVoice || 'default',
                rate,
                activeDocumentUri,
                isNeural
            );

            if (!engine.isSegmentReady(key) && !this.synthesizingKeys.has(key)) {
                console.log(`[PlaybackController] 🔮 Pre-fetching: ${key.substring(0, 15)}...`);
                this.synthesizingKeys.add(key);
                client.postAction(OutgoingAction.REQUEST_SYNTHESIS, {
                    cacheKey: key,
                    // [CACHE-POISON FIX] Pass the sentence text so the extension synthesizes the
                    // correct segment. Without this, synthesize() always reads state.currentSentenceIndex
                    // (HEAD=0) and stores HEAD audio under every prefetch key — poisoning N+1/N+2/N+3.
                    text: s.text,
                    intentId: store.getState().playbackIntentId,
                    batchId: store.getState().batchIntentId,
                    isPriority: s.cIdx === currentChapterIndex && s.sIdx === currentSentenceIndex
                });
            }
        }
    }

}
