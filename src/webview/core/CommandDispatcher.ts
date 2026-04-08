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
    console.log('[Dispatcher] 🛰️ Mounting IPC Bridge...');
    Object.values(IncomingCommand).forEach(command => {
       client.onCommand(command, (data) => this.dispatch(command, data));
    });
  }

  /**
   * Dispatches an incoming message to the appropriate handler.
   */
  public async dispatch(command: string, data: any): Promise<void> {
    const store = WebviewStore.getInstance();
    const audioEngine = WebviewAudioEngine.getInstance();
    const playback = PlaybackController.getInstance();

    this.logSafeMessage(command, data);

    switch (command) {
      case IncomingCommand.UI_SYNC:
        this.handleUiSync(data as UISyncPacket);
        playback.handleSync(data as UISyncPacket);
        break;

      case IncomingCommand.PLAY_AUDIO:
        // Zombie Guard: Prune late-arriving packets from previous context.
        const isControllerStopped = playback.getState().intent === 'STOPPED';
        const isDataPayload = !!data?.data;
        
        if (isControllerStopped && isDataPayload) {
            console.log('[Dispatcher] ✋ Ignoring Zombie Audio Payload (Controller Intent is STOPPED)');
            playback.releaseLock();
            return;
        }

        // [SOVEREIGNTY] Playback intent handled by PlaybackController
        const intentId = data?.intentId ?? data?.sequenceId;

        if (data?.data) {
          // Extension provided raw data (Synthesis Hit or Extension Cache Hit)
          audioEngine.playFromBase64(data.data, data.cacheKey, intentId);
        } else if (data?.cacheKey) {
          // Hint received: try local cache first
          const success = await audioEngine.playFromCache(data.cacheKey, intentId);
          if (!success) {
            // [HARDENING] If local cache misses, the bridge might still have it (e.g., Prefetch Hit).
            // Try FETCH_AUDIO before escalating to full REQUEST_SYNTHESIS to prevent loops.
            console.log(`[Dispatcher] 🧩 Hint Cache Miss for ${data.cacheKey}. Requesting Pull (FETCH_AUDIO)...`);
            MessageClient.getInstance().postAction(OutgoingAction.FETCH_AUDIO, { cacheKey: data.cacheKey, intentId });
          } else {
            console.log(`[Dispatcher] ✅ Hint Cache Hit for ${data.cacheKey}`);
          }
        }
        break;

      case IncomingCommand.SYNTHESIS_STARTING:
        console.log('[Dispatcher] ⚡ SYNTHESIS_STARTING Received', data);
        // [PASSIVE] Engine no longer manages adaptive wait; handled by PlaybackController watchdog.
        break;

      case IncomingCommand.SYNTHESIS_READY:
        console.log('[Dispatcher] ✨ SYNTHESIS_READY Received', data);
        // Bridge reports audio is ready in its cache. Pull it if we don't have it.
        const hasLocal = await audioEngine.playFromCache(data.cacheKey, data.intentId);
        if (!hasLocal) {
          MessageClient.getInstance().postAction(OutgoingAction.FETCH_AUDIO, { cacheKey: data.cacheKey, intentId: data.intentId });
        }
        break;

      case IncomingCommand.DATA_PUSH:
        console.log('[Dispatcher] 📥 DATA_PUSH Received', { cacheKey: data.cacheKey, intentId: data.intentId });
        audioEngine.ingestData(data.cacheKey, data.data, data.intentId);
        break;

      case IncomingCommand.STOP:
        audioEngine.stop();
        playback.releaseLock();
        store.patchState({ isPlaying: false, isPaused: false });
        break;

      case IncomingCommand.PLAYBACK_STATE_CHANGED:
        // [DEFENSIVE] Only handle if it looks like a valid sync packet
        if (data && data.state) {
          this.handleUiSync(data as UISyncPacket);
          playback.handleSync(data as UISyncPacket);
        } else if (data && (data.isPlaying !== undefined || data.isPaused !== undefined)) {
          // [LEGACY/PARTIAL] Allow patching playback flags specifically
          store.patchState(data);
          playback.handleSync(data);
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
        console.error(`[Dispatcher] ⛔ Synthesis Error at ${data?.chapterIndex}:${data?.sentenceIndex}:`, errorMsg);
        
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
        store.patchState({
          availableVoices: {
            local: data.voices || [],
            neural: data.neuralVoices || []
          },
          ...(data.selectedVoice && { selectedVoice: data.selectedVoice }),
          ...(data.engineMode && { engineMode: data.engineMode }),
          neuralVoices: data.neuralVoices || [],
          engineMode: data.engineMode
        });
        break;

      case IncomingCommand.CACHE_STATS:
        store.patchState({
            cacheCount: data.count,
            cacheSizeBytes: data.size !== undefined ? data.size : data.sizeBytes,
            cacheStats: { count: data.count, size: data.size !== undefined ? data.size : data.sizeBytes }
        });
        store.updateUIState({
            neuralBuffer: {
                count: data.count,
                sizeMb: Number(((data.size !== undefined ? data.size : data.sizeBytes) / (1024 * 1024)).toFixed(2))
            }
        });
        break;

      case IncomingCommand.CACHE_STATS_UPDATE:
        store.patchState({ 
            cacheSizeBytes: data.sizeBytes, 
            cacheCount: data.count,
            cacheStats: { count: data.count, size: data.sizeBytes }
        });
        store.updateUIState({
            neuralBuffer: {
                count: data.count,
                sizeMb: Number((data.sizeBytes / (1024 * 1024)).toFixed(2))
            }
        });
        break;



      case IncomingCommand.SENTENCE_CHANGED:
        const currentState = store.getState();
        if (currentState) {
            store.patchState({
                state: {
                    ...currentState.state,
                    currentSentenceIndex: data.index
                }
            });
        }
        break;


      default:
        console.warn(`[Dispatcher] ⚠️ Unhandled command: ${command}`, data);
        break;
    }
  }

  private handleUiSync(packet: UISyncPacket): void {
    if (!packet || !packet.state) {
        console.warn('[Dispatcher] 🛑 Refusing to sync malformed packet (missing state)');
        return;
    }
    
    const store = WebviewStore.getInstance();
    const isLocked = store.getUIState().isAwaitingSync;

    if (isLocked) {
        console.log(`[Dispatcher] 🛡️ Incoming sync during lock (intent to play: ${packet.isPlaying})`);
    }

    // 1. Update the reactive store (init/hydrate)
    store.updateState({
      ...packet,
      state: packet.state
    } as any);

    // 2. Synchronize Physical Audio Engine with State (Volume/Rate)
    const audioEngine = WebviewAudioEngine.getInstance();
    if (packet.volume !== undefined && packet.volume !== null) {
      audioEngine.setVolume(packet.volume);
    }
    if (packet.rate !== undefined && packet.rate !== null) {
      audioEngine.setRate(packet.rate);
    }

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
