import { WebviewStore } from './core/WebviewStore';
import { MessageClient } from './core/MessageClient';
import { WebviewAudioEngine } from './core/WebviewAudioEngine';
import { OutgoingAction, IncomingCommand, AudioEngineEvent, AudioEngineEventType, UISyncPacket } from '../common/types';
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
  private activeIntentId: number = 0;
  private isAwaitingSync: boolean = false;
  private watchdog: NodeJS.Timeout | null = null;
  private intentExpiry: number = 0;
  private readonly INTENT_TIMEOUT_MS = 3500; // [STABILITY] Grant 3.5s of sovereignty to user intent
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
    this.activeIntentId = 0;
    this.intentExpiry = 0;
    this.isAwaitingSync = false;
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
        console.log(`[PlaybackController] 📥 Data push for ${cacheKey} (Intent: ${intentId})`);
        WebviewAudioEngine.getInstance().ingestData(cacheKey, data, intentId);
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
      }

      // 3. [IPC] Sovereign Emission
      WebviewAudioEngine.getInstance().prepareForPlayback();
      const intentId = store.resetPlaybackIntent();
      MessageClient.getInstance().postAction(OutgoingAction.JUMP_TO_SENTENCE, { index, intentId });
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
              state: { ...currentState.state, currentChapterIndex: index, currentSentenceIndex: 0 },
              isPlaying: true,
              isPaused: false
          });
      }
      
      // 3. Optimistic UI flash
      store.updateUIState({ isAwaitingSync: true });
      
      WebviewAudioEngine.getInstance().prepareForPlayback();
      const intentId = store.resetPlaybackIntent();
      MessageClient.getInstance().postAction(OutgoingAction.JUMP_TO_CHAPTER, { index, intentId });
  }

  /**
   * selectVoice(): Switches the strategic voice ID.
   */
  public selectVoice(voiceId: string): void {
      console.log(`[PlaybackController] selectVoice(${voiceId}) requested`);
      const store = WebviewStore.getInstance();
      
      // Authoritative update
      store.patchState({ selectedVoice: voiceId });
      
      MessageClient.getInstance().postAction(OutgoingAction.VOICE_CHANGED, { voice: voiceId });
  }

  /**
   * setVolume(): Throttled volume orchestration.
   */
  private debouncedVolumeEmit = debounce((volume: number) => {
      MessageClient.getInstance().postAction(OutgoingAction.VOLUME_CHANGED, { volume });
  }, 150);

  public setVolume(volume: number): void {
      const store = WebviewStore.getInstance();
      
      // Immediate local effect for audio engine and UI feedback
      WebviewAudioEngine.getInstance().setVolume(volume);
      store.patchState({ volume });

      // [SOVEREIGNTY] Throttled IPC emission
      this.debouncedVolumeEmit(volume);
  }

  /**
   * setRate(): Throttled rate orchestration.
   */
  private debouncedRateEmit = debounce((rate: number) => {
      MessageClient.getInstance().postAction(OutgoingAction.RATE_CHANGED, { rate });
  }, 150);

  public setRate(rate: number): void {
      const store = WebviewStore.getInstance();
      
      // Immediate local effect
      WebviewAudioEngine.getInstance().setRate(rate);
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
      MessageClient.getInstance().postAction(OutgoingAction.ENGINE_MODE_CHANGED, { mode });
  }

  /**
   * clearCache(): Explicitly wipes the local and remote cache.
   */
  public clearCache(): void {
      console.log('[PlaybackController] clearCache() requested');
      WebviewAudioEngine.getInstance().wipeCache();
      MessageClient.getInstance().postAction(OutgoingAction.CLEAR_CACHE);
  }

  /**
   * handleSynthesisReady() - Sovereign fetch orchestration.
   */
  private handleSynthesisReady(cacheKey: string, intentId: number): void {
      if (intentId < this.activeIntentId) {
          console.warn(`[PlaybackController] 🛡️ Ignoring stale SYNTHESIS_READY for intent ${intentId} (current: ${this.activeIntentId})`);
          return;
      }
      
      console.log(`[PlaybackController] 🟢 Synthesis ready for intent ${intentId}. Requesting audio fetch...`);
      this.setBuffering(true);
      MessageClient.getInstance().postAction(OutgoingAction.FETCH_AUDIO, { cacheKey, intentId });
  }

  /**
   * handleEngineEvent() - Authoritative state reconciliation from the playback engine.
   */
  private handleEngineEvent(event: AudioEngineEvent): void {
    const store = WebviewStore.getInstance();
    const eventIntentId = event.intentId ?? 0;

    // [INTENT LATCH] Sovereign guard against stale reports
    if (eventIntentId < this.activeIntentId) {
        console.log(`[PlaybackController] 🛡️ Pruned stale engine event: ${event.type} (Intent: ${eventIntentId} < current: ${this.activeIntentId})`);
        return;
    }

    console.log(`[PlaybackController] 🛰️ Sovereign Event: ${event.type} | Intent: ${eventIntentId}`);

    switch (event.type) {
        case AudioEngineEventType.PLAYING:
            this.mode = PlaybackMode.ACTIVE;
            this.intent = PlaybackIntent.PLAYING;
            store.updateUIState({ 
                playbackIntent: 'PLAYING', 
                isBuffering: false, 
                isAwaitingSync: false 
            });
            break;

        case AudioEngineEventType.PAUSED:
            this.mode = PlaybackMode.PAUSED;
            this.intent = PlaybackIntent.PAUSED;
            store.updateUIState({ 
                playbackIntent: 'PAUSED',
                isAwaitingSync: false
            });
            break;

        case AudioEngineEventType.ENDED:
            this.mode = PlaybackMode.STOPPED;
            this.intent = PlaybackIntent.STOPPED;
            store.updateUIState({ 
                playbackIntent: 'STOPPED',
                isAwaitingSync: false
            });
            // Auto-advance logic usually handled by extension, 
            // but we signal the completion of local playback.
            MessageClient.getInstance().postAction(OutgoingAction.SENTENCE_ENDED, { intentId: eventIntentId });
            break;

        case AudioEngineEventType.STALLED:
            store.updateUIState({ isBuffering: true });
            store.patchState({ playbackStalled: true });
            break;

        case AudioEngineEventType.ERROR:
            console.error(`[PlaybackController] 🔴 Engine error: ${event.message}`);
            this.mode = PlaybackMode.STOPPED;
            this.intent = PlaybackIntent.STOPPED;
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
    console.log('[PlaybackController] 🟢 USER PLAY requested');
    this.activeIntentId++;
    this.intent = PlaybackIntent.PLAYING;
    this.intentExpiry = Date.now() + this.INTENT_TIMEOUT_MS;
    
    // [SYNC] Universal Unlocker: Priming on Play
    WebviewAudioEngine.getInstance().ensureAudioContext();

    const store = WebviewStore.getInstance();
    
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
    WebviewAudioEngine.getInstance().playFromCache(resolvedUri, this.activeIntentId).then(hit => {
        if (!hit) {
            console.log(`[PlaybackController] Cache miss for ${resolvedUri}. Requesting synthesis...`);
            MessageClient.getInstance().postAction(OutgoingAction.REQUEST_SYNTHESIS, { 
                cacheKey: resolvedUri, 
                intentId: this.activeIntentId 
            });
        }
    });

    MessageClient.getInstance().postAction(OutgoingAction.PLAY, { 
        cacheKey: resolvedUri, 
        intentId: this.activeIntentId 
    });
  }

  public pause(): void {
    console.log('[PlaybackController] ⏸️ USER PAUSE requested');
    this.activeIntentId++;
    this.intent = PlaybackIntent.PAUSED;
    this.intentExpiry = Date.now() + this.INTENT_TIMEOUT_MS;

    // [SYNC] Universal Unlocker: Priming on Pause
    WebviewAudioEngine.getInstance().ensureAudioContext();

    const store = WebviewStore.getInstance();
    // [RECOVERY] Clear any previous persistent stall logic
    store.resetLoadingStates();
    
    // [SYNC] Authoritative update replacing "optimisticPatch"
    store.patchState({ isPaused: true });

    store.updateUIState({ 
        playbackIntent: 'PAUSED',
        isAwaitingSync: true,
        lastStallSource: 'USER'
    });
    
    this.isAwaitingSync = true;
    this.startWatchdog();

    WebviewAudioEngine.getInstance().pause();
    MessageClient.getInstance().postAction(OutgoingAction.PAUSE, { intentId: this.activeIntentId });
  }

  public togglePlayPause(): void {
    if (this.intent === PlaybackIntent.PLAYING) {
      this.pause();
    } else {
      this.play();
    }
  }

  public stop(): void {
    console.log('[PlaybackController] ⏹️ USER STOP requested');
    this.activeIntentId++;
    this.intent = PlaybackIntent.STOPPED;
    this.intentExpiry = Date.now() + this.INTENT_TIMEOUT_MS;

    // [SYNC] Universal Unlocker: Priming on Stop
    WebviewAudioEngine.getInstance().ensureAudioContext();

    // [RECOVERY] Clear any previous persistent stall logic
    WebviewStore.getInstance().resetLoadingStates();

    // [SOVEREIGNTY] Update Store explicitly
    WebviewStore.getInstance().updateUIState({ 
        playbackIntent: 'STOPPED',
        isAwaitingSync: true, // Keep TRUE as tests expect a sync lock wait
        lastStallSource: 'USER'
    });
    
    this.isAwaitingSync = true;
    this.startWatchdog();

    WebviewAudioEngine.getInstance().stop();
    MessageClient.getInstance().postAction(OutgoingAction.STOP, { intentId: this.activeIntentId });
  }

  /**
   * [SOVEREIGNTY] Navigation intents: Always increment intentId to prune async race conditions.
   */
  public prevChapter(): void {
      this.activeIntentId++;
      this.isAwaitingSync = true;
      this.startWatchdog();

      // [SYNC] Universal Unlocker: Priming on Prev Chapter
      WebviewAudioEngine.getInstance().ensureAudioContext();

      WebviewStore.getInstance().updateUIState({ isAwaitingSync: true });
      MessageClient.getInstance().postAction(OutgoingAction.PREV_CHAPTER, { intentId: this.activeIntentId });
  }

  public nextChapter(): void {
      this.activeIntentId++;
      this.isAwaitingSync = true;
      this.startWatchdog();

      // [SYNC] Universal Unlocker: Priming on Next Chapter
      WebviewAudioEngine.getInstance().ensureAudioContext();

      WebviewStore.getInstance().updateUIState({ isAwaitingSync: true });
      MessageClient.getInstance().postAction(OutgoingAction.NEXT_CHAPTER, { intentId: this.activeIntentId });
  }

  public prevSentence(): void {
      this.activeIntentId++;
      this.isAwaitingSync = true;
      this.startWatchdog();

      // [SYNC] Universal Unlocker: Priming on Prev Sentence
      WebviewAudioEngine.getInstance().ensureAudioContext();

      WebviewStore.getInstance().updateUIState({ isAwaitingSync: true });
      MessageClient.getInstance().postAction(OutgoingAction.PREV_SENTENCE, { intentId: this.activeIntentId });
  }

  public nextSentence(): void {
      this.activeIntentId++;
      this.isAwaitingSync = true;
      this.startWatchdog();

      // [SYNC] Universal Unlocker: Priming on Next Sentence
      WebviewAudioEngine.getInstance().ensureAudioContext();

      WebviewStore.getInstance().updateUIState({ isAwaitingSync: true });
      MessageClient.getInstance().postAction(OutgoingAction.NEXT_SENTENCE, { intentId: this.activeIntentId });
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

      MessageClient.getInstance().postAction(OutgoingAction.SET_AUTO_PLAY_MODE, { mode });
  }

  public setBuffering(value: boolean): void {
    WebviewStore.getInstance().updateUIState({ isBuffering: value });
  }

  public getActiveIntentId(): number {
    return this.activeIntentId;
  }

  public acquireLock(): void {
    this.setAwaitingSync(true);
    this.startWatchdog();
  }

  public loadSnippet(path: string): void {
      console.log(`[PlaybackController] loadSnippet(${path}) requested`);
      this.activeIntentId++;
      this.setAwaitingSync(true);
      this.startWatchdog();
      MessageClient.getInstance().postAction(OutgoingAction.LOAD_SNIPPET, { path });
  }

  public releaseLock(): void {
    this.setAwaitingSync(false);
    this.clearWatchdog();
  }

  private setAwaitingSync(value: boolean): void {
    this.isAwaitingSync = value;
    WebviewStore.getInstance().updateUIState({ isAwaitingSync: value });
  }

  /**
   * handleSync() - Core reconciliation logic from dashboard.js
   */
  public handleSync(packet: { isPlaying: boolean, isPaused?: boolean }): void {
    // [SOVEREIGNTY] Respect active user intent over incoming sync packets
    const now = Date.now();
    if (now < this.intentExpiry) {
        console.log('[PlaybackController] 🛡️ Protecting active intent from stale sync');
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
      if (this.isAwaitingSync) {
        console.warn('[PlaybackController] ⏳ Sync Watchdog Fired: Lock released.');
        this.setAwaitingSync(false);
      }
    }, 3500);
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }
}
