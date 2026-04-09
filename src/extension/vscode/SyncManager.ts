import * as vscode from 'vscode';
import { StateStore } from '@core/stateStore';
import { DashboardRelay } from './dashboardRelay';

export class SyncManager implements vscode.Disposable {
    private _disposables: vscode.Disposable[] = [];
    private _syncTimer?: NodeJS.Timeout;
    private _needsSync: boolean = false;
    private _view?: vscode.WebviewView;
    private _activeSessionId: string = 'SESSION-ID-MISSING';
    private _pendingSnippetHistory: any | null = null;
    private static readonly SYNC_THROTTLE_MS = 150;

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
     */
    public setView(view: vscode.WebviewView | undefined) {
        this._view = view;

        if (view?.visible && this._needsSync) {
            this._logger('[SYNC] Flushing background updates on reveal');
            this.requestSync(true); // Immediate flush
        }
    }


    /**
     * Request a UI synchronization.
     * @param immediate If true, bypasses the throttle timer.
     * @param snippetHistory Optional history to include in the packet.
     */
    public requestSync(immediate: boolean = false, snippetHistory?: any) {
        // Buffer history if provided
        if (snippetHistory) {
            this._pendingSnippetHistory = snippetHistory;
        }

        if (!this._view?.visible) {
            this._logger(`[SYNC] 👻 View Hidden (visible: ${this._view?.visible ?? 'false'}) - SYNCING ANYWAY (Simulation)`);
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
        }, SyncManager.SYNC_THROTTLE_MS);
    }

    private _flush() {
        if (this._syncTimer) {
            clearTimeout(this._syncTimer);
            this._syncTimer = undefined;
        }

        const historyToSync = this._pendingSnippetHistory;
        this._pendingSnippetHistory = null;

        this._needsSync = false;
        
        // [DIAGNOSTIC] Final sanity check for visibility - BYPASSED
        this._dashboardRelay.sync(historyToSync, this._activeSessionId);
    }

    public dispose() {
        this._disposables.forEach(d => d.dispose());
        if (this._syncTimer) {
            clearTimeout(this._syncTimer);
        }
    }
}
