import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';
import { SessionIndexManager } from '@core/SessionIndexManager';

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
    private readonly _myWorkspacePath: string;

    constructor(
        private _antigravityRoot: string,
        private _currentSessionId: string,
        private _stateStore: StateStore,
        private _docController: DocumentLoadController,
        private _logger: (msg: string) => void,
        private _indexManager?: SessionIndexManager
    ) {
        // [WORKSPACE CLAIM GATE] Use VS Code's own enforcement: each window MUST have a
        // unique workspace folder (VS Code physically prevents same-dir in two windows).
        // This path is the per-instance, per-window, self-enforcing discriminator.
        this._myWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

        const globalPattern = new vscode.RelativePattern(vscode.Uri.file(this._antigravityRoot), `**/*.md`);
        this._watcher = vscode.workspace.createFileSystemWatcher(globalPattern, false, true, true);

        this._disposables.push(this._watcher.onDidCreate(async uri => {
            await this._handleInboundSnippet(uri);
        }));

        // [ROBUST_WATCHER] Supplement with fs.watch for paths outside the VS Code workspace
        this._setupExternalWatcher();

        // Claim the initial session at startup so we own it before any snippet arrives
        this._writeWorkspaceClaim(this._currentSessionId);

        this._logger(`[MCP_WATCHER] Listening for ALL sessions in ${this._antigravityRoot} | workspace=${this._myWorkspacePath.split(/[/\\]/).pop() ?? 'unknown'}`);
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
        // Claim new session immediately so we own it before any snippet arrives
        this._writeWorkspaceClaim(sessionId);
        this._logger(`[MCP_WATCHER] Pivoted to session ${sessionId} in ${root}`);

        if (rootChanged) {
            this._setupExternalWatcher();
        }
    }

    /**
     * Write a .workspace_claim file into the session directory.
     * This atomically asserts that this VS Code window owns the session.
     */
    private _writeWorkspaceClaim(sessionId: string): void {
        if (!this._myWorkspacePath) { return; } // no workspace open — skip
        const sessionDir = path.join(this._antigravityRoot, sessionId);
        const claimFile = path.join(sessionDir, '.workspace_claim');
        try {
            if (!fs.existsSync(sessionDir)) { fs.mkdirSync(sessionDir, { recursive: true }); }
            // [NON-DESTRUCTIVE] Respect an existing foreign claim — never overwrite another window's ownership.
            // Prevents a later-starting sibling IDE from stomping the first window's claim at construction time.
            if (fs.existsSync(claimFile)) {
                const existing = fs.readFileSync(claimFile, 'utf8').trim();
                if (existing && existing !== this._myWorkspacePath) {
                    this._logger(`[MCP_WATCHER] Session ${sessionId} already claimed by another workspace — backing off.`);
                    return;
                }
            }
            fs.writeFileSync(claimFile, this._myWorkspacePath);
            this._logger(`[MCP_WATCHER] Claimed session ${sessionId} for workspace: ${this._myWorkspacePath.split(/[/\\]/).pop()}`);
        } catch (e) {
            this._logger(`[MCP_WATCHER_ERR] Failed to write claim for ${sessionId}: ${e}`);
        }
    }

    /**
     * Check if this window owns the session via .workspace_claim.
     * 
     * @param sessionId    The session to check ownership of.
     * @param allowClaim   If true (default for our own session), an unclaimed session will be
     *                     claimed by this window (first-window-wins). If false (foreign session),
     *                     an unclaimed session is REJECTED — we never steal a foreign session.
     *
     * Fail-open on read errors (don't block audio on transient FS issues).
     */
    private _isSessionOwnedByMe(sessionId: string, allowClaim = true): boolean {
        if (!this._myWorkspacePath) { return true; } // no workspace context — pass through
        const claimFile = path.join(this._antigravityRoot, sessionId, '.workspace_claim');
        if (!fs.existsSync(claimFile)) {
            if (!allowClaim) {
                // Foreign session with no claim — do NOT touch it. Let its real owner claim it.
                return false;
            }
            // Our session, unclaimed — first-window-wins: write our claim and process.
            this._writeWorkspaceClaim(sessionId);
            return true;
        }
        try {
            const owner = fs.readFileSync(claimFile, 'utf8').trim();
            return owner === this._myWorkspacePath;
        } catch {
            return true; // Fail open — don't block audio on transient FS errors
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

        // [WORKSPACE CLAIM GATE] Format-agnostic ownership check.
        // Reads .workspace_claim from the session folder. If it matches this window's
        // workspace path, process the snippet. If not, reject (sibling IDE's session).
        // First-window-wins: unclaimed sessions are claimed and processed.
        // [XOR GATE] Only allow auto-claim if this is our own current session.
        // Foreign sessions with no claim must NOT be claimed by a sibling window — reject silently.
        const isOurSession = detectedSessionId === this._currentSessionId;
        if (!this._isSessionOwnedByMe(detectedSessionId, isOurSession)) {
            this._logger(`[MCP_TRACE] REJECTED: session ${detectedSessionId} is foreign — no claim, not our session.`);
            return;
        }

        // Pivot internal pointer if the agent moved to a new session
        if (detectedSessionId !== this._currentSessionId) {
            this._logger(`[MCP_TRACE] PIVOT: workspace owns session, switching to ${detectedSessionId}.`);
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

            // [T-035] Update aggregate index — O(1) history reads on next sidebar open
            this._indexManager?.upsertSession(
                detectedSessionId,
                undefined, // resolved lazily from extension_state.json on first encounter
                {
                    name: metadata.fileName,
                    timestamp: Date.now(),
                    fsPath: cleanPath,
                    uri: vscode.Uri.file(cleanPath).toString()
                }
            );

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
                try { d?.dispose(); } catch (e) { }
            });
        }
        this._onSessionPivotListeners = [];
        this._onSnippetLoadedListeners = [];
    }
}
