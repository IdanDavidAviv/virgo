import * as vscode from 'vscode';
import { StateStore } from '@core/stateStore';
import { DashboardRelay } from './dashboardRelay';
import { SnippetHistory } from '../../common/types';

export class SyncManager implements vscode.Disposable {
    private _disposables: vscode.Disposable[] = [];
    private _syncTimer?: NodeJS.Timeout;
    private _needsSync: boolean = false;
    private _view?: vscode.WebviewView;
    // [Gate 1] Startup Orchestration — relay must be attached before any flush can proceed.
    // Syncs arriving before setView() are buffered in _needsSync and flushed on first attach.
    private _isRelayAttached: boolean = false;
    // [Gate 5] Startup Orchestration — debounce coalescer. All requestSync() calls within a 100ms
    // window collapse into a single flush. Prevents 4–6 redundant UI_SYNC packets during boot.
    private static readonly COALESCE_MS = 100;
    // [Gate 5 Addendum] Steady-state playback coalesce: suppress state-equivalent flushes
    // during active playback. Reset to '' on intent change or idle state.
    private _lastFlushHash: string = '';
    // Tracks playback state for the critical-transition bypass — derived from StateStore.on('change') in constructor.
    private _isPlaying: boolean = false;

    constructor(
        private readonly _stateStore: StateStore,
        private readonly _dashboardRelay: DashboardRelay,
        private readonly _logger: (msg: string) => void
    ) {
        // Subscribe to StateStore changes reactively.
        // Also sync _isPlaying so the critical-transition bypass (IDLE→PLAYING / PLAYING→STOPPED)
        // fires an immediate flush instead of a debounced one. Previously, setPlayingState() was
        // called manually from speechProvider, but Phase 1.2 removed those call sites without
        // rewiring this tracker — leaving the critical bypass permanently dead.
        this._stateStore.on('change', (state) => {
            this._isPlaying = state.isPlaying;
            this.requestSync();
        });
    }

    /**
     * Update the active session ID for parity.
     */
    public setSessionId(sessionId: string) {
        this._stateStore.setSessionId(sessionId);
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
     */
    public requestSync(immediate: boolean = false) {

        // [Gate 1] Do not flush until the DashboardRelay has a live view attached.
        // All pre-attach syncs are silently buffered in _needsSync.
        if (!this._isRelayAttached) {
            this._needsSync = true;
            return;
        }

        // [v2.4.6] Critical Lifecycle Bypass: If this is a transition to PLAYING or STOPPED,
        // bypass the debounce to ensure instant UI feedback.
        const state = this._stateStore.state;
        const isCriticalTransition = !this._isPlaying && state.isPlaying; // IDLE -> PLAYING
        const isCriticalStop = this._isPlaying && !state.isPlaying; // PLAYING -> STOPPED

        if (immediate || isCriticalTransition || isCriticalStop) {
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
     * @deprecated [Phase 1.2 Reactive Refactor] No longer called externally.
     * _isPlaying is now derived reactively from StateStore.on('change') in the constructor.
     * Retained as a safety valve for potential external consumers.
     */
    public setPlayingState(isPlaying: boolean): void {
        this._isPlaying = isPlaying;
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

        // [Gate 5 v2] Suppress state-equivalent flushes using a comprehensive hash.
        // Applied in ALL states (idle + playing) to prevent load-time UI flicker.
        // During document loading, the extension emits 4-6 rapid StateStore changes
        // (title, chapters, hash, hydration) — previously these all fired because hash
        // suppression was only active during playback. Now the hash de-duplicates in all
        // states. Since the hash includes `isPlaying`, genuine PLAY/STOP transitions always
        // produce a new hash and are guaranteed to fire.
        const hash = this._calculateStateHash();
        if (hash === this._lastFlushHash) {
            return; // Absorbed — state is equivalent, no change to broadcast
        }
        this._lastFlushHash = hash;

        this._needsSync = false;
        this._dashboardRelay.sync();
    }

    private _calculateStateHash(): string {
        const s = this._stateStore.state;
        // Specifically aggregate fields that impact the primary UI and synthesis lifecycle.
        // [FIX] focusedFileName + focusedVersionSalt were absent — tab switches produced identical
        // hashes and were silently absorbed, preventing the Focused File area from updating.
        return [
            s.activeFileName,
            s.activeContentHash,
            s.currentChapterIndex,
            s.currentSentenceIndex,
            s.isPlaying,
            s.isPaused,
            s.playbackStalled,
            s.isHydrated,
            s.playbackAuthorized,
            s.playbackIntentId,
            s.activeMode,
            s.selectedVoice,
            s.versionSalt,
            s.focusedFileName,
            s.focusedVersionSalt
        ].join('|');
    }

    public dispose() {
        this._disposables.forEach(d => d.dispose());
        if (this._syncTimer) {
            clearTimeout(this._syncTimer);
        }
    }
}
