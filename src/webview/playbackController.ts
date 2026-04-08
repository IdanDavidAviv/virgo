import { WebviewStore } from './core/WebviewStore';
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
  private mode: PlaybackMode = PlaybackMode.STOPPED;
  private intent: PlaybackIntent = PlaybackIntent.STOPPED;
  private awaitingSync: boolean = false;
  private isHandshakeComplete: boolean = false;
  private activeIntentId: number = Date.now();
  private activeBatchId: number = Date.now();
  private watchdog: NodeJS.Timeout | null = null;
  private intentExpiry: number = 0;
  private readonly INTENT_TIMEOUT_MS = 5000; // [STABILITY] Grant 5s of sovereignty to user intent
  private transitionExpiry: number = 0;
  private readonly TRANSITION_WINDOW_MS = 500; // [UI] 500ms window to ignore index syncs after a jump
  private synthesizingKeys: Set<string> = new Set();
  private readonly MAX_CONCURRENT_SYNTHESIS = 3;
  private constructor() {
    this.setupListeners();
    // [PASSIVE BINDING] Controllers bind to the Engine's event stream
    WebviewAudioEngine.getInstance().onEvent = (e) => this.handleEngineEvent(e);
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
      this.instance.dispose();
    }
    if (typeof window !== 'undefined' && (window as any).__PLAYBACK_CONTROLLER__) {
        (window as any).__PLAYBACK_CONTROLLER__.clearIntent();
        (window as any).__PLAYBACK_CONTROLLER__.dispose?.();
        (window as any).__PLAYBACK_CONTROLLER__ = undefined;
    }
    this.instance = undefined as any;
  }

  public dispose(): void {
    this.clearWatchdog();
    WebviewAudioEngine.getInstance().onEvent = undefined;
  }

  public clearIntent(): void {
    this.intent = PlaybackIntent.STOPPED;
    this.mode = PlaybackMode.STOPPED;
    const store = WebviewStore.getInstance();
    store.setIntentIds(Date.now(), Date.now());
    this.intentExpiry = 0;
    this.transitionExpiry = 0;
    this.awaitingSync = false;
    this.clearWatchdog();
  }

  private setupListeners(): void {
    const client = MessageClient.getInstance();
    const store = WebviewStore.getInstance();

    // [SOVEREIGNTY] Centralized IPC Handlers
    client.onCommand(IncomingCommand.SYNTHESIS_READY, (data) => {
        this.handleSynthesisReady(data.cacheKey, data.intentId);
    });

    client.onCommand<any>(IncomingCommand.VOICES, (data) => {
        store.patchState({ 
            availableVoices: { 
                local: data.localVoices || [], 
                neural: data.neuralVoices || [] 
            } 
        });
    });

    // --- IPC & LOGIC HELPERS ---

    client.onCommand<{ cacheKey: string, data: string, intentId: number }>(IncomingCommand.DATA_PUSH, ({ cacheKey, data, intentId }) => {
        const engine = WebviewAudioEngine.getInstance();
        const store = WebviewStore.getInstance();
        
        // 1. [FIFO] Atomic Ingestion
        engine.ingestData(cacheKey, data, intentId);

        // 2. [INTENT GUARD] Prune stale or background data from triggering play
        const { playbackIntent } = store.getUIState();
        const headKey = store.getSentenceKey();

        // [AUTHORITATIVE PLAYBACK]
        const currentPlaybackId = store.getState().playbackIntentId;
        if (playbackIntent === 'PLAYING' && cacheKey === headKey && intentId === currentPlaybackId) {
            console.log(`[PlaybackController] 🚀 AUTHORITATIVE PLAY: ${cacheKey} matches head for intent ${intentId}.`);
            engine.playFromCache(cacheKey, intentId);
        } else {
            console.log(`[PlaybackController] 📥 Ingested ${cacheKey} (Background/Stale). Play inhibited.`);
        }
    });

    // Unified Cache Stats handler
    const handleCacheStats = (data: { count: number, sizeBytes?: number, size?: number }) => {
        const bytes = Number(data.sizeBytes ?? data.size ?? 0);
        const safeBytes = Number.isFinite(bytes) ? bytes : 0;
        
        store.patchState({
            cacheCount: data.count,
            cacheSizeBytes: safeBytes,
            cacheStats: { count: data.count, size: safeBytes }
        });

        const sizeMb = Number((safeBytes / (1024 * 1024)).toFixed(2));
        store.updateUIState({ 
            neuralBuffer: { count: data.count, sizeMb: Number.isFinite(sizeMb) ? sizeMb : 0 }
        });
    };

    client.onCommand<any>(IncomingCommand.CACHE_STATS, handleCacheStats);
    client.onCommand<any>(IncomingCommand.CACHE_STATS_UPDATE, handleCacheStats);

    client.onCommand<UISyncPacket>(IncomingCommand.UI_SYNC, (data) => {
        console.log('[PlaybackController] 🔄 Received UI_SYNC');
        store.updateState(data);
        this.handleSync(data);
    });

    client.onCommand(IncomingCommand.CLEAR_CACHE_WIPE, () => {
        console.log('[PlaybackController] 🧹 Cache wipe requested');
        WebviewAudioEngine.getInstance().wipeCache();
    });

    client.onCommand(IncomingCommand.PURGE_MEMORY, () => {
        console.log('[PlaybackController] 🧠 Memory purge requested');
        WebviewAudioEngine.getInstance().purgeMemory();
    });

    client.onCommand(IncomingCommand.SNIPPET_SAVED, () => {
        client.postAction(OutgoingAction.GET_ALL_SNIPPET_HISTORY);
    });
  }

  // --- AUTHORITATIVE UI INTENTS (SOVEREIGN HEAD) ---

  /**
   * jumpToSentence(): Moves the playback head to a specific row.
   * Centralizes Context Blessing -> Store Patch -> IPC dispatch.
   */
  public jumpToSentence(index: number): void {
      if (!this.ensureHandshake()) {return;}
      console.log(`[PlaybackController] jumpToSentence(${index}) requested`);
      const store = WebviewStore.getInstance();
      const currentState = store.getState();

      // 1. [SYNC] Universal Unlocker: Any jump is a gesture that primes the engine.
      WebviewAudioEngine.getInstance().ensureAudioContext();

      // 2. [SYNC] Authoritative State Patch
      if (currentState) {
          store.updateState({
              state: { ...currentState.state, currentSentenceIndex: index },
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
    if (!this.ensureHandshake()) { return; }
    console.log('[PlaybackController] 📄 USER LOAD_DOCUMENT requested');
    const store = WebviewStore.getInstance();
    const intentId = store.resetPlaybackIntent();
    this.activeIntentId = intentId;
    
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
    if (!this.ensureHandshake()) { return; }
    console.log('[PlaybackController] 🧹 USER RESET_CONTEXT requested');
    const store = WebviewStore.getInstance();
    const intentId = store.resetPlaybackIntent();
    this.activeIntentId = intentId;
    
    store.updateState({
        activeMode: 'FILE',
        state: {
            ...store.getState()?.state,
            activeDocumentUri: null as any,
            activeFileName: null as any
        } as any
    });
    
    store.updateUIState({ isAwaitingSync: true });

    MessageClient.getInstance().postAction(OutgoingAction.RESET_CONTEXT, { intentId });
    this.startWatchdog();
  }

  /**
   * setMode() - Atomic transition between FILE and SNIPPET modes.
   */
  public setMode(mode: 'FILE' | 'SNIPPET'): void {
    if (!this.ensureHandshake()) { return; }
    console.log(`[PlaybackController] 🔄 Switching mode to: ${mode}`);
    WebviewStore.getInstance().updateUIState({ activeMode: mode });
  }

  /**
   * jumpToChapter(): Full chapter navigation logic.
   */
  public jumpToChapter(index: number): void {
      if (!this.ensureHandshake()) {return;}
      console.log(`[PlaybackController] jumpToChapter(${index}) requested`);
      const store = WebviewStore.getInstance();
      const currentState = store.getState();
      
      // 1. [SYNC] Universal Unlocker
      WebviewAudioEngine.getInstance().ensureAudioContext();

      // 2. [SOVEREIGNTY] Authoritative update replacing "optimisticPatch"
      if (currentState) {
          store.patchState({
              state: { ...currentState.state, currentChapterIndex: index, currentSentenceIndex: 0 },
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
      
      // [SOVEREIGNTY] Authoritative update
      store.patchState({ selectedVoice: voiceId });
      
      MessageClient.getInstance().postAction(OutgoingAction.VOICE_CHANGED, { 
          voice: voiceId,
          intentId: store.getState().playbackIntentId
      });
  }

  /**
   * setVolume(): Throttled volume orchestration.
   */
  private debouncedVolumeEmit = debounce((volume: number) => {
      MessageClient.getInstance().postAction(OutgoingAction.VOLUME_CHANGED, { 
          volume,
          intentId: WebviewStore.getInstance().getState().playbackIntentId
      });
  }, 150);

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
      MessageClient.getInstance().postAction(OutgoingAction.RATE_CHANGED, { 
          rate,
          intentId: WebviewStore.getInstance().getState().playbackIntentId
      });
  }, 150);

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
          intentId: this.activeIntentId
      });
  }

  /**
   * clearCache(): Explicitly wipes the local and remote cache.
   */
  public clearCache(): void {
      console.log('[PlaybackController] clearCache() requested');
      WebviewAudioEngine.getInstance().wipeCache();
      MessageClient.getInstance().postAction(OutgoingAction.CLEAR_CACHE, { intentId: this.activeIntentId });
  }

  /**
   * handleSynthesisReady() - Sovereign fetch orchestration.
   */
  private handleSynthesisReady(cacheKey: string, intentId: number): void {
      const currentPlaybackId = WebviewStore.getInstance().getState().playbackIntentId;
      if (intentId < currentPlaybackId) {
          console.warn(`[PlaybackController] 🛡️ Ignoring stale SYNTHESIS_READY for intent ${intentId} (current: ${currentPlaybackId})`);
          return;
      }
      
      console.log(`[PlaybackController] 🟢 Synthesis ready for intent ${intentId}. Requesting audio fetch...`);
      this.synthesizingKeys.delete(cacheKey);
      this.setBuffering(true);
      MessageClient.getInstance().postAction(OutgoingAction.FETCH_AUDIO, { 
          cacheKey, 
          intentId,
          batchId: this.activeBatchId 
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

    // [INTENT LATCH] Sovereign guard against stale reports
    if (event.intentId < currentPlaybackId) {
        console.log(`[PlaybackController] 🛡️ Pruned stale engine event: ${event.type} (Intent: ${event.intentId} < current: ${currentPlaybackId})`);
        return;
    }

    // [CHRONOLOGICAL SOVEREIGNTY]
    if (event.intentId > currentPlaybackId) {
        console.log(`[PlaybackController] 📈 Adopting newer intent from engine event: ${event.intentId}`);
        store.setIntentIds(event.intentId);
    }

    console.log(`[PlaybackController] 🛰️ Sovereign Event: ${event.type} | Intent: ${event.intentId}`);

    switch (event.type) {
        case AudioEngineEventType.PLAYING:
            this.mode = PlaybackMode.ACTIVE;
            this.intent = PlaybackIntent.PLAYING;
            store.patchState({ playbackStalled: false });
            store.updateUIState({ 
                playbackIntent: 'PLAYING', 
                isBuffering: false, 
                isAwaitingSync: false
            });
            break;

        case AudioEngineEventType.PAUSED:
            this.mode = PlaybackMode.PAUSED;
            this.intent = PlaybackIntent.PAUSED;
            store.patchState({ playbackStalled: false });
            store.updateUIState({ 
                playbackIntent: 'PAUSED',
                isAwaitingSync: false
            });
            break;

        case AudioEngineEventType.ENDED:
            this.mode = PlaybackMode.STOPPED;
            this.intent = PlaybackIntent.STOPPED;
            store.patchState({ playbackStalled: false });
            store.updateUIState({ 
                playbackIntent: 'STOPPED',
                isAwaitingSync: false
            });
            MessageClient.getInstance().postAction(OutgoingAction.SENTENCE_ENDED, { intentId: event.intentId });
            break;

        case AudioEngineEventType.STALLED:
            store.patchState({ playbackStalled: true });
            store.updateUIState({ isBuffering: true });
            break;

        case AudioEngineEventType.ERROR:
            console.error(`[PlaybackController] 🔴 Engine error: ${event.message}`);
            
            const { engineMode } = store.getState();
            if (engineMode === 'neural') {
                WebviewAudioEngine.getInstance().fallbackToLocal();
            }

            this.synthesizingKeys.clear();
            this.mode = PlaybackMode.STOPPED;
            this.intent = PlaybackIntent.STOPPED;
            store.patchState({ playbackStalled: false });
            store.updateUIState({ 
                playbackIntent: 'STOPPED',
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
    if (!this.ensureHandshake()) {return;}
    console.log('[PlaybackController] 🟢 USER PLAY requested');
    const store = WebviewStore.getInstance();
    const intentId = store.resetPlaybackIntent();
    this.intent = PlaybackIntent.PLAYING;
    this.intentExpiry = Date.now() + this.INTENT_TIMEOUT_MS;
    
    // [SYNC] Universal Unlocker: Priming on Play
    WebviewAudioEngine.getInstance().ensureAudioContext();

    // [SOVEREIGNTY] Optimistic State Flip for immediate reactive feedback
    store.patchState({ isPlaying: true, isPaused: false });
    
    store.updateUIState({ 
        playbackIntent: 'PLAYING',
        isAwaitingSync: true,
        lastStallSource: 'USER'
    });
    
    this.isAwaitingSync = true;
    this.startWatchdog();
    
    const resolvedUri = currentUri || store.getSentenceKey();
    
    // [SOVEREIGNTY] Check cache before synthesis request
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

    MessageClient.getInstance().postAction(OutgoingAction.PLAY, { 
        cacheKey: resolvedUri, 
        intentId,
        batchId: store.getState().batchIntentId
    });
  }

  public pause(): void {
    if (!this.ensureHandshake()) {return;}
    console.log('[PlaybackController] ⏸️ USER PAUSE requested');
    const store = WebviewStore.getInstance();
    const intentId = store.resetPlaybackIntent();
    this.intent = PlaybackIntent.PAUSED;
    this.intentExpiry = Date.now() + this.INTENT_TIMEOUT_MS;

    // [SYNC] Universal Unlocker: Priming on Pause
    WebviewAudioEngine.getInstance().ensureAudioContext();

    // [RECOVERY] Clear any previous persistent stall logic
    store.resetLoadingStates();
    
    // [SYNC] Authoritative update replacing "optimisticPatch"
    store.patchState({ isPlaying: false, isPaused: true });

    store.updateUIState({ 
        playbackIntent: 'PAUSED',
        isAwaitingSync: true,
        lastStallSource: 'USER'
    });
    
    this.isAwaitingSync = true;
    this.startWatchdog();

    WebviewAudioEngine.getInstance().pause();
    MessageClient.getInstance().postAction(OutgoingAction.PAUSE, { intentId });
  }

  public togglePlayPause(): void {
    if (this.intent === PlaybackIntent.PLAYING) {
      this.pause();
    } else {
      this.play();
    }
  }

  public stop(): void {
    if (!this.ensureHandshake()) return;
    console.log('[PlaybackController] ⏹️ USER STOP requested');
    const store = WebviewStore.getInstance();
    const intentId = store.resetPlaybackIntent();
    this.intent = PlaybackIntent.STOPPED;
    this.intentExpiry = Date.now() + this.INTENT_TIMEOUT_MS;

    // [SYNC] Universal Unlocker: Priming on Stop
    WebviewAudioEngine.getInstance().ensureAudioContext();

    // [RECOVERY] Clear any previous persistent stall logic
    store.resetLoadingStates();

    // [SOVEREIGNTY] Update Store explicitly
    store.patchState({ isPlaying: false, isPaused: false });
    store.updateUIState({ 
        playbackIntent: 'STOPPED',
        isAwaitingSync: true, // Keep TRUE as tests expect a sync lock wait
        lastStallSource: 'USER'
    });
    
    this.isAwaitingSync = true;
    this.startWatchdog();

    WebviewAudioEngine.getInstance().stop();
    MessageClient.getInstance().postAction(OutgoingAction.STOP, { intentId });
  }

  /**
   * [SOVEREIGNTY] Navigation intents: Always increment intentId to prune async race conditions.
   */
  public prevChapter(): void {
      if (!this.ensureHandshake()) return;
      const store = WebviewStore.getInstance();
      const intentId = store.resetPlaybackIntent();
      this.isAwaitingSync = true;
      this.startWatchdog();

      // [SYNC] Universal Unlocker: Priming on Prev Chapter
      WebviewAudioEngine.getInstance().ensureAudioContext();

      store.updateUIState({ isAwaitingSync: true });
      MessageClient.getInstance().postAction(OutgoingAction.PREV_CHAPTER, { intentId });
  }

      const store = WebviewStore.getInstance();
      const intentId = store.resetPlaybackIntent();
      this.activeIntentId = intentId;
      this.awaitingSync = true;
      this.startWatchdog();

      // [SYNC] Universal Unlocker: Priming on Next Chapter
      WebviewAudioEngine.getInstance().ensureAudioContext();

      store.updateUIState({ isAwaitingSync: true });
      MessageClient.getInstance().postAction(OutgoingAction.NEXT_CHAPTER, { intentId });
  }

  public prevSentence(): void {
      const store = WebviewStore.getInstance();
      const intentId = store.resetPlaybackIntent();
      this.activeIntentId = intentId;
      this.awaitingSync = true;
      this.startWatchdog();

      // [SYNC] Universal Unlocker: Priming on Prev Sentence
      WebviewAudioEngine.getInstance().ensureAudioContext();

      store.updateUIState({ isAwaitingSync: true });
      MessageClient.getInstance().postAction(OutgoingAction.PREV_SENTENCE, { intentId });
  }

  public nextSentence(): void {
      if (!this.ensureHandshake()) return;
      const store = WebviewStore.getInstance();
      const intentId = store.resetPlaybackIntent();
      this.activeIntentId = intentId;
      this.awaitingSync = true;
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
          intentId: this.activeIntentId
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
      if (!this.ensureHandshake()) return;
      const store = WebviewStore.getInstance();
      const intentId = store.resetPlaybackIntent();
      console.log(`[PlaybackController] loadSnippet(${path}) requested`);
      this.awaitingSync = true;
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
    this.awaitingSync = value;
    WebviewStore.getInstance().updateUIState({ isAwaitingSync: value });
  }

  /**
   * handleSync() - Core reconciliation logic from dashboard.js
   */
  public handleSync(packet: UISyncPacket): void {
    // [HANDSHAKE GATE] Once we receive any sync, we consider the extension ready
    if (!this.isHandshakeComplete) {
        console.log('[PlaybackController] 🤝 Handshake Complete');
        this.isHandshakeComplete = true;
    }

    // [SOVEREIGNTY] Respect active user intent over incoming sync packets
    const now = Date.now();
    const store = WebviewStore.getInstance();

    // 1. [INTENT GUARD] Check if we are in a sovereign intent window (3.5s)
    // [REFINED] We ONLY block if the incoming packet is STALE (lower intentId). 
    // If the packet has a current or newer intent, it means the extension has acknowledged the latest action.
    const packetIntentId = packet.playbackIntentId ?? 0;
    
    if (now < this.intentExpiry && packetIntentId < this.activeIntentId) {
        console.log(`[PlaybackController] 🛡️ Protecting active intent (${this.activeIntentId}) from stale sync (${packetIntentId})`);
        this.releaseLock();
        return;
    }

    // [INTENT ADOPTION] Track authoritative batchIntentId from extension
    if (packet.batchIntentId !== undefined && packet.batchIntentId > this.activeBatchId) {
        console.log(`[PlaybackController] 📈 Adopting newer batchIntentId: ${packet.batchIntentId}`);
        this.activeBatchId = packet.batchIntentId;
    }

    // [FIFO] Update Authoritative Queue
    if (packet.windowSentences) {
        store.setQueue(packet.windowSentences);
        this._processQueue();
    }

    // 2. [CHRONOLOGICAL SOVEREIGNTY] Adopt newer intent from authoritative extension
    if (packetIntentId > this.activeIntentId) {
        console.log(`[PlaybackController] 📈 Adopting newer intent from authoritative sync: ${packetIntentId}`);
        this.activeIntentId = packetIntentId;
    }

    // 2. [TRANSITION GUARD] Check if we just jumped (500ms).
    // During this window, we ignore index updates to prevent UI jumping.
    const isTransitioning = now < this.transitionExpiry;
    
    // 3. [ID GUARD] If the packet has an intent ID, it must match or be newer than ours
    const currentPlaybackId = store.getState().playbackIntentId;
    if (packetIntentId < currentPlaybackId) {
        console.log(`[PlaybackController] 🛡️ Rejecting stale sync (Packet ID: ${packetIntentId} < Local ID: ${currentPlaybackId})`);
        this.releaseLock();
        return;
    }

    // [STABILITY] If we are transitioning, we ONLY sync playback state (isPlaying/isPaused), 
    // we do NOT sync indices (currentSentenceIndex, etc.) because the UI is authoritative.
    if (isTransitioning) {
        console.log('[PlaybackController] 🧱 Syncing playback state ONLY (Transition Lock Active)');
        
        // Update basic playback flags but preserve indices in the store
        const currentState = store.getState();
        store.patchState({
            isPlaying: packet.isPlaying,
            isPaused: packet.isPaused ?? false,
            // Explicitly preserve current indices during transition
            state: {
                ...packet.state,
                currentSentenceIndex: currentState.state.currentSentenceIndex,
                currentChapterIndex: currentState.state.currentChapterIndex
            }
        });
        this.releaseLock();
        return;
    }

    if (packet.isPlaying && !packet.isPaused) {
      this.mode = PlaybackMode.ACTIVE;
    } else if (packet.isPlaying && packet.isPaused) {
      this.mode = PlaybackMode.PAUSED;
    } else {
      this.mode = PlaybackMode.STOPPED;
    }

    // Sync intent with truth
    this.intent = this.mode === PlaybackMode.ACTIVE ? PlaybackIntent.PLAYING :
                  this.mode === PlaybackMode.PAUSED ? PlaybackIntent.PAUSED : PlaybackIntent.STOPPED;

    WebviewStore.getInstance().updateUIState({ playbackIntent: this.intent as any });
    this.releaseLock();
  }

  public getState() {
    return {
      mode: this.mode,
      intent: this.intent,
      isAwaitingSync: this.isAwaitingSync
    };
  }

  private startWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      if (this.awaitingSync) {
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
      if (!this.ensureHandshake()) { return; }
      const store = WebviewStore.getInstance();
      const queue = store.getUIState().activeQueue;
      const { engineMode, selectedVoice, rate, state } = store.getState();
      
      if (engineMode !== 'neural' || queue.length === 0) { return; }

      // Find current index in window
      const currIdx = queue.findIndex(s => s.cIdx === state.currentChapterIndex && s.sIdx === state.currentSentenceIndex);
      if (currIdx === -1) { return; }

      // Candidates: current + next 10
      const candidates = queue.slice(currIdx, currIdx + 11);
      
      const engine = WebviewAudioEngine.getInstance();
      const client = MessageClient.getInstance();

      for (const s of candidates) {
          if (this.synthesizingKeys.size >= this.MAX_CONCURRENT_SYNTHESIS) { break; }

          const key = generateCacheKey(
              s.text,
              selectedVoice || 'default',
              rate,
              state.activeDocumentUri
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

  /**
   * [HANDSHAKE GATE] Ensures that the extension is ready and state is hydrated 
   * before allowing user-driven playback actions.
   */
  private ensureHandshake(): boolean {
      const store = WebviewStore.getInstance();
      if (!this.isHandshakeComplete || !store.isHydrated()) {
          console.warn('[PlaybackController] 🛡️ Action rejected: Handshake not complete.');
          // Optional: Trigger a refresh if we've been waiting too long
          return false;
      }
      return true;
  }
}
