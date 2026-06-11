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
    private _customWatchers: Map<string, vscode.FileSystemWatcher> = new Map();
    private _customExternalWatchers: Map<string, fs.FSWatcher> = new Map();
    private _customDisposables: Map<string, vscode.Disposable[]> = new Map();
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
        private _indexManager?: SessionIndexManager,
        private _isDev = false
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

        // Initialize custom watchers
        this._initCustomWatchers();

        // Listen to configuration changes
        this._disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('virgo.snippet.scanFolders')) {
                this._logger(`[MCP_WATCHER] Configuration 'virgo.snippet.scanFolders' changed. Re-initializing custom watchers.`);
                this._initCustomWatchers();
            }
        }));

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
            // Recreate primary VS Code FileSystemWatcher for the new root
            this._watcher.dispose();
            const globalPattern = new vscode.RelativePattern(vscode.Uri.file(this._antigravityRoot), `**/*.md`);
            this._watcher = vscode.workspace.createFileSystemWatcher(globalPattern, false, true, true);
            this._disposables.push(this._watcher.onDidCreate(async uri => {
                await this._handleInboundSnippet(uri);
            }));
            
            this._setupExternalWatcher();
        }
    }

    private _initCustomWatchers() {
        // Dispose existing custom watchers
        for (const [folderPath, watcher] of this._customWatchers) {
            watcher.dispose();
        }
        this._customWatchers.clear();

        for (const [folderPath, extWatcher] of this._customExternalWatchers) {
            extWatcher.close();
        }
        this._customExternalWatchers.clear();

        for (const [folderPath, disposables] of this._customDisposables) {
            disposables.forEach(d => {
                try { d.dispose(); } catch (e) {}
            });
        }
        this._customDisposables.clear();

        // Load configured scan folders
        const configFolders = vscode.workspace.getConfiguration('virgo').get<Array<{ path: string, active?: boolean }>>('snippet.scanFolders') || [];
        
        for (const entry of configFolders) {
            if (!entry.path || entry.active === false) {
                continue;
            }

            const targetFolder = entry.path;
            try {
                if (!fs.existsSync(targetFolder)) {
                    this._logger(`[MCP_WATCHER] Custom watch folder does not exist: ${targetFolder}`);
                    continue;
                }

                // VS Code FileSystemWatcher
                const pattern = new vscode.RelativePattern(vscode.Uri.file(targetFolder), `**/*.md`);
                const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, true, true);
                const disposables: vscode.Disposable[] = [];
                disposables.push(watcher.onDidCreate(async uri => {
                    await this._handleInboundSnippet(uri);
                }));

                this._customWatchers.set(targetFolder, watcher);
                this._customDisposables.set(targetFolder, disposables);

                // External Watcher (fs.watch)
                const extWatcher = fs.watch(targetFolder, { recursive: true }, async (eventType, filename) => {
                    if (filename && filename.endsWith('.md')) {
                        const fullPath = path.isAbsolute(filename) ? filename : path.join(targetFolder, filename);
                        setTimeout(async () => {
                            if (fs.existsSync(fullPath)) {
                                await this._handleInboundSnippet(vscode.Uri.file(fullPath));
                            }
                        }, 100);
                    }
                });
                this._customExternalWatchers.set(targetFolder, extWatcher);

                this._logger(`[MCP_WATCHER] Initialized custom watcher for: ${targetFolder}`);
                
                // Write workspace claim for current session in this custom folder as well
                this._writeWorkspaceClaimForRoot(targetFolder, this._currentSessionId);
            } catch (err) {
                this._logger(`[MCP_WATCHER_ERROR] Failed to set up custom watcher for ${targetFolder}: ${err}`);
            }
        }
    }

    private _resolveRootFolder(cleanPath: string): string {
        const normalize = (p: string) => p.replace(/^\\\\\?\\\//, '').replace(/^\\\\\?\\/, '').replace(/\//g, path.sep);
        const cleanRoot = normalize(this._antigravityRoot);
        if (cleanPath.startsWith(cleanRoot)) {
            return this._antigravityRoot;
        }

        const configFolders = vscode.workspace.getConfiguration('virgo').get<Array<{ path: string, active?: boolean }>>('snippet.scanFolders') || [];
        for (const entry of configFolders) {
            if (entry.path && entry.active !== false) {
                const cleanCustom = normalize(entry.path);
                if (cleanPath.startsWith(cleanCustom)) {
                    return entry.path;
                }
            }
        }

        return this._antigravityRoot; // Fallback
    }

    /**
     * Write a .workspace_claim file into the session directory.
     * This atomically asserts that this VS Code window owns the session.
     */
    private _writeWorkspaceClaim(sessionId: string): void {
        this._writeWorkspaceClaimForRoot(this._antigravityRoot, sessionId);
        
        // Also claim in active custom folders!
        const configFolders = vscode.workspace.getConfiguration('virgo').get<Array<{ path: string, active?: boolean }>>('snippet.scanFolders') || [];
        for (const entry of configFolders) {
            if (entry.path && entry.active !== false) {
                this._writeWorkspaceClaimForRoot(entry.path, sessionId);
            }
        }
    }

    private _writeWorkspaceClaimForRoot(rootPath: string, sessionId: string): void {
        if (!this._myWorkspacePath) { return; } // no workspace open — skip
        const sessionDir = path.join(rootPath, sessionId);
        const claimFile = path.join(sessionDir, '.workspace_claim');
        try {
            if (!fs.existsSync(sessionDir)) { fs.mkdirSync(sessionDir, { recursive: true }); }
            
            // Read loom.json to see if we are the true owner according to agent state
            const brainDir = path.join(this._antigravityRoot, '..', '..', 'brain');
            const loomPath = path.join(brainDir, sessionId, 'loom.json');
            let isTrueOwner = false;
            if (fs.existsSync(loomPath)) {
                try {
                    const loom = JSON.parse(fs.readFileSync(loomPath, 'utf8'));
                    if (loom.workspacePath) {
                        const normLoom = loom.workspacePath.replace(/\\/g, '/').toLowerCase().trim();
                        const normMine = this._myWorkspacePath.replace(/\\/g, '/').toLowerCase().trim();
                        if (normLoom === normMine) {
                            isTrueOwner = true;
                        }
                    }
                } catch (e) {
                    this._logger(`[MCP_WATCHER] Error parsing loom.json: ${e}`);
                }
            }

            // [NON-DESTRUCTIVE] Respect an existing foreign claim — unless we are the true owner or we are in Dev Mode
            if (fs.existsSync(claimFile) && !isTrueOwner && !this._isDev) {
                const existingContent = fs.readFileSync(claimFile, 'utf8').trim();
                const parts = existingContent.split('|');
                const existing = parts[0];
                const existingPid = parts[1] ? parseInt(parts[1], 10) : null;
                
                let isAlive = true;
                if (existingPid) {
                    try {
                        process.kill(existingPid, 0);
                    } catch (err: any) {
                        if (err.code === 'ESRCH') {
                            isAlive = false;
                        }
                    }
                }

                if (existing && existing !== this._myWorkspacePath && isAlive) {
                    this._logger(`[MCP_WATCHER] Session ${sessionId} already claimed in root ${rootPath} by another active workspace ${existing} (PID: ${existingPid}) — backing off.`);
                    return;
                }
            }
            const claimData = `${this._myWorkspacePath}|${process.pid}${this._isDev ? '|dev' : ''}`;
            fs.writeFileSync(claimFile, claimData);
            this._logger(`[MCP_WATCHER] Claimed session ${sessionId} in root ${rootPath} for workspace: ${this._myWorkspacePath.split(/[/\\]/).pop()} (PID: ${process.pid})`);
        } catch (e) {
            this._logger(`[MCP_WATCHER_ERR] Failed to write claim for ${sessionId} in root ${rootPath}: ${e}`);
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
    private _isSessionOwnedByMe(sessionId: string, allowClaim = true, matchedRoot?: string): boolean {
        // [TESTING_BYPASS] In development host / integration test environment, bypass ownership check
        if (this._isDev) {
            return true;
        }
        if (!this._myWorkspacePath) { return true; } // no workspace context — pass through
        
        // Read loom.json to see if we are the true owner according to agent state
        const brainDir = path.join(this._antigravityRoot, '..', '..', 'brain');
        const loomPath = path.join(brainDir, sessionId, 'loom.json');
        let isTrueOwner = false;
        if (fs.existsSync(loomPath)) {
            try {
                const loom = JSON.parse(fs.readFileSync(loomPath, 'utf8'));
                if (loom.workspacePath) {
                    const normLoom = loom.workspacePath.replace(/\\/g, '/').toLowerCase().trim();
                    const normMine = this._myWorkspacePath.replace(/\\/g, '/').toLowerCase().trim();
                    if (normLoom === normMine) {
                        isTrueOwner = true;
                    }
                }
            } catch (e) {}
        }

        const targetRoot = matchedRoot || this._antigravityRoot;
        const claimFile = path.join(targetRoot, sessionId, '.workspace_claim');
        if (!fs.existsSync(claimFile)) {
            if (!allowClaim) {
                // Foreign session with no claim — do NOT touch it. Let its real owner claim it.
                return false;
            }
            // Our session, unclaimed — first-window-wins: write our claim and process.
            this._writeWorkspaceClaimForRoot(targetRoot, sessionId);
            return true;
        }
        try {
            const existingContent = fs.readFileSync(claimFile, 'utf8').trim();
            const parts = existingContent.split('|');
            const owner = parts[0];
            const ownerPid = parts[1] ? parseInt(parts[1], 10) : null;
            const isDevClaim = parts[2] === 'dev';

            if (owner === this._myWorkspacePath) {
                return true;
            }

            let isAlive = true;
            if (ownerPid) {
                try {
                    process.kill(ownerPid, 0);
                } catch (err: any) {
                    if (err.code === 'ESRCH') {
                        isAlive = false;
                    }
                }
            }

            // [DEV_INTERCEPTION] Yield session ownership to active Dev Host if we are a production instance
            if (isDevClaim && isAlive && !this._isDev) {
                this._logger(`[MCP_WATCHER] Yielding session ${sessionId} to active Dev Host (PID: ${ownerPid}).`);
                return false;
            }

            if (!isAlive) {
                this._logger(`[MCP_WATCHER] Overriding stale claim for session ${sessionId} (owner PID ${ownerPid} is dead).`);
                this._writeWorkspaceClaimForRoot(targetRoot, sessionId);
                return true;
            }

            if (isTrueOwner) {
                this._logger(`[MCP_WATCHER] Overriding active foreign claim for session ${sessionId} because we are the true owner in loom.json.`);
                this._writeWorkspaceClaimForRoot(targetRoot, sessionId);
                return true;
            }

            return false;
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
        const cleanPath = normalize(uri.fsPath);

        const matchedRoot = this._resolveRootFolder(cleanPath);
        const cleanRoot = normalize(matchedRoot);

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
        if (!this._isSessionOwnedByMe(detectedSessionId, isOurSession, matchedRoot)) {
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

        // Dispose custom watchers
        for (const [folderPath, watcher] of this._customWatchers) {
            watcher.dispose();
        }
        this._customWatchers.clear();

        for (const [folderPath, extWatcher] of this._customExternalWatchers) {
            extWatcher.close();
        }
        this._customExternalWatchers.clear();

        for (const [folderPath, disposables] of this._customDisposables) {
            disposables.forEach(d => {
                try { d.dispose(); } catch (e) {}
            });
        }
        this._customDisposables.clear();

        if (this._disposables) {
            this._disposables.forEach(d => {
                try { d?.dispose(); } catch (e) { }
            });
        }
        this._onSessionPivotListeners = [];
        this._onSnippetLoadedListeners = [];
    }
}
