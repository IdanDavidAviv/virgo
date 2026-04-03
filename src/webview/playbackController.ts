import { WebviewStore } from './core/WebviewStore';
import { MessageClient } from './core/MessageClient';
import { WebviewAudioEngine } from './core/WebviewAudioEngine';
import { OutgoingAction } from '../common/types';

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
  private isAwaitingSync: boolean = false;
  private watchdog: NodeJS.Timeout | null = null;
  private audio: HTMLAudioElement;

  private constructor() {
    this.audio = WebviewAudioEngine.getInstance().getAudioElement();
    this.setupListeners();
  }

  public static getInstance(): PlaybackController {
    if (typeof window !== 'undefined') {
        if (!(window as any).__PLAYBACK_CONTROLLER__) {
            (window as any).__PLAYBACK_CONTROLLER__ = new PlaybackController();
        }
        return (window as any).__PLAYBACK_CONTROLLER__;
    }
    if (!this.instance) {
      this.instance = new PlaybackController();
    }
    return this.instance;
  }

  public static resetInstance(): void {
    if (typeof window !== 'undefined') {
        (window as any).__PLAYBACK_CONTROLLER__ = undefined;
    }
    this.instance = undefined as any;
  }

  private setupListeners(): void {
    // Report audio element errors back to the extension host.
    this.audio.onerror = (e) => {
      const msg = `[PlaybackController] ⛔ Audio element error: ${(e as ErrorEvent).message ?? 'unknown'}`;
      console.error(msg);
      MessageClient.getInstance().postAction(OutgoingAction.ERROR, { message: msg });
    };
  }

  /**
   * play() - Re-implements dashboard.js logic for CONTINUE vs LOAD_AND_PLAY
   */
  public play(currentUri: string | null = null): void {
    console.log('[PlaybackController] play() requested', { currentUri, isAwaitingSync: this.isAwaitingSync });
    
    this.intent = PlaybackIntent.PLAYING;
    if (this.isAwaitingSync) {
      return;
    }

    // [RESPONSIVE] Atomic transition
    WebviewStore.getInstance().optimisticPatch({ isPaused: false }, { isAwaitingSync: true });
    
    this.setAwaitingSync(true);
    this.startWatchdog();

    const resolvedUri = currentUri || WebviewStore.getInstance().getSentenceKey();
    MessageClient.getInstance().postAction(OutgoingAction.PLAY, resolvedUri ? { cacheKey: resolvedUri } : {});
  }

  public pause(): void {
    this.intent = PlaybackIntent.PAUSED;
    // [RESPONSIVE] Atomic transition
    WebviewStore.getInstance().optimisticPatch({ isPaused: true }, { isAwaitingSync: true });
    
    this.releaseLock(); 
    this.audio.pause();
    MessageClient.getInstance().postAction(OutgoingAction.PAUSE);
  }

  public togglePlayPause(): void {
    if (this.intent === PlaybackIntent.PLAYING) {
      this.pause();
    } else {
      this.play();
    }
  }

  public stop(): void {
    this.intent = PlaybackIntent.STOPPED;
    // [RESPONSIVE] Atomic transition
    WebviewStore.getInstance().optimisticPatch({ isPlaying: false, isPaused: true }, { isAwaitingSync: true });
    
    this.releaseLock();
    WebviewAudioEngine.getInstance().stop();
    MessageClient.getInstance().postAction(OutgoingAction.STOP);
  }

  public acquireLock(): void {
    this.setAwaitingSync(true);
    this.startWatchdog();
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
