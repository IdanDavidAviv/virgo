import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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
    private _externalWatcher?: fs.FSWatcher;
    private _onSessionPivotListeners: SessionPivotCallback[] = [];
    private _onSnippetLoadedListeners: SnippetLoadedCallback[] = [];
    private _disposables: vscode.Disposable[] = [];
    private _recentlyProcessed = new Map<string, number>(); // [DE-DUPLICATION_PROTOCOL] Prevent multiple events for same path
    private readonly COOLDOWN_MS = 500;

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

        // [ROBUST_WATCHER] Supplement with fs.watch for paths outside the VS Code workspace
        this._setupExternalWatcher();

        this._logger(`[MCP_WATCHER] Listening for ALL sessions in ${this._antigravityRoot}`);
    }

    private _setupExternalWatcher() {
        if (this._externalWatcher) {
            this._externalWatcher.close();
        }

        try {
            if (fs.existsSync(this._antigravityRoot)) {
                this._externalWatcher = fs.watch(this._antigravityRoot, { recursive: true }, async (eventType, filename) => {
                    if (filename && filename.endsWith('.md')) {
                        // [WINDOWS_LONG_PATH] On Windows, filename can be absolute or relative and may include long path prefix
                        const fullPath = path.isAbsolute(filename) ? filename : path.join(this._antigravityRoot, filename);
                        
                        // Small delay to ensure the file is fully written/unlocked on Windows
                        setTimeout(async () => {
                            if (fs.existsSync(fullPath)) {
                                await this._handleInboundSnippet(vscode.Uri.file(fullPath));
                            }
                        }, 100);
                    }
                });
                this._logger(`[MCP_WATCHER] External fs.watch active on ${this._antigravityRoot}`);
            }
        } catch (err) {
            this._logger(`[MCP_WATCHER_ERROR] Failed to start external watcher: ${err}`);
        }
    }

    /**
     * Pivot the watcher to a new session context.
     */
    public pivot(root: string, sessionId: string) {
        const rootChanged = this._antigravityRoot !== root;
        this._antigravityRoot = root;
        this._currentSessionId = sessionId;
        this._logger(`[MCP_WATCHER] Pivoted to session ${sessionId} in ${root}`);
        
        if (rootChanged) {
            this._setupExternalWatcher();
        }
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
        // [WINDOWS_LONG_PATH_SANITY] Normalize paths to handle long path prefixes (\\?\)
        const normalize = (p: string) => p.replace(/^\\\\\?\\\//, '').replace(/^\\\\\?\\/, '').replace(/\//g, path.sep);
        const cleanRoot = normalize(this._antigravityRoot);
        const cleanPath = normalize(uri.fsPath);
        
        // [MCP_TRACE] Trace incoming file event before processing
        this._logger(`[MCP_TRACE] Incoming snippet event: ${cleanPath}`);

        // [DE-DUPLICATION_PROTOCOL] Skip if processed very recently
        const now = Date.now();
        const lastProcessed = this._recentlyProcessed.get(cleanPath);
        if (lastProcessed && (now - lastProcessed < this.COOLDOWN_MS)) {
            this._logger(`[MCP_TRACE] SKIPPING: Redundant event for ${path.basename(cleanPath)} (Cooldown active)`);
            return;
        }
        this._recentlyProcessed.set(cleanPath, now);

        const relativePath = path.relative(cleanRoot, cleanPath);
        const pathParts = relativePath.split(path.sep).filter(p => !!p);
        
        // [MCP_TRACE] Relative path resolution
        this._logger(`[MCP_TRACE] Resolved relative path: ${relativePath} (Parts: ${pathParts.length})`);

        // Ensure we actually have a file in a subfolder (session/snippet.md)
        if (pathParts.length < 2) {
            this._logger(`[MCP_TRACE] SKIPPING: Path too shallow or outside session context.`);
            return;
        }

        const detectedSessionId = pathParts[0];

        // 1. Dynamic Session Pivot: Ensure context is aligned
        if (detectedSessionId !== this._currentSessionId) {
            this._logger(`[MCP_TRACE] SNEAKY_PIVOT: Detected activity in sibling session ${detectedSessionId}`);
            // [T-023] Update currentSessionId BEFORE firing listeners.
            // Prevents race: pivot listeners trigger async state resets that would
            // interfere with the loadSnippet call below if session state was still stale.
            this._currentSessionId = detectedSessionId;
            this._onSessionPivotListeners.forEach(cb => cb(detectedSessionId));
        }

        // 2. Load the snippet into the controller
        this._logger(`[MCP_TRACE] Loading snippet: ${path.basename(cleanPath)}`);
        const success = await this._docController.loadSnippet(cleanPath);
        if (success) {
            const metadata = this._docController.metadata;
            
            // 3. Update StateStore to point to this snippet
            this._logger(`[MCP_TRACE] Updating state_store with snippet metadata.`);
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
            this._logger(`[MCP_TRACE] Load Complete: ${metadata.fileName}`);
        } else {
            this._logger(`[MCP_TRACE] LOAD_FAILED: Snippet controller rejected ${path.basename(cleanPath)}`);
        }
    }

    public dispose() {
        this._watcher.dispose();
        if (this._externalWatcher) {
            this._externalWatcher.close();
        }
        if (this._disposables) {
            this._disposables.forEach(d => {
                try { d?.dispose(); } catch (e) {}
            });
        }
        this._onSessionPivotListeners = [];
        this._onSnippetLoadedListeners = [];
    }
}
