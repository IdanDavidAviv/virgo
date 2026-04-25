import { IncomingCommand, UISyncPacket, OutgoingAction } from '../../common/types';
import { WebviewStore } from './WebviewStore';
import { WebviewAudioEngine } from './WebviewAudioEngine';
import { MessageClient } from './MessageClient';
import { PlaybackController } from '../playbackController';

/**
 * CommandDispatcher: Central IPC Router
 * Maps incoming extension messages to store updates and engine actions.
 */
export class CommandDispatcher {
  private benchmarking: Map<string, number> = new Map();
  private _pendingCommands: Map<string, { resolve: (val: any) => void, reject: (err: any) => void }> = new Map();
  private static instance: CommandDispatcher;

  private constructor() {}

  public static getInstance(): CommandDispatcher {
    if (typeof window !== 'undefined') {
      if (!(window as any).__COMMAND_DISPATCHER__) {
        (window as any).__COMMAND_DISPATCHER__ = new CommandDispatcher();
      }
      return (window as any).__COMMAND_DISPATCHER__;
    }
    if (!this.instance) {
      this.instance = new CommandDispatcher();
    }
    return this.instance;
  }

  /**
   * [BRIDGE] Sovereign RPC Initialization
   * Exposes a global hook for CDP-based command execution.
   */
  public initSovereignBridge(): void {
    if (typeof window !== 'undefined') {
      (window as any).__SOVEREIGN_RPC__ = async (commandId: string, args: any[] = []) => {
        console.log(`[RPC] Sovereign Request: ${commandId}`, args);
        const requestId = Math.random().toString(36).substring(7);
        return new Promise((resolve, reject) => {
          this._pendingCommands.set(requestId, { resolve, reject });
          MessageClient.getInstance().postAction(OutgoingAction.EXECUTE_COMMAND, { commandId, args, requestId });
          
          // Fallback timeout
          setTimeout(() => {
            if (this._pendingCommands.has(requestId)) {
               console.warn(`[RPC] ⏰ Command Timeout: ${commandId}`);
               this._pendingCommands.delete(requestId);
               reject(new Error(`Command timeout: ${commandId}`));
            }
          }, 10000);
        });
      };
      console.log('[RPC] Sovereign Bridge Initialized.');
    }
  }

  public static resetInstance(): void {
    if (typeof window !== 'undefined') {
      (window as any).__COMMAND_DISPATCHER__ = undefined;
    }
    this.instance = undefined as any;
  }

  /**
   * Mounts the dispatcher to a MessageClient for automatic command routing.
   */
  public mount(client: MessageClient): void {
    console.log('[Dispatcher] Mounting IPC Bridge...');
    Object.values(IncomingCommand).forEach(command => {
       client.onCommand(command, (data) => this.dispatch(command, data));
    });
  }

  /**
   * Dispatches an incoming message to the appropriate handler.
   */
  public async dispatch(command: string, data: any): Promise<void> {
    // [BRIDGE] HEARTBEAT
    console.log(`[BRIDGE] Message Arrived: command=${command}${command === 'uiSync' ? ' (active=' + data?.activeFileName + ')' : ''}`);

    const store = WebviewStore.getInstance();
    const audioEngine = WebviewAudioEngine.getInstance();
    const playback = PlaybackController.getInstance();

    const startTime = performance.now();
    this.logSafeMessage(command, data);

    switch (command) {
      case IncomingCommand.UI_SYNC:
        this.handleUiSync(data as UISyncPacket);
        playback.handleSync(data as UISyncPacket);
        break;

      case (IncomingCommand as any).GLOBAL_SITREP:
        this.handleSitrep();
        break;

      case IncomingCommand.PLAY_AUDIO:
        // [DECOUPLING] Relaxed Zombie Guard. 
        // We only ignore if the intentId is strictly older than the active one.
        // We no longer block based on STOPPED intent to allow auto-recovery.
        const intentId = data?.intentId ?? data?.sequenceId;
        const currentActive = audioEngine.activeIntentId;

        if (intentId !== undefined && intentId < currentActive && currentActive !== 0) {
            console.warn(`[Dispatcher] ✋ Ignoring Stale Audio Payload: intentId=${intentId} < currentActive=${currentActive}. This is the cold-boot rejection point.`);
            playback.releaseLock();
            return;
        }


        if (data?.data) {
          // Extension provided raw data (Synthesis Hit or Extension Cache Hit)
          if (!playback.userHasInteracted && !store.getState().playbackAuthorized) {
            console.warn('[Dispatcher] ✋ Playback Blocked: User has not interacted with webview yet. Ingesting but suppressing play.');
            audioEngine.ingestData(data.cacheKey, data.data, intentId);
            return;
          }
          audioEngine.playFromBase64(data.data, data.cacheKey, intentId, data.bakedRate);
        } else if (data?.cacheKey) {
          // Hint received: try local cache first
          if (!playback.userHasInteracted && !store.getState().playbackAuthorized) {
             console.warn(`[Dispatcher] ✋ Playback Blocked: Suppression for ${data.cacheKey}.`);
             return;
          }
          const success = await audioEngine.playFromCache(data.cacheKey, intentId, data.bakedRate);
          if (!success) {
            // [HARDENING] If local cache misses, the bridge might still have it (e.g., Prefetch Hit).
            // Try FETCH_AUDIO before escalating to full REQUEST_SYNTHESIS to prevent loops.
            console.log(`[Dispatcher] 🧩 Hint Cache Miss for ${data.cacheKey}. Requesting Pull (FETCH_AUDIO)...`);
            // [3.2.B] Carry bakedRate so the DATA_PUSH response can feed it back
            // to playFromCache — otherwise the pull cycle loses the rate context.
            MessageClient.getInstance().postAction(OutgoingAction.FETCH_AUDIO, { cacheKey: data.cacheKey, intentId, bakedRate: data.bakedRate });
          } else {
            console.log(`[Dispatcher] ✅ Hint Cache Hit for ${data.cacheKey}`);
          }
        }
        break;

      case IncomingCommand.SYNTHESIS_STARTING:
        console.log('[Dispatcher] ⚡ SYNTHESIS_STARTING Received', data);
        // [COLD-BOOT INTENT ADOPTION] If the extension's intentId is greater than the webview's
        // current counter (e.g. after a dev-host restart where webview resets to 1 but extension
        // retains a higher counter), adopt the extension's value to prevent first-play rejection.
        if (data?.intentId !== undefined) {
            const currentId = store.getState().playbackIntentId;
            if (data.intentId > currentId) {
                console.log(`[Dispatcher] 📈 SYNTHESIS_STARTING intent adoption: ${currentId} → ${data.intentId}`);
                store.setIntentIds(data.intentId);
            }
        }
        break;

      case IncomingCommand.SYNTHESIS_READY:
        console.log('[Dispatcher] SYNTHESIS_READY Received', data);
        // Bridge reports audio is ready in its cache. Pull it if we don't have it.
        // [INTERACTION GATE] VS Code webview Chromium does NOT enforce the browser autoplay
        // gesture policy — NotAllowedError is never thrown. We must gate manually here,
        // exactly like PLAY_AUDIO and DATA_PUSH HEAD MATCH do.
        if (!playback.userHasInteracted && !store.getState().playbackAuthorized) {
          console.warn('[Dispatcher] 🚫 SYNTHESIS_READY suppressed — awaiting first user gesture. Pre-warming cache only.');
          // Still fetch into local cache so playback is instant on first user click.
          MessageClient.getInstance().postAction(OutgoingAction.FETCH_AUDIO, { cacheKey: data.cacheKey, intentId: data.intentId });
          break;
        }
        // [SINGLE-SINK] Defense layer: non-priority signals (batch/queued pre-fetches) only
        // warm the local cache — they must not trigger play. The upstream audioBridge now routes
        // most pre-fetches via dataPush, but any that slip through the batch path arrive here
        // with isPriority:false and must be contained.
        if (!data.isPriority) {
          console.log('[Dispatcher] 📦 SYNTHESIS_READY (non-priority) — cache warm only, no play.');
          MessageClient.getInstance().postAction(OutgoingAction.FETCH_AUDIO, { cacheKey: data.cacheKey, intentId: data.intentId });
          break;
        }
        const hasLocal = await audioEngine.playFromCache(data.cacheKey, data.intentId, data.bakedRate);
        if (!hasLocal) {
          MessageClient.getInstance().postAction(OutgoingAction.FETCH_AUDIO, { cacheKey: data.cacheKey, intentId: data.intentId });
        }
        break;

      case IncomingCommand.DATA_PUSH:
        const pushTime = Date.now();
        console.log(`[Dispatcher] 📥 DATA_PUSH Received at ${pushTime}`, { 
            cacheKey: data.cacheKey, 
            intentId: data.intentId,
            hasBinary: !!data.data
        });
        // [FIX] VS Code postMessage silently drops large base64 payloads — data.data always
        // arrives as undefined. Use pull model: FETCH_AUDIO retrieves from the extension cache,
        // which is the proven delivery path (same as SYNTHESIS_READY non-priority handling).
        if (data.data) {
            // Binary arrived (e.g. future transfer mechanism) — ingest directly.
            audioEngine.ingestData(data.cacheKey, data.data, data.intentId);
        } else {
            // Binary was stripped by IPC — pull from extension cache to warm webview cache.
            console.log(`[Dispatcher] 📥 DATA_PUSH pull: requesting FETCH_AUDIO for ${data.cacheKey}`);
            MessageClient.getInstance().postAction(OutgoingAction.FETCH_AUDIO, { cacheKey: data.cacheKey, intentId: data.intentId });
        }
        break;

      case IncomingCommand.STOP:
        audioEngine.stop();
        playback.releaseLock();
        store.resetLoadingStates();
        store.patchState({ isPlaying: false, isPaused: false });
        break;

      case IncomingCommand.PLAYBACK_STATE_CHANGED:
        // [DEFENSIVE] Only handle if it looks like a valid sync packet
        if (data) {
          this.handleUiSync(data as UISyncPacket);
          playback.handleSync(data as UISyncPacket);
        } else {
          console.warn('[Dispatcher] ⚠️ Ignoring malformed PLAYBACK_STATE_CHANGED');
        }
        break;

      case IncomingCommand.PURGE_MEMORY:
        audioEngine.purgeMemory();
        break;

      case IncomingCommand.CLEAR_CACHE_WIPE:
        await audioEngine.wipeCache();
        store.resetCacheStats();
        break;

        case IncomingCommand.SYNTHESIS_ERROR:
        const errorMsg = data?.error || 'Synthesis failed';
        console.error(`[Dispatcher] Synthesis Error at ${data?.chapterIndex}:${data?.sentenceIndex}:`, errorMsg);
        
        const ToastManager = (await import('../components/ToastManager')).ToastManager;
        // Restoring dashboard.js parity: warnings for fallbacks, errors for failures.
        const type = data?.isFallingBack ? 'warning' : 'error';
        ToastManager.show(errorMsg, type);
        playback.releaseLock();
        break;
      
      case IncomingCommand.ENGINE_STATUS:
        // Handle engine-specific status updates if needed
        console.log('[Dispatcher] Engine Status:', data);
        break;

      case IncomingCommand.VOICES:
        console.log(`[Dispatcher] 🔊 VOICES Packet Received (Local: ${data.voices?.length}, Neural: ${data.neural?.length})`);
        store.patchState({
          availableVoices: {
            local: data.voices || [],
            neural: data.neural || []
          },
          isLoadingVoices: false, // Release the manual refresh lock
          ...(data.selectedVoice && { selectedVoice: data.selectedVoice }),
          ...(data.engineMode && { engineMode: data.engineMode })
        });
        break;

      case IncomingCommand.CACHE_STATS:
      case IncomingCommand.CACHE_STATS_UPDATE:
        const count = data.count ?? 0;
        const sizeBytes = data.sizeBytes ?? data.size ?? 0;
        store.patchState({
            cacheCount: count,
            cacheSizeBytes: sizeBytes,
            neuralBuffer: {
                count: count,
                sizeMb: Number((sizeBytes / (1024 * 1024)).toFixed(2))
            }
        });
        break;



      case IncomingCommand.SENTENCE_CHANGED:
        const currentState = store.getState();
        if (currentState) {
            store.patchState({
                currentSentenceIndex: data.index,
                // [HARDENING] If text is provided, we treat it as an authoritative injection 
                // to prevent "Dead UI" during sync race conditions.
                ...(data.text && { currentChapterIndex: data.chapterIndex ?? currentState.currentChapterIndex }),
                // We don't store text directly in the state, but this triggers reactivity 
                // for components listening to the index.
            });
            
            // [PARITY] If the dispatcher receives text, we ensure the AudioEngine/PlaybackController 
            // knows about the upcoming sentence.
            if (data.text) {
                console.log(`[Dispatcher] Auth Sentence Injection: ${data.text.substring(0, 30)}...`);
            }
        }
        break;

      case IncomingCommand.COMMAND_RESULT:
        const { requestId, success, result, error } = data;
        const pending = this._pendingCommands.get(requestId);
        if (pending) {
          if (success) {
            pending.resolve(result);
          } else {
            pending.reject(new Error(error || 'Unknown command error'));
          }
          this._pendingCommands.delete(requestId);
        }
        break;

      default:
    }

    const duration = performance.now() - startTime;
    if (duration > 50) {
        console.warn(`[Dispatcher] 🐌 Slow Command: ${command} took ${duration.toFixed(2)}ms`);
    }
  }

  private handleSitrep(): void {
    const store = WebviewStore.getInstance();
    const audioEngine = WebviewAudioEngine.getInstance();
    const playback = PlaybackController.getInstance();

    const report = {
        timestamp: Date.now(),
        store: store.getState(),
        audioEngine: {
            activeIntentId: audioEngine.activeIntentId,
            isBusy: audioEngine.isBusy(),
            instanceId: audioEngine.instanceId
        },
        playback: {
            isLocked: (playback as any)._playbackMutexPromise !== undefined
        }
    };

    console.log('[Dispatcher] GLOBAL SITREP DUMP:', report);
    MessageClient.getInstance().postAction(OutgoingAction.LOG, { 
        level: 'info', 
        message: `SITREP: intent=${report.audioEngine.activeIntentId} isPlaying=${report.store.isPlaying}` 
    });
  }

  private handleUiSync(packet: UISyncPacket): void {
    if (!packet) {
        console.warn('[Dispatcher] 🛑 Refusing to sync null/undefined packet');
        return;
    }
    
    const store = WebviewStore.getInstance();
    const isLocked = store.getUIState().isAwaitingSync;

    if (isLocked) {
        console.log(`[Dispatcher] 🛡️ Incoming sync during lock (intent to play: ${packet.isPlaying})`);
    }

    // 1. Update the reactive store (init/hydrate)
    store.updateState(packet);

    // 2. Synchronize Physical Audio Engine with State (Volume/Rate)
    const audioEngine = WebviewAudioEngine.getInstance();
    if (packet.volume !== undefined && packet.volume !== null) {
      audioEngine.setVolume(packet.volume);
    }
    // [RATE_HARDENING] Rate is applied reactively via WebviewAudioEngine.setupStoreListeners()
    // which subscribes to store.rate. Do NOT call audioEngine.setRate() here — store.updateState()
    // above already triggers the subscription, preventing double application on every UI_SYNC.

    // 3. Clear UI-specific sync lock and watchdog timer
    // audioEngine.releaseLock(); // DEPRECATED in v1.5.3: Heartbeats should not release the playback intent lock.
    store.updateUIState({ pendingChapterIndex: -1 });
  }

  /**
   * logSafeMessage: High-density IPC logger with legacy parity formatting.
   */
  private logSafeMessage(command: string, data: any): void {
    // Silence noisy/repetitive commands
    if (command === IncomingCommand.UI_SYNC || 
        command === IncomingCommand.PROGRESS || 
        command === IncomingCommand.CACHE_STATS || 
        !data) { return; }

    const sanitize = (val: any): any => {
      if (val === null || val === undefined) { return val; }
      if (Array.isArray(val)) { return val.length > 5 ? `[CNT:${val.length}]` : val.map(sanitize); }
      if (typeof val === 'string') {
        if (val.length > 1000) { return `[BIN:${Math.round(val.length / 1024)}KB]`; }
        if (val.includes('file:///')) { return val.split(/[\\/]/).pop(); }
        return val.length > 64 ? val.substring(0, 61) + '...' : val;
      }
      if (typeof val === 'object') {
        const s: any = {};
        for (const k in val) { s[k] = sanitize((val as any)[k]); }
        return s;
      }
      return val;
    };

    // Convert camelCase to SNAKE_CASE for legacy console parity (e.g. playAudio -> PLAY_AUDIO)
    const formattedCommand = command
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .toUpperCase();

    const payload = typeof data === 'object' 
      ? Object.entries(data).map(([k, v]) => `${k}:${JSON.stringify(sanitize(v))}`).join(' | ')
      : JSON.stringify(sanitize(data));

    console.log(`[HOST -> WEBVIEW] [${formattedCommand}] ${payload}`);
  }
}
