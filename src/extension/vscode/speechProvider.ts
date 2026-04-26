import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { Chapter } from '@core/documentParser';
import { DocumentLoadController } from '@core/documentLoadController';
import { StateStore } from '@core/stateStore';
import { PlaybackEngine, PlaybackOptions } from '@core/playbackEngine';
import { SequenceManager } from '@core/sequenceManager';
import { AudioBridge } from '@core/audioBridge';
import { DashboardRelay } from './dashboardRelay';
import { OutgoingAction, IncomingCommand, SnippetHistory } from '@common/types';
import { McpWatcher } from '@vscode/McpWatcher';
import { VoiceManager } from '@vscode/VoiceManager';
import { SettingsManager } from '@vscode/SettingsManager';
import { SyncManager } from '@vscode/SyncManager';
import { PersistenceManager } from './PersistenceManager';
import { SessionIndexManager } from '@core/SessionIndexManager';
import { McpConfigurator } from '../mcp/mcpConfigurator';


export class SpeechProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _extensionPath: string;

    private _docController: DocumentLoadController;
    private _sequenceManager: SequenceManager;
    private _stateStore: StateStore;
    private _audioBridge: AudioBridge;
    private _dashboardRelay: DashboardRelay;
    private _mcpWatcher: McpWatcher;
    private _indexManager!: SessionIndexManager;


    // Selection state (passive) - Moved to StateStore

    private _playbackEngine: PlaybackEngine;
    private _needsSync: boolean = false; 
    private _needsHistorySync: boolean = false; 
    private _voiceManager!: VoiceManager;
    private _settingsManager!: SettingsManager;
    private _syncManager!: SyncManager;
    private _persistenceManager: PersistenceManager;
    private _debounceSaveTimers: Map<string, NodeJS.Timeout> = new Map();

    private _lastHandshakeTime?: number;
    private _debounceTimers: Map<string, NodeJS.Timeout> = new Map();

    // [T-034] Focused-file disk-change watcher
    private _focusedFileWatcher?: vscode.Disposable;
    private _lastFocusedSalt?: string;
    private _isLoadingDocument = false;
    // [DPG] Dual-Precondition Gate flags
    private _webviewIsReady = false;
    private _initialLoadExecuted = false;


    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _logger: (msg: string) => void,
        private readonly _statusBarItem: vscode.StatusBarItem,
        private _readAloudRoot: string,
        private _sessionId: string,
        public onVisibilityChanged?: () => void
    ) {
        this._extensionUri = _context.extensionUri;
        this._extensionPath = _context.extensionPath;
        this._docController = new DocumentLoadController(this._logger);
        this._sequenceManager = new SequenceManager();
        this._stateStore = new StateStore(this._logger);
        this._playbackEngine = new PlaybackEngine(this._stateStore, _logger, () => this._broadcastCacheStats());
        this._audioBridge = new AudioBridge(this._stateStore, this._docController, this._playbackEngine, this._sequenceManager, this._logger);
        this._persistenceManager = new PersistenceManager(this._context, this._stateStore, this._logger);


        // [PHASE 1 REFACTOR] Modularized MCP Watcher
        // [T-035] SessionIndexManager must be created before McpWatcher (injected as dep)
        this._indexManager = new SessionIndexManager(this._readAloudRoot, this._logger);

        this._mcpWatcher = new McpWatcher(
            this._readAloudRoot,
            this._sessionId,
            this._stateStore,
            this._docController,
            this._logger,
            this._indexManager
        );
        this._mcpWatcher.onSessionPivot(id => this.pivotSession(id));
        this._mcpWatcher.onSnippetLoaded(async () => {
            this.stop();
            // [MCP-TRUST] MCP is a trusted actor. Authorize BEFORE requestSync() so the
            // UI_SYNC packet carries playbackAuthorized:true. The webview's PlaybackController
            // handles this at the SOVEREIGNTY BRIDGE (line ~841): it sets _userHasInteracted=true
            // and primes the AudioContext — lifting both gates without any user click.
            // Without this, requestSync() fires with playbackAuthorized:false, and synthesis
            // arriving later hits a closed gate even when autoPlayOnInjection is true.
            this._dashboardRelay.authorizePlayback();
            this._syncManager.requestSync(true);
            if (this._stateStore.state.autoPlayOnInjection) {
                this._logger('[EXTENSION] Playback started via autoPlayOnInjection signal');
                // [T-023] continue() is correct: it calls authorizePlayback() (cold-boot gate)
                // and starts from currentSentenceIndex which is reset to 0 by setActiveDocument(null)
                // inside McpWatcher._handleInboundSnippet before this callback fires.
                await this.continue();
            }
        });
        this._context.subscriptions.push(this._mcpWatcher);

        // 2. Initialize Core Services
        this._settingsManager = new SettingsManager(
            this._context,
            this._stateStore,
            msg => this._logger(msg),
            this._readAloudRoot,
            this._sessionId
        );
        this._settingsManager.initialize();

        this._dashboardRelay = new DashboardRelay(this._stateStore, this._docController, this._playbackEngine, this._logger);
        this._voiceManager = new VoiceManager(this._playbackEngine, this._stateStore, this._dashboardRelay, this._logger);
        this._syncManager = new SyncManager(this._stateStore, this._dashboardRelay, this._logger);
        this._syncManager.setSessionId(this._sessionId);

        // Register AudioBridge Events
        this._audioBridge.on('playAudio', payload => this._dashboardRelay.postMessage({ command: IncomingCommand.PLAY_AUDIO, ...payload }));
        this._audioBridge.on('synthesisStarting', payload => this._dashboardRelay.postMessage({ command: IncomingCommand.SYNTHESIS_STARTING, ...payload }));
        this._audioBridge.on('synthesisReady', payload => this._dashboardRelay.postMessage({ command: IncomingCommand.SYNTHESIS_READY, ...payload }));
        this._audioBridge.on('synthesisError', payload => this._dashboardRelay.postMessage({ command: IncomingCommand.SYNTHESIS_ERROR, ...payload }));
        this._audioBridge.on('engineStatus', payload => this._dashboardRelay.postMessage({ command: IncomingCommand.ENGINE_STATUS, ...payload }));
        this._audioBridge.on('dataPush', payload => this._dashboardRelay.postMessage({ command: IncomingCommand.DATA_PUSH, ...payload }));
        this._audioBridge.on('playbackFinished', () => this._syncStatusBars());
        this._audioBridge.on('speakLocal', payload => this._dashboardRelay.postMessage({ command: IncomingCommand.SPEAK_LOCAL, ...payload }));
        this._audioBridge.on('uiSyncRequested', () => this._dashboardRelay.sync());

        // Register PlaybackEngine Events (Neural Optimization & Cache Parity)
        this._playbackEngine.on('clear-cache', () => {
            this._dashboardRelay.postMessage({ command: IncomingCommand.CLEAR_CACHE_WIPE });
        });
        this._playbackEngine.on('cache-stats-update', payload => {
            this._dashboardRelay.postMessage({ command: IncomingCommand.CACHE_STATS_UPDATE, ...payload });
        });

        // Initial setup of document context listeners
        this._setupDocumentListeners();

        // Tier-3: High-Density Log Format (Extension Boot)
        this._logger('[BOOT] extension_activated');
        this._voiceManager.scanAndSync();

        // [Phase 6] Scan MCP configuration status
        const mcpResult = McpConfigurator.checkConfigurationStatus();
        this._stateStore.patchState({ mcpStatus: mcpResult.status, mcpActiveAgents: mcpResult.activeAgents }, true);
        this._logger(`[MCP] Configuration status: ${mcpResult.status} [${mcpResult.activeAgents.join(',')}]`);
        // [LIVENESS] One-shot probe — upgrades badge to green if binary responds
        if (mcpResult.status === 'configured') {
            McpConfigurator.probeLiveness((alive) => {
                if (alive) {
                    this._stateStore.patchState({ mcpStatus: 'alive' });
                    this._logger('[MCP] Liveness probe: VIRGO_MCP_OK → badge green');
                }
            });
        }

        // [Reactive Sync] Handled by SyncManager

        // --- Portless MCP Watcher ---


        // [AUTO_BOOTSTRAP] Ensure session state exists for Vocal Sync
        this._ensureSessionState();

        // [v2.3.1] Persistent Context Restoration
        this._persistenceManager.hydrate();
        this._persistenceManager.watch();

        // If a document was restored from persistence, trigger an initial load
        if (this._stateStore.state.activeDocumentUri) {
            this.loadCurrentDocument(true); // true = useHydratedProgress
        }
    }

    public pivotSession(newSessionId: string) {
        if (this._sessionId === newSessionId) { return; }
        
        this._logger(`[SYNC] PIVOTING: ${this._sessionId} -> ${newSessionId}`);
        this._sessionId = newSessionId;
        this._syncManager.setSessionId(newSessionId);
        
        // 1. Ensure the new session has a extension_state.json and folder
        this._ensureSessionState();
        
        // 2. Stop any current playback
        this.stop();
        
        // 3. Trigger UI refresh (clears old snippet history in UI)
        this.refresh();
        
        // 4. Log high-density sync event
        this._logger(`[SYNC] SESSION_PIVOT_COMPLETE: ${newSessionId}`);
    }

    public updateSessionContext(root: string, sessionId: string) {
        // [MP-001 T-015] root IS sessionsRoot — do NOT re-append 'read_aloud'.
        // Callers now pass the pre-resolved sessions/ root directly.
        this._readAloudRoot = root;
        this._sessionId = sessionId;
        this._settingsManager.pivotSession(root, sessionId);
        this._mcpWatcher?.pivot(root, sessionId);
    }

    private _ensureSessionState() {
        const sessionPath = path.join(this._readAloudRoot, this._sessionId);
        const stateFile = path.join(sessionPath, 'extension_state.json');

        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        if (!fs.existsSync(stateFile)) {
            const initialState = { 
                current_turn_index: 0,
                session_title: "New session - to be named"
            };
            fs.writeFileSync(stateFile, JSON.stringify(initialState, null, 2));
            this._logger(`[BOOTSTRAP] Initialized extension_state.json for session: ${this._sessionId}`);
        }
    }

    private _bridgeAgentState(autoInjectSITREP: boolean) {
        const stateFile = path.join(this._readAloudRoot, this._sessionId, 'extension_state.json');
        if (fs.existsSync(stateFile)) {
            try {
                const content = fs.readFileSync(stateFile, 'utf8');
                const state = JSON.parse(content);
                state.autoInjectSITREP = autoInjectSITREP;
                fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
                this._logger(`[BRIDGE] Synced autoInjectSITREP=${autoInjectSITREP} to ${this._sessionId}`);
            } catch (err) {
                this._logger(`[BRIDGE_ERROR] Failed to patch extension_state.json: ${err}`);
            }
        }
    }



    private _setupDocumentListeners() {
        // Listen for changes to the active document to update version badges
        vscode.workspace.onDidChangeTextDocument(e => {
            const currentUri = this._docController.metadata.uri;
            if (currentUri && e.document.uri.toString() === currentUri.toString()) {
                // For regular files or artifacts, we only want to update the UI if the version/mtime would actually change.
                // We debounce this slightly to avoid flickering while typing.
                this._updateDocumentInfoThrottled(e.document);
            }
        });
    }

    private _updateDocumentInfoTimer?: NodeJS.Timeout;
    private _updateDocumentInfoThrottled(document: vscode.TextDocument) {
        if (this._updateDocumentInfoTimer) { clearTimeout(this._updateDocumentInfoTimer); }
        this._updateDocumentInfoTimer = setTimeout(() => {
            this._docController.updateMetadata(document);
        }, 500);
    }




    /**
     * Updates the passive selection (Focused File) whenever the editor focus changes.
     */
    public setActiveEditor(uri: vscode.Uri | undefined) {
        // [T-034] Tear down previous watcher on every focus change
        this._focusedFileWatcher?.dispose();
        this._focusedFileWatcher = undefined;

        if (!uri) {
            this._stateStore.setFocusedFile(undefined, 'No Selection', '', false);
            return;
        }

        // Permissive Focus: Track any file, even if restricted or unsupported.
        // [HARDEN] Use uri.path fallback if fsPath is empty (common for virtual docs)
        const rawPath = uri.fsPath || uri.path || '';
        const fileName = path.basename(rawPath) || 'Untitled';
        
        const isSupported = this._isFormatSupported(fileName);

        let relativeDir = '';
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (folder && uri.fsPath) {
            const relPath = path.relative(folder.uri.fsPath, path.dirname(uri.fsPath));
            relativeDir = folder.name + (relPath && relPath !== '.' ? ' / ' + relPath.replace(/\\/g, ' / ') : '');
        } else {
            // [HARDEN] Handle virtual paths or external files
            const dirParts = path.dirname(rawPath).split(/[\\\/]/).filter(p => !!p);
            relativeDir = dirParts.slice(-2).join(' / ');
        }

        const versionSalt = isSupported ? this._docController.getFileVersionSalt(uri) : undefined;
        this._lastFocusedSalt = versionSalt;
        this._stateStore.setFocusedFile(uri, fileName, relativeDir, isSupported, versionSalt);
        this._logger(`[DEBUG] setActiveEditor | file: ${fileName} | scheme: ${uri.scheme} | supported: ${isSupported} | salt: ${versionSalt}`);

        // [T-034] Arm disk-change watcher for supported files with a real fsPath
        if (isSupported && uri.fsPath) {
            this._setupFocusedFileWatcher(uri);
        }
    }

    /** [T-034] Creates a FileSystemWatcher scoped to the focused file + its .metadata.json sidecar. */
    private _setupFocusedFileWatcher(uri: vscode.Uri): void {
        const fsPath = uri.fsPath;
        const dir = path.dirname(fsPath);
        const base = path.basename(fsPath);
        const pattern = new vscode.RelativePattern(
            vscode.Uri.file(dir),
            `{${base},${base}.metadata.json}`
        );
        const watcher = vscode.workspace.createFileSystemWatcher(pattern, true, false, true);
        watcher.onDidChange(() => this._onFocusedFileDiskChange(uri));
        this._focusedFileWatcher = watcher;
        this._logger(`[T-034] FileSystemWatcher armed: ${base}`);
    }

    /** [T-034] Fires on external disk write. Re-computes salt; no-ops if unchanged. */
    private _onFocusedFileDiskChange(uri: vscode.Uri): void {
        const newSalt = this._docController.getFileVersionSalt(uri);
        if (newSalt === this._lastFocusedSalt) { return; } // No change — absorb
        this._lastFocusedSalt = newSalt;
        const s = this._stateStore.state;
        this._stateStore.setFocusedFile(
            uri,
            s.focusedFileName || path.basename(uri.fsPath),
            s.focusedRelativeDir || '',
            s.focusedIsSupported ?? true,
            newSalt
        );
        this._logger(`[T-034] Disk change → salt: ${newSalt || '(empty)'}`);
    }

    private _isFormatSupported(fileName: string): boolean {
        return true;
    }


    public dispose() {
        this._voiceManager?.dispose();
        this._settingsManager?.dispose();
        this._syncManager?.dispose();
        this._focusedFileWatcher?.dispose(); // [T-034]
        if (this._updateDocumentInfoTimer) {
            clearTimeout(this._updateDocumentInfoTimer);
        }
    }

    private _getSanitizedPayload(payload: any, depth: number = 0): any {
        if (depth > 3) {
            return '[MAX_DEPTH]';
        }
        if (payload === null || payload === undefined) {
            return payload;
        }

        if (Array.isArray(payload)) {
            if (payload.length > 10) {
                return `[COUNT: ${payload.length} items]`;
            }
            return payload.map(item => this._getSanitizedPayload(item, depth + 1));
        }

        if (typeof payload === 'object') {
            const sanitized: any = {};
            for (const key in payload) {
                const val = payload[key];

                // DATA: Always redact massive binary/base64 strings
                if (key === 'data' && typeof val === 'string' && val.length > 500) {
                    sanitized[key] = `[BIN:${Math.round(val.length / 1024)}KB]`;
                    continue;
                }

                if (key === 'text' && typeof val === 'string' && val.length > 100) {
                    sanitized[key] = val.substring(0, 97) + '...';
                    continue;
                }

                // Internal noise reduction
                if (key === 'availableVoices' || key === 'allChapters') {
                    sanitized[key] = Array.isArray(val) ? `[CNT:${val.length}]` : '[HIDDEN]';
                    continue;
                }

                // URI/PATH: Shorten long paths/UUIDs
                if (typeof val === 'string' && (val.includes('file:///') || val.includes('http') || val.length > 30)) {
                    sanitized[key] = this._docController.compressPath(val);
                } else if (typeof val === 'string' && val.length > 128) {
                    sanitized[key] = val.substring(0, 125) + '...';
                } else {
                    sanitized[key] = this._getSanitizedPayload(val, depth + 1);
                }
            }
            return sanitized;
        }

        return payload;
    }
    private _postToAll(msg: any) {
        this._dashboardRelay.postMessage(msg);
        this._syncStatusBars();
    }

    public isPlaying() { return this._playbackEngine.isPlaying; }
    public isPaused() { return this._playbackEngine.isPaused; }

    private _syncStatusBars() {
        this._statusBarItem.text = "♍︎ Virgo";
        this._statusBarItem.backgroundColor = undefined;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        // [CRASH-FIX] Set webview options FIRST — before any setView() calls.
        // SyncManager.setView() immediately calls requestSync(true) → flush → relay.sync() → postMessage().
        // Calling postMessage() before webview.options.enableScripts=true throws a VS Code internal error
        // ("An error occurred while loading view"), silently killing the entire webview lifecycle.
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'media')]
        };

        this._dashboardRelay.setView(webviewView);
        this._syncManager.setView(webviewView);
        
        // [DELTA SYNC] Initial handshake happens on 'ready' message
        this._logger('--- ACTIVATING MISSION CONTROL (Sidebar) ---');
        this._logger(`[BOOT] resolveWebviewView called | visible=${webviewView.visible}`);

        webviewView.webview.onDidReceiveMessage(async data => {
            if (data.command === 'ready') {
                const now = Date.now();
                if (this._lastHandshakeTime && now - this._lastHandshakeTime < 2000) {
                    this._logger(`[BRIDGE] Storm Guard: Ignoring redundant 'ready' command.`);
                    return;
                }
                this._lastHandshakeTime = now;

                // [TRIPLE-PULSE] New orchestrated startup protocol
                await this._sendInitialState();
                return;
            }
            if (data.command === 'log') {
                // SILENCE: High-frequency proxied logs from webview
                if (data.message.includes('Cache Status Update')) {
                    return;
                }
                this._logger(`[WEBVIEW ${data.type.toUpperCase()}] ${data.message}`);
                return;
            }
            this._handleWebviewMessage(data, 'sidebar');
        });

        webviewView.onDidDispose(() => {
            this._logger('MISSION CONTROL DISPOSED. Purging memory...');
            this._postToAll({ command: 'PURGE_MEMORY' });
            this._dashboardRelay.clearView();
        });


        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                if (this._needsSync || this._needsHistorySync) {
                    this._logger(`[VISIBILITY] Sidebar revealed. Triggering ${this._needsHistorySync ? 'FULL' : 'STATE'} sync...`);
                    this.refreshView();
                    this._needsSync = false;
                    this._needsHistorySync = false;
                }
                if (this.onVisibilityChanged) {
                    this.onVisibilityChanged();
                }
            }
        });

        webviewView.webview.html = this._getLoadingHtml();

        // --- NEW NATIVE MODE ---
        this._view.webview.html = this._getHtmlForWebview(webviewView.webview);
    }

    private _getLoadingHtml(): string {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { 
                        background: transparent; 
                        color: #888; 
                        display: flex; 
                        flex-direction: column;
                        justify-content: center; 
                        align-items: center; 
                        height: 100vh; 
                        font-family: sans-serif; 
                        gap: 16px;
                    }
                    .loader {
                        width: 24px;
                        height: 24px;
                        border: 2px solid #333;
                        border-top: 2px solid #555;
                        border-radius: 50%;
                        animation: spin 1s linear infinite;
                    }
                    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                </style>
            </head>
            <body>
                <div class="loader"></div>
                <div style="font-size: 13px; letter-spacing: 0.5px;">INITIALIZING AUDIO ENGINE...</div>
            </body>
            </html>
        `;
    }

    public refresh(): void {
        if (!this._view || this._stateStore.state.isRefreshing) {
            return;
        }

        try {
            this._stateStore.setRefreshing(true);

            this._logger(`[REFRESH] INJECTING NATIVE WEBVIEW HTML`);
            this._view.webview.html = this._getHtmlForWebview(this._view.webview);
        } catch (e) {
            this._logger(`[REFRESH] ERR: ${e}`);
            setTimeout(() => this.refresh(), 1000);
        } finally {
            this._stateStore.setRefreshing(false);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'app.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'style.css'));

        const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'speechEngine.html');
        let html = fs.readFileSync(htmlPath.fsPath, 'utf8');

        // Inject URIs
        html = html.replace('${inlineStyle}', '') // Remove old injection point
            .replace('${inlineScript}', '') // Remove old injection point
            .replace('</head>', `<link rel="stylesheet" href="${styleUri}">\n</head>`)
            .replace('</body>', `
                        <script src="${scriptUri}"></script>
                    </body>`);

        // Inject Handshake Config (Native Mode)
        const config = {
            native: true,
            extensionVersion: this._context.extension.packageJSON.version,
            debugMode: this._context.extensionMode === vscode.ExtensionMode.Development,
            logLevel: vscode.workspace.getConfiguration('readAloud').get<string>('logging.level', 'Standard') === 'Verbose' ? 2 : 1
        };

        const bootstrap = `
            <script>
                window.__BOOTSTRAP_CONFIG__ = ${JSON.stringify(config)};
                (function() {
                    const vscode = acquireVsCodeApi();
                    window.vscode = vscode;

                    // Diagnostic Redirect (console -> extension logs)
                    const _log = console.log, _warn = console.warn, _error = console.error;
                    function send(type, args) {
                        try {
                            const sanitize = (val) => {
                                if (Array.isArray(val)) return '[ARRAY:' + val.length + ']';
                                if (val && typeof val === 'object') {
                                    const keys = Object.keys(val);
                                    if (keys.length > 5) return '[OBJ:' + keys.length + ']';
                                    if (val.command) return '[CMD:' + val.command + ']';
                                    return JSON.stringify(val);
                                }
                                return String(val);
                            };
                            const msg = args.map(sanitize).join(' | ');
                            vscode.postMessage({ command: 'log', type, message: msg });
                        } catch (e) {
                            vscode.postMessage({ command: 'log', type: 'error', message: '[LOG_ERR] ' + e.message });
                        }
                    }
                    console.log = (...args) => { _log(...args); send('info', args); };
                    console.warn = (...args) => { _warn(...args); send('warn', args); };
                    console.error = (...args) => { _error(...args); send('error', args); };

                    console.log('[BOOT] Native API Handshake OK');
                })();
            </script>
        `;

        html = html.replace('<head>', `<head>\n${bootstrap}`);

        // Replace any remaining ${variable} in HTML
        html = html.replace(/\${extensionVersion}/g, config.extensionVersion);

        return html;
    }

    private _getErrorHtml(message: string): string {
        return `
            <html>
            <body style="background:transparent;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:sans-serif;color:#ff4d4d;margin:0;padding:0;overflow:hidden;">
                <div style="padding:20px 30px;background:rgba(40,0,0,0.8);border-radius:12px;border:1px solid rgba(255,0,0,0.2);text-align:center;backdrop-filter:blur(8px);box-shadow: 0 8px 32px rgba(0,0,0,0.5);">
                    <div style="font-size:10px;letter-spacing:3px;margin-bottom:8px;opacity:0.8;font-weight:bold;color:#ffaaaa;">CRITICAL FAILURE</div>
                    <div style="font-size:14px;font-weight:600;color:#ffffff;">ENGINE FAILED TO START</div>
                    <div style="font-size:10px;opacity:0.6;margin-top:8px;font-family:monospace;max-width:240px;word-break:break-all;">${message}</div>
                    <div style="margin-top:16px;font-size:11px;color:#cccccc;">Try restarting VS Code or checking the extension logs.</div>
                </div>
            </body>
            </html>
        `;
    }

    public async refreshView() {
        this._logger(`[VOICE] Manual UI refresh requested. Forcing full scan...`);
        // [T-047] Force a cold scan and merge into existing index (diff update)
        const history = await this._getSnippetHistory(true);
        this._stateStore.setHistory(history);
        this._voiceManager.broadcastVoices();
    }

    public refreshVoices() {
        this._voiceManager.scanAndSync();
    }

    public refreshMcpStatus() {
        const result = McpConfigurator.checkConfigurationStatus();
        this._stateStore.patchState({ mcpStatus: result.status, mcpActiveAgents: result.activeAgents });
        this._logger(`[MCP] Configuration status refreshed: ${result.status} [${result.activeAgents.join(',')}]`);
        if (result.status === 'configured') {
            McpConfigurator.probeLiveness((alive) => {
                if (alive) {
                    this._stateStore.patchState({ mcpStatus: 'alive' });
                    this._logger('[MCP] Liveness probe: VIRGO_MCP_OK → badge green');
                }
            });
        }
    }

    private async _handleWebviewMessage(data: any, source: string = 'webview') {
        const sanitized = this._validatePayload(data);
        if (!sanitized.command) {
            this._logger(`[DASHBOARD -> EXTENSION] IGNORED_MALFORMED_MESSAGE: ${JSON.stringify(data)}`);
            return;
        }

        const cmd = sanitized.command;
        const payload = sanitized; // For brevity in handlers
        this._logger(`[READALOUD <- ${source.toUpperCase()}] Command: ${cmd}`);

        // [RELAY_HARDENING] Implicit readiness — if the webview is talking, it's alive.
        // This prevents 1-press failures if the READY signal was missed during a reload.
        this._dashboardRelay.setReady();

        // [MONOTONIC GUARD] Only adopt webview-reported intent IDs if they are strictly
        // higher than the engine's current counter. We delegate this to the engine's
        // adoptIntent methods which handle both state updates and context resets.
        if (payload.intentId !== undefined) {
            this._playbackEngine.adoptIntent(payload.intentId);
        }
        if (payload.batchId !== undefined) {
            this._playbackEngine.adoptBatchIntent(payload.batchId);
        }

        this._logger(`[READALOUD <- ${source.toUpperCase()}] Command: ${cmd} (Intent: ${payload.intentId}, Batch: ${payload.batchId})`);
        switch (cmd) {
            case OutgoingAction.READY:
                this._dashboardRelay.setReady();
                this._sendInitialState(); // Pulse-aware initialization
                break;

            case OutgoingAction.PLAY:
            case OutgoingAction.CONTINUE:
                await this.continue(payload.intentId, payload.batchId);
                break;

            case OutgoingAction.PAUSE:
                this.pause(payload.intentId);
                break;

            case OutgoingAction.STOP:
                this.stop(payload.intentId, payload.batchId);
                break;
            case OutgoingAction.JUMP_TO_CHAPTER:
                await this.jumpToChapter(payload.index, payload.intentId, payload.batchId);
                break;
            case OutgoingAction.NEXT_CHAPTER:
                await this.nextChapter(payload.intentId, payload.batchId);
                break;
            case OutgoingAction.PREV_CHAPTER:
                await this.prevChapter(payload.intentId, payload.batchId);
                break;

            case OutgoingAction.RATE_CHANGED:
                // [RATE_HARDENING] Previously unhandled — extension was silently dropping every
                // rate change from the webview, causing the next UI_SYNC to snap the slider back.
                // Now we persist the rate AND update the live StateStore so the cache key stays correct.
                if (typeof payload.rate === 'number' && payload.rate > 0) {
                    this._settingsManager.saveSetting('rate', payload.rate);
                    this._stateStore.setOptions({ rate: payload.rate });
                    this._logger(`[RATE] User rate committed: ${payload.rate}x`);
                }
                break;

            case OutgoingAction.VOLUME_CHANGED:
                if (typeof payload.volume === 'number') {
                    this._settingsManager.saveSetting('volume', payload.volume);
                    this._stateStore.setOptions({ volume: payload.volume });
                    this._logger(`[VOLUME] User volume committed: ${payload.volume}%`);
                }
                break;

            case OutgoingAction.VOICE_CHANGED:
                if (payload.voice) {
                    this._settingsManager.saveSetting('selectedVoice', payload.voice);
                    this._stateStore.setOptions({ selectedVoice: payload.voice });
                    this._logger(`[VOICE] choice -> [STORE] sync: ${payload.voice}`);
                }
                break;

            case OutgoingAction.REPORT_VOICES:
                this._voiceManager.updateLocalVoices(payload.voices);
                break;

            case OutgoingAction.ENGINE_MODE_CHANGED:
                if (payload.mode) {
                    this._settingsManager.saveSetting('engineMode', payload.mode);
                    this._playbackEngine.stop();
                    this._voiceManager.broadcastVoices();
                    this._broadcastCacheStats();
                    this._logger(`[ENGINE] User engineMode committed: ${payload.mode}`);
                }
                break;

            case OutgoingAction.SET_AUTO_PLAY_MODE:
                if (payload.mode) {
                    this._settingsManager.saveSetting('autoPlayMode', payload.mode);
                    this._logger(`[AUTOPLAY] User mode committed: ${payload.mode}`);
                }
                break;

            case OutgoingAction.SET_AUTOPLAY_INJECTION:
                this._settingsManager.saveSetting('autoPlayOnInjection', payload.value);
                this._logger(`[AUTOPLAY] injection_auto_play=${payload.value}`);
                break;

            case OutgoingAction.SET_AUTO_INJECT_SITREP:
                this._settingsManager.saveSetting('agent.autoInjectSITREP', payload.value);
                this._logger(`[SITREP] auto_inject=${payload.value}`);
                break;

            case OutgoingAction.SENTENCE_ENDED:
                if (!this._playbackEngine.isPaused) {
                    await this._audioBridge.next(this._getOptions(), false, this._stateStore.state.autoPlayMode, payload.intentId, payload.batchId);
                }
                break;
            case OutgoingAction.NEXT_SENTENCE:
                await this.nextSentence(payload.intentId, payload.batchId);
                break;
            case OutgoingAction.PREV_SENTENCE:
                await this.prevSentence(payload.intentId, payload.batchId);
                break;
            case OutgoingAction.JUMP_TO_SENTENCE:
                await this.jumpToSentence(payload.index, payload.intentId, payload.batchId);
                break;
            case OutgoingAction.FETCH_AUDIO:
                const audioData = this._playbackEngine.getAudioFromCache(payload.cacheKey);
                if (audioData) {
                    this._logger(`[BRIDGE] PULL_FETCH: ${payload.cacheKey} | Intent: ${payload.intentId}`);
                    // [3.1.C / Law 7.1] Confirm this key as a hit so the 200ms dedup window is armed.
                    // Prevents FETCH_FAILED from triggering redundant synthesis on the same key
                    // if a second FETCH_AUDIO arrives within the confirmation window.
                    this._audioBridge.notifyCacheConfirmation(payload.cacheKey);
                    // [3.2.A] Carry bakedRate in DATA_PUSH so the Webview AudioEngine
                    // can compute the correct effectiveRate = targetRate / bakedRate.
                    // Neural segments are always baked at 1.0; local TTS is baked at options.rate.
                    const dpOptions = this._getOptions();
                    const bakedRate = dpOptions.mode === 'neural' ? 1.0 : dpOptions.rate;
                    this._postToAll({
                        command: IncomingCommand.DATA_PUSH,
                        cacheKey: payload.cacheKey,
                        data: audioData,
                        intentId: payload.intentId,
                        bakedRate
                    });
                } else {
                    this._logger(`[BRIDGE_WARN] FETCH_FAILED: ${payload.cacheKey}. Awaiting webview retry or explicit synthesis request.`);
                    // [RESILIENCE] We no longer proactively fallback to synthesis here.
                    // The Webview is the boss of synthesis requests (OutgoingAction.REQUEST_SYNTHESIS).
                    // This prevents the "Synthesis Storm" when rapid intent changes occur.
                }
                break;
            case OutgoingAction.TOGGLE_PLAY_PAUSE:
                if (this._playbackEngine.isPlaying && !this._playbackEngine.isPaused) {
                    this.pause();
                } else {
                    await this.continue();
                }
                break;
            case OutgoingAction.LOAD_AND_PLAY:
                const loaded = await this.loadCurrentDocument();
                if (loaded) {
                    await this.continue();
                }
                break;
            case OutgoingAction.RESET_CONTEXT: this._resetContext(); break;
            case OutgoingAction.LOAD_DOCUMENT: 
                this.loadCurrentDocument(); 
                break;
            case OutgoingAction.REQUEST_SYNTHESIS:
                await this._audioBridge.synthesize(payload.cacheKey, this._getOptions(), payload.intentId, payload.batchId, payload.isPriority, payload.text);
                break;
            case OutgoingAction.CLEAR_CACHE:
                this._playbackEngine.clearCache();
                // [SYNC_HARDENING] Explicitly zero out stats in the StateStore [ISSUE 26]
                this._stateStore.patchState({
                    cacheCount: 0,
                    cacheSizeBytes: 0
                });
                this._logger(`[CACHE] Extension cache purged. Triggering webview sync...`);
                break;
            case OutgoingAction.REFRESH_VOICES:
                this._logger(`[VOICE] Manual refresh requested via UI.`);
                this._voiceManager.scanAndSync();
                break;
            case OutgoingAction.OPEN_FILE:
                const fileUri = payload.uri || payload.path;
                if (fileUri) {
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(fileUri));
                }
                break;
            case OutgoingAction.ERROR:
                this._logger(`[DASHBOARD_CRITICAL] ${payload.message || 'Unknown Error'}`);
                break;
            case OutgoingAction.LOG: 
                const logType = (payload.type || 'info').toUpperCase();
                this._logger(`[${source.toUpperCase()}:${logType}] ${payload.message}`); 
                break;
            
            case OutgoingAction.GET_ALL_SNIPPET_HISTORY:
                const history = await this._getSnippetHistory(data.force === true);
                this._stateStore.setHistory(history);
                break;
            case OutgoingAction.LOAD_SNIPPET:
                if (data.path) {
                    this.stop();
                    const success = await this._docController.loadSnippet(data.path);
                    if (success) {
                        const metadata = this._docController.metadata;
                        this._stateStore.setActiveDocument(
                            metadata.uri,
                            metadata.fileName,
                            metadata.relativeDir,
                            metadata.versionSalt,
                            metadata.contentHash,
                            null // No progress for external snippets for now
                        );
                        this._stateStore.setActiveMode('SNIPPET');
                        this.refreshView();
                    }
                }
                break;
            
            case OutgoingAction.SET_ACTIVE_MODE:
                if (data.mode) {
                    this._stateStore.setActiveMode(data.mode);
                    // No need to syncUI back immediately as webview already has it locally,
                    // but StateStore change will eventually trigger a sync anyway.
                }
                break;
            
            case OutgoingAction.REPORT_CACHE_DELTA:
                this._audioBridge.updateManifest(payload.delta);
                break;

            case OutgoingAction.PLAYBACK_BLOCKED:
                // [AUTOPLAY PROPAGATION] Webview browser blocked audio.play().
                // Align extension StateStore to PAUSED so the user can click 'Play' to resume.
                this._logger(`[BRIDGE] 🚫 PLAYBACK_BLOCKED received. Switching to PAUSED state. key=${payload.cacheKey || 'n/a'}`);
                this._playbackEngine.setPaused(true);
                this._stateStore.patchState({ isPlaying: false, isPaused: true });
                this._syncStatusBars();
                break;

            case OutgoingAction.EXECUTE_COMMAND:
                if (payload.commandId) {
                    this._logger(`[RPC] Executing: ${payload.commandId}`);
                    Promise.resolve(vscode.commands.executeCommand(payload.commandId, ...(payload.args || [])))
                        .then(result => {
                            this._logger(`[RPC] Success: ${payload.commandId}`);
                            if (payload.requestId) {
                                this._dashboardRelay.postMessage({
                                    command: IncomingCommand.COMMAND_RESULT,
                                    requestId: payload.requestId,
                                    success: true,
                                    result
                                });
                            }
                        })
                        .catch(err => {
                            this._logger(`[RPC] Error: ${payload.commandId} | ${err.message}`);
                            if (payload.requestId) {
                                this._dashboardRelay.postMessage({
                                    command: IncomingCommand.COMMAND_RESULT,
                                    requestId: payload.requestId,
                                    success: false,
                                    error: err.message
                                });
                            }
                        });
                }
                break;

            case OutgoingAction.OPEN_MCP_MENU:
                vscode.commands.executeCommand('virgo.manageMcp');
                break;
                
            case OutgoingAction.GET_MCP_STATUS:
                const result = McpConfigurator.checkConfigurationStatus();
                this._stateStore.patchState({ mcpStatus: result.status, mcpActiveAgents: result.activeAgents });
                break;
        }
    }

    /**
     * [v2.3.1 Architectural Hardening]
     * Sanitizes incoming webview payloads to prevent TypeErrors in downstream consumers.
     * Guarantees logical defaults for index, intentId, and batchId.
     */
    private _validatePayload(data: any): any {
        if (!data || typeof data !== 'object') {return {};}
        
        // Ensure critical primitives have defaults to prevent TypeErrors
        return {
            ...data,
            intentId: typeof data.intentId === 'number' ? data.intentId : (typeof data.intentId === 'string' ? parseInt(data.intentId) : 0),
            batchId: typeof data.batchId === 'number' ? data.batchId : (typeof data.batchId === 'string' ? parseInt(data.batchId) : 0),
            index: typeof data.index === 'number' ? data.index : (typeof data.value === 'number' ? data.value : 0),
            delta: {
                added: Array.isArray(data.delta?.added) ? data.delta.added : [],
                removed: Array.isArray(data.delta?.removed) ? data.delta.removed : [],
                isFullSync: !!data.delta?.isFullSync
            }
        };
    }

    private async _getSnippetHistory(forceScan: boolean = false): Promise<SnippetHistory> {
        // [T-035] Tier 1: O(1) index read — skips all filesystem scans
        if (!forceScan) {
            const fromIndex = this._indexManager.toSnippetHistory();
            if (fromIndex.length > 0) {
                this._logger(`[SNIPPET_HISTORY] Index hit: ${fromIndex.length} session(s)`);
                return this._ensureActiveSession(fromIndex);
            }
        }

        // [T-035] Tier 2: Cold-start fallback — full scan (index missing or empty)
        this._logger(`[SNIPPET_HISTORY] Index miss or forced scan — scanning filesystem`);
        const scanned = await this._getSnippetHistoryByScan();

        // Prime or merge the index from scan result
        if (scanned.length > 0) {
            this._indexManager.mergeFromHistory(scanned);
        }

        // Return the fully merged index to ensure consistency with what was written
        return this._ensureActiveSession(this._indexManager.toSnippetHistory());
    }

    /**
     * [Phase 21 — Fix B] Guarantees the current active session always appears in the
     * snippet history list, even when it has zero injected snippets.
     * This mirrors the "Focused File" UX — the UI always shows what session is live NOW.
     */
    private _ensureActiveSession(history: SnippetHistory): SnippetHistory {
        const alreadyPresent = history.some(s => s.id === this._sessionId);
        if (alreadyPresent) { return history; }

        // Resolve the display name from extension_state.json (same logic as _resolveDisplayName)
        let displayName: string | undefined;
        try {
            const stateFile = path.join(this._readAloudRoot, this._sessionId, 'extension_state.json');
            if (fs.existsSync(stateFile)) {
                const raw = fs.readFileSync(stateFile, 'utf-8');
                const state = JSON.parse(raw);
                displayName = state.session_title ?? undefined;
            }
        } catch { /* no-op — display raw id if state unreadable */ }

        this._logger(`[SNIPPET_HISTORY] Injecting active session sentinel: ${this._sessionId.slice(0, 8)} (${displayName ?? 'untitled'})`);

        // Prepend so active session is always first
        return [
            {
                id: this._sessionId,
                sessionName: displayName ?? this._sessionId,
                displayName,
                snippets: [] // Zero snippets — session is live but nothing injected yet
            },
            ...history
        ];
    }


    private async _getSnippetHistoryByScan(): Promise<SnippetHistory> {
        const rootUri = vscode.Uri.file(this._readAloudRoot);
        this._logger(`[SNIPPET_HISTORY] Scanning root: ${this._readAloudRoot}`);
        
        try {
            // 1. Get all session directories 
            const entries = await vscode.workspace.fs.readDirectory(rootUri);
            this._logger(`[SNIPPET_HISTORY] Found ${entries.length} entries in root`);

            // [MP-001 T-015] EXCLUDED_DIRS: sessions/ root only contains UUID session directories.
            // System dirs (protocols, tempmediaStorage, brain) live under virgo/ root —
            // they are NOT reachable from here. Filter reserved for future non-UUID entries.
            const EXCLUDED_DIRS = new Set<string>(['tempmediaStorage', '.write_test']);

            const allDirs = (await Promise.all(entries.map(async ([name, type]) => {
                if (type !== vscode.FileType.Directory) { return null; }
                
                if (EXCLUDED_DIRS.has(name)) {
                    return null;
                }
                const fullUri = vscode.Uri.joinPath(rootUri, name);
                try {
                    const stats = await vscode.workspace.fs.stat(fullUri);
                    return { id: name, mtime: stats.mtime, uri: fullUri };
                } catch { return null; }
            })))
            .filter((x): x is { id: string; mtime: number; uri: vscode.Uri } => x !== null)
            .sort((a, b) => b.mtime - a.mtime);

            let sessions = allDirs;

            const result: SnippetHistory = [];

            for (const session of sessions) {
                const sessionUri = session.uri;
                
                let displayName: string | undefined = undefined;
                try {
                    // [HUMAN_TITLES] Probe extension_state.json for the human-readable title
                    const stateUri = vscode.Uri.joinPath(sessionUri, 'extension_state.json');
                    const content = await vscode.workspace.fs.readFile(stateUri);
                    const state = JSON.parse(new TextDecoder().decode(content));
                    if (state.session_title) {
                        displayName = state.session_title;
                    }
                } catch (e) {
                    // It's okay if state file doesn't exist
                }

                const allFiles: { name: string, uri: vscode.Uri }[] = [];
                const collectFiles = async (dirUri: vscode.Uri) => {
                    try {
                        const entries = await vscode.workspace.fs.readDirectory(dirUri);
                        for (const [f, type] of entries) {
                            const childUri = vscode.Uri.joinPath(dirUri, f);
                            if (type === vscode.FileType.Directory) {
                                // Skip hidden directories like .system_generated
                                if (f.startsWith('.')) {continue;}
                                await collectFiles(childUri);
                            } else if (type === vscode.FileType.File) {
                                allFiles.push({ name: f, uri: childUri });
                            }
                        }
                    } catch (e) {
                        // ignore unreadable dirs
                    }
                };
                await collectFiles(sessionUri);

                const files = (await Promise.all(allFiles.map(async (fileItem) => {
                    const f = fileItem.name;
                    // [MP-001 T-015] Only surface markdown files — exclude extension_state.json
                    // and any other metadata files that are not user-facing snippets.
                    if (!f.endsWith('.md') && !f.endsWith('.markdown')) { return null; }
                    // Exclude metadata sidecars like .md.metadata.json or .md.resolved
                    if (f.includes('.md.')) { return null; }

                    const fileUri = fileItem.uri;
                    try {
                        const stats = await vscode.workspace.fs.stat(fileUri);
                        // [T-038] New filename format: <timestamp>.<name>.md (dot-separated)
                        // Extract name: strip leading timestamp prefix (e.g. "1776987443088.")
                        let snippetName = f.replace(/^\d+\./, '').replace(/\.(md|markdown)$/i, '');
                        return {
                            name: snippetName,
                            fsPath: fileUri.fsPath,
                            uri: fileUri.toString(),
                            timestamp: stats.mtime
                        };
                    } catch { return null; }
                })))
                .filter((x): x is { name: string; fsPath: string; uri: string; timestamp: number } => x !== null)
                .sort((a, b) => b.timestamp - a.timestamp);

                this._logger(`[SNIPPET_HISTORY] Session ${session.id.slice(0, 8)}: ${files.length} snippets`);
                if (files.length > 0) {
                    result.push({
                        id: session.id,
                        sessionName: displayName || session.id,
                        displayName: displayName,
                        snippets: files
                    });
                }
            }

            return result;
        } catch (e) {
            this._logger(`[SNIPPET_HISTORY] FAILED: ${e}`);
            return [];
        }
    }

    private async _sendInitialState() {
        // [TRIPLE-PULSE] Orchestrated Non-Blocking Startup
        this._logger('[STARTUP] pulse_1_structural_handshake');

        // [DIAG] Snapshot the full STATE at the moment the webview fires 'ready'
        const snapFocused = this._stateStore.state.focusedDocumentUri?.fsPath ?? 'UNDEFINED';
        const snapActive = this._stateStore.state.activeDocumentUri?.fsPath ?? 'UNDEFINED';
        const snapFocusedName = this._stateStore.state.focusedFileName;
        const snapEditor = vscode.window.activeTextEditor?.document.fileName ?? 'NO_ACTIVE_EDITOR';
        const snapTab = (() => {
            const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
            const input = tab?.input as any;
            return input?.uri?.fsPath || input?.resource?.fsPath || 'NO_TAB';
        })();
        this._logger(`[DIAG:PULSE1] focusedUri=${snapFocused} | focusedName=${snapFocusedName} | activeUri=${snapActive} | activeEditor=${snapEditor} | activeTab=${snapTab}`);

        // Pulse 1: Immediate Structural Sync (Unlocks UI Shell)
        this._stateStore.patchState({
            currentChapterIndex: 0,
            currentSentenceIndex: 0,
            isHydrated: true,
            activeSessionId: this._sessionId // Ensure session is synced early
        }, true); // [v2.4.6] SILENT: Suppress sync broadcast until contextual load (Pulse 2) completes.

        // [DPG] Mark webview as ready and attempt the one-shot initial load.
        // Once _initialLoadExecuted is true, setActiveEditor will never trigger auto-loads.
        this._webviewIsReady = true;
        this._initialLoadExecuted = true; 
        await this._tryInitialDocumentLoad();

        // [v2.4.6] Finalize Pulse 1 & 2 structural hydration with a single, authoritative sync.
        this._syncManager.requestSync(true);

        // Pulse 3: Heavy Data Discovery (Background/Async)
        this._logger('[STARTUP] pulse_3_background_discovery_initiated');
        this._voiceManager.scanAndSync().then(async () => {
             const history = await this._getSnippetHistory();
             this._stateStore.setHistory(history);
            this._logger('[STARTUP] pulse_3_complete');
        }).catch(e => {
            this._logger(`[STARTUP] pulse_3_failed: ${e}`);
        });
    }

    /**
     * [DPG] Dual-Precondition Gate.
     * Only executes document load when BOTH conditions are satisfied:
     *   1. Webview has fired 'ready' (DOM is live, can receive messages)
     *   2. A focusedDocumentUri is known (we have a real file to load)
     * This decouples startup from timing; whichever condition arrives last
     * will trigger the load — eliminating the Dead UI race condition.
     */
    private async _tryInitialDocumentLoad() {
        if (!this._webviewIsReady) {
            this._logger('[DPG] Gate blocked: webview not yet ready.');
            return;
        }

        // [v2.3.2] Check if we have a valid URI in the State Store
        const hasUri = !!this._stateStore.state.focusedDocumentUri;
        
        if (!hasUri) {
            // [v2.3.5] STANDBY Support: If no URI and no persisted doc, unblock the UI anyway.
            if (!this._stateStore.state.activeDocumentUri) {
                this._logger('[DPG] 🛡️ No focus or persistence detected. Entering STANDBY mode.');
                return;
            }
            
            this._logger('[DPG] No focus, but persisted activeDoc detected. Yielding to persistence.');
            return;
        }

        this._logger('[DPG] ✅ Executing Pulse 2: contextual hydration.');

        // [Law F.1 — Persistence Yield] If PersistenceManager already restored an activeDocumentUri,
        // the user explicitly chose that document last session. Do NOT overwrite it with the currently
        // focused editor tab. Just sync the UI to reflect the restored state.
        if (this._stateStore.state.activeDocumentUri) {
            this._logger(`[DPG] Persisted activeDoc exists (${this._stateStore.state.activeFileName}). Yielding — skipping auto-load. Syncing only.`);
            return;
        }

        // Pulse 2: Contextual Hydration (Active Document) — only when no persisted doc exists
        // [v2.3.5] Use silent flag to prevent start-up alerts if focus is on a non-markdown file.
        await this.loadCurrentDocument(true, true);
    }


    public async loadCurrentDocument(useHydratedProgress: boolean = false, isSilent: boolean = false): Promise<boolean> {
        if (this._isLoadingDocument) {
            this._logger('[DOC_LOAD] Already in progress, skipping redundant call.');
            return false;
        }

        this._isLoadingDocument = true;
        try {
            // [REINFORCEMENT] Clear current playback immediately to prevent audio overlap
            this.stop();

            // [DOC_PROBE FIX] Pass focusedDocumentUri as a hint so loadActiveDocument can
            // resolve the correct file even when activeTextEditor is null (sidebar has focus).
            const hintUri = this._stateStore.state.focusedDocumentUri;
            const activeEditorNow = vscode.window.activeTextEditor?.document.fileName ?? 'null';
            const tabNow = (() => {
                const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
                const input = tab?.input as any;
                return input?.uri?.fsPath || input?.resource?.fsPath || 'null';
            })();
            this._logger(`[DOC_LOAD] START | hintUri=${hintUri?.fsPath ?? 'null'} | activeEditor=${activeEditorNow} | activeTab=${tabNow} | useHydrated=${useHydratedProgress} | silent=${isSilent}`);
            const success = await this._docController.loadActiveDocument(hintUri);
            this._logger(`[DOC_LOAD] loadActiveDocument success: ${success}`);
            if (!success) {
                this._logger(`[DOC_LOAD] ${isSilent ? '🛡️' : '❌'} No active document found. ${isSilent ? 'Silently entering STANDBY.' : 'UI will be "Dead".'}`);
                if (!isSilent) {
                    this._postToAll({
                        command: 'synthesisError',
                        error: 'No active document found to read.',
                        isFallingBack: false
                    });
                }
                return false;
            }
            this._logger(`[DOC_LOAD] ✅ Extracted ${this._docController.chapters.length} chapters.`);

            const metadata = this._docController.metadata;
            const chapters = this._docController.chapters;

            // Determine if we should use existing StateStore progress (from persistence rehydration)
            const initialProgress = useHydratedProgress ? { 
                chapterIndex: this._stateStore.state.currentChapterIndex, 
                sentenceIndex: this._stateStore.state.currentSentenceIndex 
            } : null;

            // Commit to STATE: Update the active context (Loaded File) Atomically
            this._stateStore.setActiveDocument(
                metadata.uri,
                metadata.fileName,
                metadata.relativeDir,
                metadata.versionSalt,
                metadata.contentHash,
                initialProgress,
                isSilent // [v2.4.6] Use isSilent flag to suppress sync storms during boot
            );

            if (metadata.uri && !useHydratedProgress) {
                // Only probe SettingsManager if we're not already use hydrated context
                const progress = this._settingsManager.loadProgress(metadata.uri, metadata.versionSalt, metadata.contentHash);
                if (progress) {
                    this._stateStore.setProgress(progress.chapterIndex, progress.sentenceIndex, isSilent);
                    this._logger(`[RECOVERY] Resumed ${metadata.uri.path} at C:${progress.chapterIndex} S:${progress.sentenceIndex}`);
                }
            }

            this._stateStore.setActiveMode('FILE', isSilent);

            // [SYNC_HARDENING] Force immediate, exhaustive relay sync to prevent "Dead UI" race conditions.
            if (!isSilent) {
                this._syncManager.requestSync(true);
            }

            if (chapters.length > 0) {
                const currentPos = this._stateStore.state;
                const currentChapter = chapters[currentPos.currentChapterIndex] || chapters[0];
                const text = currentChapter.sentences[currentPos.currentSentenceIndex] || currentChapter.sentences[0];

                this._postToAll({
                    command: 'sentenceChanged',
                    text: text,
                    index: currentPos.currentSentenceIndex,
                    chapterIndex: currentPos.currentChapterIndex
                });
            }

            return true;
        } catch (e) {
            this._logger(`[DOC_LOAD] FAILED: ${e}`);
            return false;
        } finally {
            this._isLoadingDocument = false;
        }
    }

    private _resetContext() {
        this._audioBridge.stop();
        this._docController.clear();
        this._stateStore.clearActiveContext();

        this._logger('[READALOUD] Context Reset: Reader cleared.');
    }

    public clearCache(): void {
        this._logger('[CMD] Manual clearCache triggered');
        this._playbackEngine.clearCache();
        
        // Zero out cache stats immediately on the extension side
        this._stateStore.patchState({
            cacheCount: 0,
            cacheSizeBytes: 0
        });
        
        // Notify the Webview to wipe its IndexedDB audio cache
        this._dashboardRelay.postMessage({ command: IncomingCommand.CLEAR_CACHE_WIPE });
        this._logger(`[CACHE] Extension cache purged manually. Triggering webview wipe...`);
    }

    public play(text: string, startFromChapter: number = 0, fileName?: string) {
        this._logger(`[SPEECH_PROVIDER] action:play | file: ${fileName} | start: ${startFromChapter}`);
        this._dashboardRelay.authorizePlayback(); // [COLD-BOOT GATE] User gesture — unlock relay
        this._audioBridge.authorizePlayback();    // [UM-1] User gesture — unlock setPlaying gate
        this._stateStore.setProgress(startFromChapter, 0);
        // [FIX-5] audioBridge.start() → playbackEngine.setPlaying(!previewOnly) is the authoritative sink.
        // Removed: this._playbackEngine.setPlaying(true); ← was causing 2x engineStatus:playing emissions.
        this._audioBridge.start(startFromChapter, 0, this._getOptions());
    }

    /**
     * [v2.3.2] Check if the player is currently hydrated with valid document content.
     * Allows naive play/resume commands when no active editor is focused.
     */
    public isHydrated(): boolean {
        return !!this._stateStore.state.activeDocumentUri && this._docController.chapters.length > 0;
    }

    public pause(intentId?: number) {
        this._logger(`[SPEECH_PROVIDER] action:pause | intent: ${intentId}`);
        // [FIX-4] audioBridge.pause() → playbackEngine.setPaused(true) already emits status once.
        // The extra setPaused call below was causing 2x engineStatus:paused emissions per pause.
        // Removed: this._playbackEngine.setPaused(true, intentId);
        this._audioBridge.pause(intentId);
    }

    public togglePlayPause() {
        const state = this._stateStore.state;
        if (state.isPaused) {
            this.continue();
        } else if (state.isPlaying) {
            this.pause();
        } else {
            // If stopped or not started, start from beginning or current progress
            this.continue();
        }
    }

    public stop(intentId?: number, batchId?: number) {
        this._logger(`[SPEECH_PROVIDER] action:stop | intent: ${intentId} | batch: ${batchId}`);
        // [FIX-3] audioBridge.stop() → playbackEngine.stop() already sets _isPlaying=false,
        // _isPaused=false, _isStalled=false and emits 'status' once. The two extra calls below
        // were causing 3x engineStatus:idle emissions per stop (one per setter + one from stop()).
        // Removed: this._playbackEngine.setPlaying(false, intentId);
        // Removed: this._playbackEngine.setPaused(false, intentId);
        this._audioBridge.stop(intentId, batchId);
        this._logger(`[STOP] playback_stop (Intent: ${intentId ?? 'current'}, BatchReset: ${!!batchId})`);
    }

    public async continue(intentId?: number, batchId?: number) {
        this._logger(`[SPEECH_PROVIDER] action:continue | intent: ${intentId} | batch: ${batchId} | hydrated: ${this.isHydrated()}`);
        this._dashboardRelay.authorizePlayback(); // [COLD-BOOT GATE] User gesture — unlock relay
        this._audioBridge.authorizePlayback();    // [UM-1] User gesture — unlock setPlaying gate
        this._stateStore.setPreviewing(false); // Commit to full playback

        // [PLAY-GATE] If no chapters are loaded, the user pressed Play before DPG finished.
        // Load the document now (silent) and then proceed — bridge.start() will have chapters.
        if (this._docController.chapters.length === 0) {
            this._logger('[SPEECH_PROVIDER] ⚠️ PLAY fired before document load. Triggering silent load...');
            const loaded = await this.loadCurrentDocument(false, true);
            if (!loaded) {
                this._logger('[SPEECH_PROVIDER] ❌ Silent load failed. Cannot start playback.');
                return;
            }
        }

        // [SOVEREIGNTY] Bridge.start handles all necessary engine resets and status updates.
        // We do not call playbackEngine directly here to avoid redundant event cycles.
        await this._audioBridge.start(this._stateStore.state.currentChapterIndex, this._stateStore.state.currentSentenceIndex, this._getOptions(), false, intentId, batchId);
    }

    public startOver() {
        this.jumpToSentence(0);
    }

    public async jumpToSentence(index: number, intentId?: number, batchId?: number) {
        this._stateStore.setPreviewing(false); // Navigation often implies intent to play from there
        this._dashboardRelay.authorizePlayback(); // [COLD-BOOT GATE] User gesture — unlock relay
        await this._audioBridge.start(this._stateStore.state.currentChapterIndex, index, this._getOptions(), false, intentId, batchId);
    }

    public async jumpToChapter(index: number, intentId?: number, batchId?: number) {
        const chapters = this._docController.chapters;
        if (index < 0 || index >= chapters.length) { return; }
        this._stateStore.setPreviewing(false);
        this._dashboardRelay.authorizePlayback(); // [COLD-BOOT GATE] User gesture — unlock relay
        // [FIX-6] State-preserving navigation: if the engine is currently stopped/paused,
        // pass previewOnly=true so audioBridge.start() synthesizes audio but does NOT
        // force isPlaying=true. This mirrors the webview-side FIX-1 (jumpToChapter preservation).
        const wasPlaying = this._playbackEngine.isPlaying && !this._playbackEngine.isPaused;
        await this._audioBridge.start(index, 0, this._getOptions(), !wasPlaying, intentId, batchId);
    }

    public async nextChapter(intentId?: number, batchId?: number) {
        const state = this._stateStore.state;
        const chapters = this._docController.chapters;
        if (!chapters || chapters.length === 0) { return; }

        const nextIdx = state.currentChapterIndex + 1;
        if (nextIdx < chapters.length) {
            await this.jumpToChapter(nextIdx, intentId, batchId);
        } else {
            this._logger('[READALOUD] Already at the last chapter.');
        }
    }

    public async prevChapter(intentId?: number, batchId?: number) {
        const state = this._stateStore.state;
        const chapters = this._docController.chapters;
        if (!chapters || chapters.length === 0) { return; }

        if (state.currentSentenceIndex > 0) {
            // Restart current chapter
            await this.jumpToChapter(state.currentChapterIndex, intentId, batchId);
        } else if (state.currentChapterIndex > 0) {
            // Jump to previous chapter
            await this.jumpToChapter(state.currentChapterIndex - 1, intentId, batchId);
        } else {
            this._logger('[READALOUD] Already at the first chapter.');
        }
    }

    public async prevSentence(intentId?: number, batchId?: number) {
        await this._audioBridge.previous(this._getOptions(), intentId, batchId);
    }

    public async nextSentence(intentId?: number, batchId?: number) {
        await this._audioBridge.next(this._getOptions(), true, this._stateStore.state.autoPlayMode, intentId, batchId);
    }

    private _onSelectionChange(chapterIndex: number, sentenceIndex: number) {
        const { activeDocumentUri, versionSalt, activeContentHash } = this._stateStore.state;
        if (activeDocumentUri) {
            this._settingsManager.saveProgress(activeDocumentUri, versionSalt, activeContentHash, chapterIndex, sentenceIndex);
        }
    }

    private _getOptions(): PlaybackOptions {
        const state = this._stateStore.state;
        return {
            voice: state.selectedVoice || 'en-US-SteffanNeural',
            rate: state.rate,
            volume: state.volume,
            mode: state.engineMode
        };
    }

    private _broadcastCacheStats() {
        const stats = this._playbackEngine.getCacheStats();
        this._dashboardRelay.postMessage({
            command: IncomingCommand.CACHE_STATS_UPDATE,
            count: stats.count,
            size: stats.sizeBytes
        });
    }

    // getFileVersionSalt logic moved to DocumentLoadController
}
