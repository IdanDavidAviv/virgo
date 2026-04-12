import { IncomingCommand, LogLevel, OutgoingAction, UISyncPacket } from '@common/types';

/**
 * MessageClient singleton for webview-to-extension communication.
 * Encapsulates the VS Code Webview API and provides type-safe IPC.
 */
export class MessageClient {
  private static instance: MessageClient | null = null;
  private vscode: any;
  private handlers: Map<string, Array<(payload: any) => void>> = new Map();
  private messageListener: ((event: MessageEvent) => void) | null = null;
  private _logLevel: LogLevel = LogLevel.STANDARD;
  private _cacheManager: any = null; // Attached via attachCacheManager()


  private constructor() {
    // VS Code API acquireVsCodeApi can only be called ONCE per session.
    // We check window.vscode first to prevent fatal errors and support legacy scripts.
    if ((window as any).vscode) {
      this.vscode = (window as any).vscode;
    } else if ((window as any).acquireVsCodeApi) {
      this.vscode = (window as any).acquireVsCodeApi();
      (window as any).vscode = this.vscode;
    } else {
      console.warn('[MessageClient] acquireVsCodeApi is not available. Are you in a VS Code webview?');
    }

    // Initialize LogLevel from Bootstrap Config if available
    const config = (window as any).__BOOTSTRAP_CONFIG__;
    if (config && config.logLevel) {
      this._logLevel = config.logLevel;
    }

    if (typeof window !== 'undefined') {
      this.messageListener = (event) => this.handleMessage(event);
      console.log('[MessageClient] Adding listener to window');
      window.addEventListener('message', this.messageListener);
    }
  }

  /**
   * Explicitly attach a CacheManager instance to handle manifest syncing.
   * Prevents circular dependency at construction time.
   */
  public attachCacheManager(manager: any): void {
      if (!manager) {
          console.warn('[MessageClient] ⚠️ Attempted to attach null CacheManager.');
          return;
      }
      this._cacheManager = manager;
      console.log('[MessageClient] 🔗 CacheManager attached to IPC bridge.');
      
      // Wire up delta listener for real-time manifest updates
      this._cacheManager.setOnDeltaListener((delta: any) => {
          this.postAction(OutgoingAction.REPORT_CACHE_DELTA, delta);
      });
  }

  /**
   * Returns the singleton instance of MessageClient.
   */
  public static getInstance(): MessageClient {
    if (typeof window !== 'undefined') {
      if (!(window as any).__MESSAGE_CLIENT__) {
        (window as any).__MESSAGE_CLIENT__ = new MessageClient();
      }
      return (window as any).__MESSAGE_CLIENT__;
    }
    if (!MessageClient.instance) {
      MessageClient.instance = new MessageClient();
    }
    return MessageClient.instance;
  }

  /**
   * Resets the singleton instance and disposes of current listeners.
   */
  public static resetInstance(): void {
    if (typeof window !== 'undefined') {
      if ((window as any).__MESSAGE_CLIENT__) {
        (window as any).__MESSAGE_CLIENT__.dispose();
        (window as any).__MESSAGE_CLIENT__ = null;
      }
    }
    if (MessageClient.instance) {
      MessageClient.instance.dispose();
    }
    MessageClient.instance = null;
  }

  /**
   * Disposes of the instance by removing global event listeners and clearing handlers.
   */
  public dispose(): void {
    if (typeof window !== 'undefined' && this.messageListener) {
      window.removeEventListener('message', this.messageListener);
      this.messageListener = null;
    }
    this.handlers.clear();
  }

  /**
   * Sends an action to the extension.
   * @param action The OutgoingAction to send.
   * @param payload The payload data associated with the action.
   * @param silent If true, suppresses console logging for this specific call.
   */
  public postAction<T = any>(action: OutgoingAction, payload?: T, silent = false): void {
    if (!this.vscode) {
      console.warn(`[MessageClient] Cannot post action ${action}: VS Code API not available.`);
      return;
    }

    if (!silent) {
      if (this._logLevel === LogLevel.VERBOSE) {
        console.log(`[ACTION] ${action} | ${JSON.stringify(payload || '')}`);
      } else {
        const summary = this.summarize(payload);
        console.log(`[ACTION] ${action} | ${JSON.stringify(summary || '')}`);
      }
    }

    const message: any = { command: action };
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      Object.assign(message, payload);
    } else if (payload !== undefined) {
      message.payload = payload;
    }

    this.vscode.postMessage(message);
  }

  /**
   * Summarizes complex objects (arrays/large strings) for clean logging.
   */
  private summarize(obj: any): any {
    if (obj === null || obj === undefined) { return obj; }
    
    // VERBOSE mode bypasses summarization
    if (this._logLevel === LogLevel.VERBOSE) { return obj; }

    if (Array.isArray(obj)) {
      return `[Array(${obj.length})]`;
    }
    if (typeof obj === 'string' && obj.length > 50) {
      return `${obj.substring(0, 47)}...`;
    }
    if (typeof obj === 'object') {
      const summary: any = {};
      for (const [key, value] of Object.entries(obj)) {
        summary[key] = this.summarize(value);
      }
      return summary;
    }
    return obj;
  }

  /**
   * [DEFENSE] Sanitization Layer
   * Ensures UISyncPacket properties are concrete before store hydration.
   */
  private sanitizeUISync(packet: UISyncPacket): UISyncPacket {
    if (!packet || typeof packet !== 'object') {
      return {} as any;
    }

    // Create a shallow clone of the packet
    const p = { ...packet };
    
    // Ensure numeric fields are concrete (Prevent undefined propagation)
    p.currentChapterIndex = typeof p.currentChapterIndex === 'number' ? p.currentChapterIndex : 0;
    p.currentSentenceIndex = typeof p.currentSentenceIndex === 'number' ? p.currentSentenceIndex : 0;
    p.volume = typeof p.volume === 'number' ? p.volume : 50;
    p.rate = (typeof p.rate === 'number' && p.rate > 0) ? p.rate : 1.0;
    
    // Ensure boolean fields are concrete
    p.isPlaying = !!p.isPlaying;
    p.isPaused = !!p.isPaused;
    p.playbackStalled = !!p.playbackStalled;

    // Sanitize collection fields on the packet itself
    p.allChapters = p.allChapters || [];
    p.currentSentences = p.currentSentences || [];
    p.snippetHistory = p.snippetHistory || [];
    p.playbackIntentId = p.playbackIntentId ?? 0;
    p.activeSessionId = p.activeSessionId || '';
    
    return p;
  }

  /**
   * Converts a packet to a high-density shorthand string for standard logging.
   */
  private toShorthand(command: string, payload: any): string {
    if (command === IncomingCommand.UI_SYNC) {
      const p = payload as UISyncPacket;
      const c = p.currentChapterIndex ?? '?';
      const s = p.currentSentenceIndex ?? '?';
      const status = p.isPlaying ? 'PLAY' : (p.isPaused ? 'PAUSE' : 'STOP');
      
      let cacheInfo = '';
      if (p.cacheCount !== undefined) {
          const sizeMB = ((p.cacheSizeBytes || 0) / (1024 * 1024)).toFixed(2);
          cacheInfo = ` | Cache: ${p.cacheCount} (${sizeMB}MB)`;
      }

      return `State: ${status} | Progress: C${c}S${s}${cacheInfo} | IX: ${p.playbackIntentId || '0'}`;
    }
    
    if (command === IncomingCommand.CACHE_STATS || command === IncomingCommand.CACHE_STATS_UPDATE) {
      return `Count: ${payload.count} | Size: ${payload.size || payload.sizeBytes || 0} bytes`;
    }

    if (command === IncomingCommand.SENTENCE_CHANGED) {
      return `Idx: ${payload.index} | Text: ${payload.text?.substring(0, 30) || ''}...`;
    }

    if (command === IncomingCommand.CLEAR_CACHE_WIPE) {
      return `WIPE_COMPLETE`;
    }

    if (command === IncomingCommand.SYNTHESIS_STARTING) {
      return `Key: ${payload.cacheKey}`;
    }

    if (command === IncomingCommand.SYNTHESIS_READY) {
      return `Key: ${payload.cacheKey} | Intent: ${payload.intentId}`;
    }

    if (command === IncomingCommand.SPEAK_LOCAL) {
      return `Text: ${payload.text?.substring(0, 20)}... | Intent: ${payload.intentId}`;
    }

    if (command === IncomingCommand.ENGINE_STATUS) {
      return `Status: ${payload.status} | Intent: ${payload.intentId || '0'}`;
    }

    return JSON.stringify(this.summarize(payload) || '');
  }

  /**
   * Registers a listener for an incoming command from the extension.
   * @param command The IncomingCommand to listen for.
   * @param callback The function to call when the command is received.
   */
  public onCommand<T = any>(command: IncomingCommand, callback: (payload: T) => void): void {
    const cmdStr = command as string;
    if (!this.handlers.has(cmdStr)) {
      this.handlers.set(cmdStr, []);
    }
    this.handlers.get(cmdStr)?.push(callback);
  }

  /**
   * Internal message handler that routes incoming window messages to registered callbacks.
   */
  public handleMessage(event: any): void {
    const message = event.data;
    const { command, payload, ...rest } = message;
    if (!command) {
      return;
    }

    // Support both legacy spread structure and new nested payload structure
    let finalPayload = (payload !== undefined ? payload : (Object.keys(rest).length > 0 ? rest : message));

    // [DEFENSE] Apply sanitization to UI_SYNC
    if (command === IncomingCommand.UI_SYNC) {
      finalPayload = this.sanitizeUISync(finalPayload);
    }

    // Update log level if present in sync packet
    if (command === IncomingCommand.UI_SYNC && finalPayload.logLevel) {
      this._logLevel = finalPayload.logLevel;
    }

    const isInternalCommand = command === IncomingCommand.UI_SYNC || 
                             command === IncomingCommand.VOICES || 
                             command === IncomingCommand.PLAY_AUDIO || 
                             command === IncomingCommand.STOP ||
                             command === IncomingCommand.DATA_PUSH ||
                             command === IncomingCommand.CACHE_STATS ||
                             command === IncomingCommand.CACHE_STATS_UPDATE ||
                             command === IncomingCommand.SYNTHESIS_STARTING ||
                             command === IncomingCommand.SYNTHESIS_READY ||
                             command === IncomingCommand.ENGINE_STATUS ||
                             command === IncomingCommand.SPEAK_LOCAL ||
                             command === IncomingCommand.SENTENCE_CHANGED ||
                             command === IncomingCommand.CLEAR_CACHE_WIPE;

    if (isInternalCommand) {
      if (this._logLevel === LogLevel.VERBOSE) {
        if (command === IncomingCommand.UI_SYNC) {
          // [BLOAT-PREVENTION] Truncate massive state packets even in VERBOSE mode.
          const summarized = { ...finalPayload };
          if (summarized.allChapters) {summarized.allChapters = `[Array(${summarized.allChapters.length})]`;}
          if (summarized.windowSentences) {summarized.windowSentences = `[Array(${summarized.windowSentences.length})]`;}
          if (summarized.currentSentences) {summarized.currentSentences = `[Array(${summarized.currentSentences.length})]`;}
          console.log(`[SIGNAL] ${command} | ${JSON.stringify(summarized)}`);
        } else {
          console.log(`[SIGNAL] ${command} | ${JSON.stringify(message)}`);
        }
      } else {
        const shorthand = this.toShorthand(command, finalPayload);
        console.log(`[SIGNAL] ${command} | ${shorthand}`);
      }
    }

    const commandHandlers = this.handlers.get(command);
    if (commandHandlers) {
      commandHandlers.forEach((handler) => handler(finalPayload));
    } else if (!isInternalCommand) {
      console.warn(`[MessageClient] Unhandled Command: ${command}`);
    }
  }
}
