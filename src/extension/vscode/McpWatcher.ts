import * as vscode from 'vscode';
import * as path from 'path';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';

export type SessionPivotCallback = (sessionId: string) => void;
export type SnippetLoadedCallback = () => void;

/**
 * McpWatcher
 * 
 * High-integrity service for monitoring the Antigravity root for new snippets.
 * Decouples the "Vocal Sync" detection logic from the main SpeechProvider.
 */
export class McpWatcher implements vscode.Disposable {
    private _watcher: vscode.FileSystemWatcher;
    private _onSessionPivotListeners: SessionPivotCallback[] = [];
    private _onSnippetLoadedListeners: SnippetLoadedCallback[] = [];
    private _disposables: vscode.Disposable[] = [];

    constructor(
        private _antigravityRoot: string,
        private _currentSessionId: string,
        private _stateStore: StateStore,
        private _docController: DocumentLoadController,
        private _logger: (msg: string) => void
    ) {
        const globalPattern = new vscode.RelativePattern(this._antigravityRoot, `**/*.md`);
        this._watcher = vscode.workspace.createFileSystemWatcher(globalPattern, false, true, true);
        
        this._disposables.push(this._watcher.onDidCreate(async uri => {
            await this._handleInboundSnippet(uri);
        }));

        this._logger(`[MCP_WATCHER] Listening for ALL sessions in ${this._antigravityRoot}`);
    }

    /**
     * Pivot the watcher to a new session context.
     */
    public pivot(root: string, sessionId: string) {
        this._antigravityRoot = root;
        this._currentSessionId = sessionId;
        this._logger(`[MCP_WATCHER] Pivoted to session ${sessionId} in ${root}`);
    }


    /**
     * Subscribe to session pivot events
     */
    public onSessionPivot(callback: SessionPivotCallback) {
        this._onSessionPivotListeners.push(callback);
    }

    /**
     * Subscribe to snippet loaded events
     */
    public onSnippetLoaded(callback: SnippetLoadedCallback) {
        this._onSnippetLoadedListeners.push(callback);
    }

    private async _handleInboundSnippet(uri: vscode.Uri) {
        this._logger(`[MCP_WATCHER] INCOMING_SNIPPET detected: ${path.basename(uri.fsPath)}`);

        // 1. Dynamic Session Pivot: Ensure context is aligned
        const relativePath = path.relative(this._antigravityRoot, uri.fsPath);
        const pathParts = relativePath.split(path.sep);
        const detectedSessionId = pathParts.length > 0 ? pathParts[0] : this._currentSessionId;

        if (detectedSessionId !== this._currentSessionId) {
            this._logger(`[MCP_WATCHER] SESSION_DRIFT detected. Pivoting to ${detectedSessionId}`);
            this._onSessionPivotListeners.forEach(cb => cb(detectedSessionId));
        }

        // 2. Load the snippet into the controller
        const success = await this._docController.loadSnippet(uri.fsPath);
        if (success) {
            const metadata = this._docController.metadata;
            
            // 3. Update StateStore to point to this snippet
            this._stateStore.setActiveDocument(
                metadata.uri,
                metadata.fileName,
                metadata.relativeDir,
                metadata.versionSalt,
                metadata.contentHash,
                null // No saved progress for tool-injected snippets
            );

            // 4. Update mode and notify listeners
            this._stateStore.setActiveMode('SNIPPET');
            this._onSnippetLoadedListeners.forEach(cb => cb());
        }
    }

    public dispose() {
        this._watcher.dispose();
        this._disposables.forEach(d => d.dispose());
        this._onSessionPivotListeners = [];
        this._onSnippetLoadedListeners = [];
    }
}
