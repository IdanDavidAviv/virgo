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
        private vscode: { postMessage: (msg: any) => void },
        private audio: HTMLAudioElement
    ) {}

    public play(currentUri: string | null): void {
        this.intent = PlaybackIntent.PLAYING;
        if (this.isAwaitingSync) {
            return;
        }
        this.isAwaitingSync = true;
        this.startWatchdog();
        
        if (!currentUri) {
            this.vscode.postMessage({ command: 'loadAndPlay' });
        } else {
            this.vscode.postMessage({ command: 'continue' });
        }
    }

    public pause(): void {
        this.intent = PlaybackIntent.PAUSED;
        this.releaseLock(); // Clear any pending Play locks
        this.audio.pause();
        this.vscode.postMessage({ command: 'pause' });
    }

    public stop(): void {
        this.intent = PlaybackIntent.STOPPED;
        this.releaseLock(); // Clear any pending Play locks
        this.audio.pause();
        this.audio.currentTime = 0;
        this.vscode.postMessage({ command: 'stop' });
    }

    public releaseLock(): void {
        this.isAwaitingSync = false;
        this.clearWatchdog();
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
