import { WebviewStore } from './core/WebviewStore';
import { MessageClient } from './core/MessageClient';
import { OutgoingAction } from '@common/types';

/**
 * Hardened Playback Controller for Read Aloud Webview
 * Manages synchronous audio pausing, IPC throttling, and state reconciliation.
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

/**
 * Hardened Playback Controller for Read Aloud Webview
 * Manages synchronous audio pausing, IPC throttling, and state reconciliation.
 */
export class PlaybackController {
  private mode: PlaybackMode = PlaybackMode.STOPPED;
  private intent: PlaybackIntent = PlaybackIntent.STOPPED;
  private isAwaitingSync: boolean = false;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(
    private audio: HTMLAudioElement
  ) {
    // CRITICAL: Signal the extension host when a sentence finishes.
    // This is the engine that drives autoplay — without it, the chain breaks.
    this.audio.onended = () => {
      console.log('[PlaybackController] ✅ onended fired → signalling SENTENCE_ENDED');
      MessageClient.getInstance().postAction(OutgoingAction.SENTENCE_ENDED);
    };

    // Report audio element errors back to the extension host.
    this.audio.onerror = (e) => {
      const msg = `[PlaybackController] ⛔ Audio element error: ${(e as ErrorEvent).message ?? 'unknown'}`;
      console.error(msg);
      MessageClient.getInstance().postAction(OutgoingAction.ERROR, { message: msg });
    };
  }

  public play(currentUri: string | null): void {
    this.intent = PlaybackIntent.PLAYING;
    if (this.isAwaitingSync) {
      return;
    }
    this.setAwaitingSync(true);
    this.startWatchdog();
    
    if (!currentUri) {
      MessageClient.getInstance().postAction(OutgoingAction.LOAD_AND_PLAY);
    } else {
      MessageClient.getInstance().postAction(OutgoingAction.CONTINUE);
    }
  }

  public pause(): void {
    this.intent = PlaybackIntent.PAUSED;
    this.releaseLock(); // Clear any pending Play locks
    this.audio.pause();
    MessageClient.getInstance().postAction(OutgoingAction.PAUSE);
  }

  public stop(): void {
    this.intent = PlaybackIntent.STOPPED;
    this.releaseLock(); // Clear any pending Play locks
    this.audio.pause();
    this.audio.currentTime = 0;
    MessageClient.getInstance().postAction(OutgoingAction.STOP);
  }

  public releaseLock(): void {
    this.setAwaitingSync(false);
    this.clearWatchdog();
  }

  private setAwaitingSync(value: boolean): void {
    this.isAwaitingSync = value;
    WebviewStore.getInstance().updateUIState({ isAwaitingSync: value });
  }

    public handleSync(state: { isPlaying: boolean, isPaused?: boolean }): void {
        if (state.isPlaying && !state.isPaused) {
            this.mode = PlaybackMode.ACTIVE;
        } else if (state.isPlaying && state.isPaused) {
            this.mode = PlaybackMode.PAUSED;
        } else {
            this.mode = PlaybackMode.STOPPED;
        }

        // Sync intent with truth
        this.intent = this.mode === PlaybackMode.ACTIVE ? PlaybackIntent.PLAYING : 
                      this.mode === PlaybackMode.PAUSED ? PlaybackIntent.PAUSED : PlaybackIntent.STOPPED;

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
            this.isAwaitingSync = false;
        }, 3500);
    }

    private clearWatchdog(): void {
        if (this.watchdog) {
            clearTimeout(this.watchdog);
            this.watchdog = null;
        }
    }
}

// Global Export for Webview
(window as any).PlaybackController = PlaybackController;
