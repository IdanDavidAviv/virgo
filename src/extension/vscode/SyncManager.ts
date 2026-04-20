import * as vscode from 'vscode';
import { StateStore } from '@core/stateStore';
import { DashboardRelay } from './dashboardRelay';
import { SnippetHistory } from '../../common/types';

export class SyncManager implements vscode.Disposable {
    private _disposables: vscode.Disposable[] = [];
    private _syncTimer?: NodeJS.Timeout;
    private _needsSync: boolean = false;
    private _view?: vscode.WebviewView;
    private _activeSessionId: string = 'SESSION-ID-MISSING';
    private _pendingSnippetHistory: SnippetHistory | null = null;
    // [Gate 1] Startup Orchestration — relay must be attached before any flush can proceed.
    // Syncs arriving before setView() are buffered in _needsSync and flushed on first attach.
    private _isRelayAttached: boolean = false;
    // [Gate 5] Startup Orchestration — debounce coalescer. All requestSync() calls within a 50ms
    // window collapse into a single flush. Prevents 4–6 redundant UI_SYNC packets during boot.
    private static readonly COALESCE_MS = 50;
    // [Gate 5 Addendum] Steady-state playback coalesce: suppress state-equivalent flushes
    // during active playback. Reset to '' on intent change or idle state.
    private _lastFlushHash: string = '';
    // Tracks playback state for the hash guard — updated via setPlayingState().
    private _isPlaying: boolean = false;

    constructor(
        private readonly _stateStore: StateStore,
        private readonly _dashboardRelay: DashboardRelay,
        private readonly _logger: (msg: string) => void
    ) {
        // Subscribe to StateStore changes reactively
        this._stateStore.on('change', () => this.requestSync());
    }

    /**
     * Update the active session ID for parity.
     */
    public setSessionId(sessionId: string) {
        this._activeSessionId = sessionId;
        this.requestSync(true); // Immediate sync on session pivot
    }

    /**
     * Set or update the webview view reference for visibility tracking.
     * [Gate 1] Opening the relay-attached gate on first non-null view.
     */
    public setView(view: vscode.WebviewView | undefined) {
        this._view = view;

        if (view && !this._isRelayAttached) {
            this._isRelayAttached = true; // Gate opens exactly once — never resets
            this._logger('[SYNC] 🟢 Relay attached. Gate open — flushing buffered sync.');
            this.requestSync(true);        // Drain anything buffered during cold boot
        } else if (view && view.visible && (this._needsSync || this._syncTimer)) {
            // [Visibility Guard] View became visible with pending sync (either buffered or
            // a coalesced timer in-flight) — cancel the timer and drain immediately.
            this._logger('[SYNC] 🔔 View revealed with buffered sync — flushing.');
            this.requestSync(true);
        }
    }


    /**
     * Request a UI synchronization.
     * @param immediate If true, bypasses the throttle timer.
     * @param snippetHistory Optional history to include in the packet.
     */
    public requestSync(immediate: boolean = false, snippetHistory?: SnippetHistory) {
        // Buffer history if provided
        if (snippetHistory) {
            this._pendingSnippetHistory = snippetHistory;
        }

        // [Gate 1] Do not flush until the DashboardRelay has a live view attached.
        // All pre-attach syncs are silently buffered in _needsSync.
        if (!this._isRelayAttached) {
            this._needsSync = true;
            return;
        }

        if (immediate) {
            this._flush();
            return;
        }

        if (this._syncTimer) {
            return;
        }

        this._syncTimer = setTimeout(() => {
            this._syncTimer = undefined;
            this._flush();
        }, SyncManager.COALESCE_MS);
    }

    /**
     * Update the isPlaying state so the Gate 5 Addendum hash guard works correctly.
     * Call this whenever the extension's playback state changes.
     */
    public setPlayingState(isPlaying: boolean): void {
        this._isPlaying = isPlaying;
        if (!isPlaying) {
            // Clear hash on idle — always allow the next flush to pass through
            this._lastFlushHash = '';
        }
    }

    private _flush() {
        if (this._syncTimer) {
            clearTimeout(this._syncTimer);
            this._syncTimer = undefined;
        }

        // [Visibility Guard] If the view is hidden, buffer for the next reveal.
        if (this._view && !this._view.visible) {
            this._needsSync = true;
            return;
        }

        // [Gate 5 Addendum] During active playback, suppress state-equivalent flushes.
        // This prevents document observer ticks from emitting redundant UI_SYNC packets
        // when nothing has actually changed (same chapters, intent, hydrated, isPlaying).
        if (this._isPlaying) {
            const state = this._stateStore.state;
            const hash = `v2::${this._activeSessionId}::${state.activeContentHash}::${state.currentChapterIndex}::${state.playbackIntentId}::${state.isHydrated}::${this._dashboardRelay.isPlaybackAuthorized}`;
            
            if (hash === this._lastFlushHash) {
                return; // Absorbed — state is equivalent, no change to broadcast
            }
            this._lastFlushHash = hash;
        }

        const historyToSync = this._pendingSnippetHistory;
        this._pendingSnippetHistory = null;

        this._needsSync = false;
        this._dashboardRelay.sync(historyToSync ?? undefined, this._activeSessionId);
    }

    public dispose() {
        this._disposables.forEach(d => d.dispose());
        if (this._syncTimer) {
            clearTimeout(this._syncTimer);
        }
    }
}
