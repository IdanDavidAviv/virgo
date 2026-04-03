import { IncomingCommand, UISyncPacket, OutgoingAction } from '../../common/types';
import { WebviewStore } from './WebviewStore';
import { WebviewAudioEngine } from './WebviewAudioEngine';
import { MessageClient } from './MessageClient';

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
   * Dispatches an incoming message to the appropriate handler.
   */
  public async dispatch(command: string, data: any): Promise<void> {
    console.log('[Dispatcher] DISPATCH:', command, JSON.stringify(data));
    this.logSafeMessage(command, data);
    const store = WebviewStore.getInstance();
    const audioEngine = WebviewAudioEngine.getInstance();

    switch (command) {
      case IncomingCommand.UI_SYNC:
        this.handleUiSync(data as UISyncPacket);
        break;

      case IncomingCommand.PLAY_AUDIO:
        // Zombie Guard: If user stopped while synthesizing, ignore incoming audio (Race Condition #42)
        if (audioEngine.getIntent() === 'STOPPED') {
            console.log('[Dispatcher] ✋ Ignoring Zombie Audio (Intent is STOPPED)');
            audioEngine.releaseLock();
            return;
        }

        if (data?.data) {
          // Extension provided raw data (Synthesis Hit or Extension Cache Hit)
          audioEngine.playFromBase64(data.data, data.cacheKey, data.sequenceId);
        } else if (data?.cacheKey) {
          // Zero-IPC Prefetch Hit - try to play from local IndexedDB
          const success = await audioEngine.playFromCache(data.cacheKey);
          if (!success) {
            console.warn(`[Dispatcher] ⚠️ Cache Miss for ${data.cacheKey} - requesting fresh synthesis.`);
            audioEngine.acquireLock();
            MessageClient.getInstance().postAction(OutgoingAction.REQUEST_SYNTHESIS, { cacheKey: data.cacheKey });
          }
        }
        break;

      case IncomingCommand.STOP:
        audioEngine.stop();
        audioEngine.releaseLock();
        store.patchState({ isPlaying: false, isPaused: false });
        break;

      case IncomingCommand.PLAYBACK_STATE_CHANGED:
        // [DEFENSIVE] Only handle if it looks like a valid sync packet
        if (data && data.state) {
          this.handleUiSync(data as UISyncPacket);
        } else if (data && (data.isPlaying !== undefined || data.isPaused !== undefined)) {
          // [LEGACY/PARTIAL] Allow patching playback flags specifically
          store.patchState(data);
        } else {
          console.warn('[Dispatcher] ⚠️ Ignoring malformed PLAYBACK_STATE_CHANGED');
        }
        break;

      case IncomingCommand.PURGE_MEMORY:
        audioEngine.purgeMemory();
        break;

        case IncomingCommand.SYNTHESIS_ERROR:
        const errorMsg = data?.error || 'Synthesis failed';
        console.error(`[Dispatcher] ⛔ Synthesis Error at ${data?.chapterIndex}:${data?.sentenceIndex}:`, errorMsg);
        
        const ToastManager = (await import('../components/ToastManager')).ToastManager;
        // Restoring dashboard.js parity: warnings for fallbacks, errors for failures.
        const type = data?.isFallingBack ? 'warning' : 'error';
        ToastManager.show(errorMsg, type);
        audioEngine.releaseLock();
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
            cacheSizeBytes: data.size,
            cacheStats: { count: data.count, size: data.size }
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
      state: packet.state,
      isPlaying: packet.isPlaying,
      isPaused: packet.isPaused,
      playbackStalled: packet.playbackStalled,
      currentSentences: packet.currentSentences,
      allChapters: packet.allChapters,
      autoPlayMode: packet.autoPlayMode,
      engineMode: packet.engineMode,
      cacheCount: packet.cacheCount,
      cacheSizeBytes: packet.cacheSizeBytes,
      rate: packet.rate,
      volume: packet.volume
    } as any);

    // 2. Synchronize Physical Audio Engine with State (Volume/Rate)
    const audioEngine = WebviewAudioEngine.getInstance();
    audioEngine.setVolume(packet.volume);
    audioEngine.setRate(packet.rate);

    // 3. Clear UI-specific sync lock and watchdog timer
    // audioEngine.releaseLock(); // DEPRECATED in v1.5.3: Heartbeats should not release the playback intent lock.
    store.updateUIState({ pendingChapterIndex: -1 });
  }

  /**
   * logSafeMessage: High-density IPC logger with binary truncation.
   */
  private logSafeMessage(command: string, data: any): void {
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

    const payload = typeof data === 'object' 
      ? Object.entries(data).map(([k, v]) => `${k}:${JSON.stringify(sanitize(v))}`).join(' | ')
      : sanitize(data);

    console.log(`[HOST -> WEBVIEW] [${command.toUpperCase()}] ${payload}`);
  }
}
