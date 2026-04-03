import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Chapter } from '@core/documentParser';
import { DocumentLoadController } from '@core/documentLoadController';
import { StateStore } from '@core/stateStore';
import { PlaybackEngine, PlaybackOptions } from '@core/playbackEngine';
import { SequenceManager } from '@core/sequenceManager';
import { AudioBridge } from '@core/audioBridge';
import { DashboardRelay } from './dashboardRelay';
import { OutgoingAction } from '@common/types';

export class SpeechProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _extensionPath: string;

    private _docController: DocumentLoadController;
    private _sequenceManager: SequenceManager;
    private _stateStore: StateStore;
    private _audioBridge: AudioBridge;
    private _dashboardRelay: DashboardRelay;

    // Selection state (passive) - Moved to StateStore

    private _playbackEngine: PlaybackEngine;
    private _needsSync: boolean = false;
    private _localVoices: any[] = [];
    private _neuralVoices: any[] = [];
    private _statusBarItem: vscode.StatusBarItem;

    private _lastReportedProgress: number = -1;
    private _debounceTimers: Map<string, NodeJS.Timeout> = new Map();


    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _logger: (msg: string) => void,
        statusBarItem: vscode.StatusBarItem,
        public onVisibilityChanged?: () => void
    ) {
        this._extensionUri = _context.extensionUri;
        this._extensionPath = _context.extensionPath;
        this._docController = new DocumentLoadController(this._logger);
        this._sequenceManager = new SequenceManager();
        this._stateStore = new StateStore(this._logger);
        this._playbackEngine = new PlaybackEngine(_logger, () => this._broadcastCacheStats());
        this._audioBridge = new AudioBridge(this._stateStore, this._docController, this._playbackEngine, this._sequenceManager, this._logger);
        this._dashboardRelay = new DashboardRelay(this._stateStore, this._docController, this._playbackEngine, this._logger);
        this._statusBarItem = statusBarItem;

        // Register AudioBridge Events
        this._audioBridge.on('playAudio', payload => this._dashboardRelay.postMessage({ command: 'playAudio', ...payload }));
        this._audioBridge.on('synthesisError', payload => this._dashboardRelay.postMessage({ command: 'synthesisError', ...payload }));
        this._audioBridge.on('engineStatus', payload => this._dashboardRelay.postMessage({ command: 'engineStatus', ...payload }));
        this._audioBridge.on('playbackFinished', () => this._syncStatusBars());

        // Load Persisted Settings into StateStore
        const rate = this._context.globalState.get<number>('readAloud.rate', 0);
        const volume = this._context.globalState.get<number>('readAloud.volume', 50);
        const voice = this._context.globalState.get<string>('readAloud.voice', 'en-US-AriaNeural');
        const engineMode = this._context.globalState.get<'local' | 'neural'>('readAloud.engineMode', 'neural');
        const autoPlayMode = this._context.globalState.get<'auto' | 'chapter' | 'row'>('readAloud.autoPlayMode', 'auto');

        this._stateStore.setOptions({
            rate,
            volume,
            selectedVoice: voice,
            engineMode,
            autoPlayMode
        });

        // Initial setup of document context listeners
        this._setupDocumentListeners();

        // Tier-3: High-Density Log Format (Extension Boot)
        this._logger('[BOOT] extension_activated');
        this._loadVoices();

        // [Reactive Sync] Subscribe to StateStore changes
        this._stateStore.on('change', () => {
            if (this._view?.visible) {
                this._syncUI();
            } else {
                this._needsSync = true;
            }
            this._saveProgressThrottled();
        });


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
        if (!uri) {
            this._stateStore.setFocusedFile(undefined, 'No Selection', '', false);
            return;
        }

        const fileName = path.basename(uri.fsPath);
        const isSupported = this._isFormatSupported(fileName);

        let relativeDir = '';
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (folder) {
            const relPath = path.relative(folder.uri.fsPath, path.dirname(uri.fsPath));
            relativeDir = folder.name + (relPath && relPath !== '.' ? ' / ' + relPath.replace(/\\/g, ' / ') : '');
        } else {
            relativeDir = path.dirname(uri.fsPath).split(/[\\\/]/).slice(-2).join(' / ');
        }

        const versionSalt = isSupported ? this._docController.getFileVersionSalt(uri) : undefined;
        this._stateStore.setFocusedFile(uri, fileName, relativeDir, isSupported, versionSalt);
        this._logger(`[FOCUS] ${fileName} | supported: ${isSupported} | salt: ${versionSalt}`);
    }

    private _isFormatSupported(fileName: string): boolean {
        const artifactRegex = /\.(md|markdown|txt|log|resolved\.\d+)$/i;
        return artifactRegex.test(fileName);
    }

    private async _loadVoices() {
        try {
            const { local, neural } = await this._playbackEngine.getVoices();
            this._localVoices = local;
            this._neuralVoices = neural;
            this._stateStore.setVoices(local, neural);
            this._logger(`[VOICE_SCAN] SUCCESS: Found ${this._localVoices.length} local SAPI voices and ${this._neuralVoices.length} neural voices.`);

            // Critical: Ensure UI is synced after voices are loaded to prevent empty dropdowns
            this._syncUI();
        } catch (e) {
            this._logger(`[VOICE_SCAN] CRITICAL FAILURE: ${e}`);
        }
    }

    private _debounceSave(key: string, value: any) {
        if (this._debounceTimers.has(key)) {
            clearTimeout(this._debounceTimers.get(key)!);
        }
        this._debounceTimers.set(key, setTimeout(() => {
            this._context.globalState.update('readAloud.' + key, value);
            this._logger(`[PERSIST] ${key} -> ${value}`);
            this._debounceTimers.delete(key);
        }, 1000));
    }

    private _broadcastVoices() {
        this._dashboardRelay.broadcastVoices(this._localVoices, this._neuralVoices, this._stateStore.state.engineMode);
    }

    private _saveProgressTimer?: NodeJS.Timeout;
    private _saveProgressThrottled() {
        if (this._saveProgressTimer) { clearTimeout(this._saveProgressTimer); }
        this._saveProgressTimer = setTimeout(() => {
            const state = this._stateStore.state;
            if (!state.activeDocumentUri) { return; }

            const uriStr = state.activeDocumentUri.toString();
            const saltStr = state.versionSalt ? `-${state.versionSalt}` : '';
            const hashStr = state.activeContentHash ? `#${state.activeContentHash}` : '';

            // NEW: Composite Content-Aware Key
            const storageKey = `${uriStr}${saltStr}${hashStr}`;

            const progress = {
                chapterIndex: state.currentChapterIndex,
                sentenceIndex: state.currentSentenceIndex,
                lastUpdated: Date.now()
            };

            const allProgress = this._context.globalState.get<Record<string, any>>('readAloud.docProgress', {});

            // [REINFORCEMENT] If we have a legacy entry for this EXACT file, clean it up now that we're saving a hashed version
            if (allProgress[uriStr]) {
                delete allProgress[uriStr];
            }

            allProgress[storageKey] = progress;

            // [REINFORCEMENT] Scoped Garbage Collection (Limit to 50 entries)
            const keys = Object.keys(allProgress);
            if (keys.length > 50) {
                // 1. Try to find older versions of the SAME file first
                const otherVersions = keys.filter(k => k.startsWith(uriStr) && k !== storageKey);
                if (otherVersions.length > 0) {
                    const oldestVersion = otherVersions.sort((a, b) => (allProgress[a].lastUpdated || 0) - (allProgress[b].lastUpdated || 0))[0];
                    delete allProgress[oldestVersion];
                    this._logger(`[GC] Purged older version of current file: ${oldestVersion}`);
                } else {
                    // 2. Global fallback: Delete the oldest item overall
                    const sortedKeys = keys.sort((a, b) => (allProgress[a].lastUpdated || 0) - (allProgress[b].lastUpdated || 0));
                    delete allProgress[sortedKeys[0]];
                }
            }

            this._context.globalState.update('readAloud.docProgress', allProgress);
        }, 1000);
    }

    private _loadProgress(uri: vscode.Uri, salt?: string, hash?: string): { chapterIndex: number, sentenceIndex: number } | null {
        const allProgress = this._context.globalState.get<Record<string, any>>('readAloud.docProgress', {});
        const uriStr = uri.toString();
        const saltStr = salt ? `-${salt}` : '';
        const hashStr = hash ? `#${hash}` : '';

        const storageKey = `${uriStr}${saltStr}${hashStr}`;

        // 1. Try the Content-Aware Key
        let progress = allProgress[storageKey];

        // 2. [PASSIVE MIGRATION] Fallback to legacy URI-only key
        if (!progress && allProgress[uriStr]) {
            progress = allProgress[uriStr];
            this._logger(`[MIGRATION] Found legacy progress for ${uri.path}. Upgrading to content-aware key.`);

            // Note: We don't delete here to keep this method READ-ONLY. 
            // The next _saveProgressThrottled (triggered by position updates) will handle the deletion.
        }

        return progress ? { chapterIndex: progress.chapterIndex, sentenceIndex: progress.sentenceIndex } : null;
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
                if (key === 'data' && typeof val === 'string' && val.length > 1000) {
                    sanitized[key] = `[BINARY_DATA: ${Math.round(val.length / 1024)}KB]`;
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
    /**
     * Unified Reactive Sync: Gather all state and broadcast to the webview.
     * This is the "Single Source of Truth" relay point.
     */
    private _syncUI() {
        this._dashboardRelay.sync();
    }

    private _postToAll(msg: any) {
        this._dashboardRelay.postMessage(msg);
        this._syncStatusBars();
    }

    public isPlaying() { return this._playbackEngine.isPlaying; }
    public isPaused() { return this._playbackEngine.isPaused; }

    private _syncStatusBars() {
        const isPlaying = this._playbackEngine.isPlaying;
        const isPaused = this._playbackEngine.isPaused;

        if (isPlaying) {
            this._statusBarItem.text = isPaused ? "$(play) Resume" : "$(debug-pause) Pause";
            this._statusBarItem.backgroundColor = isPaused ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        } else {
            this._statusBarItem.text = "$(unmute) Read Aloud";
            this._statusBarItem.backgroundColor = undefined;
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        this._dashboardRelay.setView(webviewView);
        this._syncUI();
        this._logger('--- ACTIVATING MISSION CONTROL (Sidebar) ---');

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'media')]
        };

        webviewView.webview.onDidReceiveMessage(data => {
            if (data.command === 'ready') {
                this._sendInitialState();
                this._broadcastVoices();
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
        });


        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                if (this._needsSync) {
                    this._logger('[VISIBILITY] Sidebar revealed. Partial Sync...');
                    this._syncUI();
                    this._needsSync = false;
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
            debugMode: this._context.extensionMode === vscode.ExtensionMode.Development
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

        html = html.replace('</head>', `${bootstrap}\n</head>`);

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

    public refreshView() {
        this._syncUI();
        this._broadcastVoices();

        if (this._docController.chapters.length > 0) {
            this._postToAll({
                command: 'chapters',
                chapters: this._docController.chapters.map((c, i) => ({
                    title: c.title,
                    level: c.level,
                    index: i,
                    count: c.sentences.length
                })),
                current: this._stateStore.state.currentChapterIndex,
                total: this._docController.chapters.length
            });
        }
    }

    private async _handleWebviewMessage(data: any, source: string = 'webview') {
        if (!data || !data.command) {
            this._logger(`[DASHBOARD -> EXTENSION] IGNORED_MALFORMED_MESSAGE: ${JSON.stringify(data)}`);
            return;
        }

        const cmd = data.command;
        this._logger(`[READALOUD <- ${source.toUpperCase()}] Command: ${cmd}`);

        switch (cmd) {
            case OutgoingAction.READY:
                this._sendInitialState();
                if (this._docController.chapters.length > 0) {
                    this.refreshView();
                }
                break;
            case OutgoingAction.PLAY:
                this.continue();
                break;
            case OutgoingAction.JUMP_TO_CHAPTER:
                this.jumpToChapter(data.index);
                break;
            case OutgoingAction.NEXT_CHAPTER:
                this.nextChapter();
                break;
            case OutgoingAction.PREV_CHAPTER:
                this.prevChapter();
                break;

            case OutgoingAction.SET_AUTO_PLAY_MODE:
                this._stateStore.setOptions({ autoPlayMode: data.mode });
                this._syncUI(); // Ensure immediate visual feedback
                break;
            case 'toggleAutoPlay':
                // Backward compatibility for old calls if any
                this._stateStore.setOptions({ autoPlayMode: data.enabled ? 'auto' : 'row' });
                break;
            case OutgoingAction.VOICE_CHANGED:
                this._stateStore.setOptions({ selectedVoice: data.voice });
                if (this._context.globalState) {
                    this._context.globalState.update('readAloud.voice', data.voice);
                }
                this._logger(`[VOICE] ${data.voice} | SURGICAL_PREVIEW`);
                // Stop any current full playback but trigger a single-sentence preview synth
                this._playbackEngine.stop();
                this._audioBridge.start(this._stateStore.state.currentChapterIndex, this._stateStore.state.currentSentenceIndex, this._getOptions(), true);
                break;
            case OutgoingAction.RATE_CHANGED:
                this._stateStore.setOptions({ rate: data.rate });
                this._debounceSave('rate', data.rate);
                break;
            case OutgoingAction.VOLUME_CHANGED:
                this._stateStore.setOptions({ volume: data.volume });
                this._debounceSave('volume', data.volume);
                break;
            case OutgoingAction.ENGINE_MODE_CHANGED:
                this._stateStore.setOptions({ engineMode: data.mode });
                this._playbackEngine.stop();
                this._broadcastVoices();
                this._broadcastCacheStats();
                break;

            case OutgoingAction.SENTENCE_ENDED:
                if (!this._playbackEngine.isPaused) {
                    this._audioBridge.next(this._getOptions(), false, this._stateStore.state.autoPlayMode);
                }
                break;
            case OutgoingAction.NEXT_SENTENCE:
                this._audioBridge.next(this._getOptions(), true, this._stateStore.state.autoPlayMode);
                break;
            case OutgoingAction.PREV_SENTENCE:
                this._audioBridge.previous(this._getOptions());
                break;
            case OutgoingAction.JUMP_TO_SENTENCE: this.jumpToSentence(data.index); break;
            case OutgoingAction.CONTINUE: this.continue(); break;
            case OutgoingAction.TOGGLE_PLAY_PAUSE:
                if (this._playbackEngine.isPlaying && !this._playbackEngine.isPaused) {
                    this.pause();
                } else {
                    this.continue();
                }
                break;
            case OutgoingAction.LOAD_AND_PLAY:
                const loaded = await this.loadCurrentDocument();
                if (loaded) {
                    this.continue();
                }
                break;
            case OutgoingAction.RESET_CONTEXT: this._resetContext(); break;
            case OutgoingAction.STOP: this.stop(); break;
            case OutgoingAction.PAUSE: this.pause(); break;
            case OutgoingAction.LOAD_DOCUMENT: this.loadCurrentDocument(); break;
            case OutgoingAction.REQUEST_SYNTHESIS:
                this._audioBridge.synthesize(data.cacheKey, this._getOptions());
                break;
            case OutgoingAction.CLEAR_CACHE:
                this._playbackEngine.clearCache();
                this._logger(`[CACHE] Extension cache purged. Triggering webview sync...`);
                this._syncUI();
                break;
            case OutgoingAction.OPEN_FILE:
                const fileUri = data.uri || data.path;
                if (fileUri) {
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(fileUri));
                }
                break;
            case OutgoingAction.ERROR:
                this._logger(`[DASHBOARD_CRITICAL] ${data.message || 'Unknown Error'}`);
                break;
            case OutgoingAction.LOG: 
                const logType = (data.type || 'info').toUpperCase();
                this._logger(`[${source.toUpperCase()}:${logType}] ${data.message}`); 
                break;
        }
    }

    private _sendInitialState() {
        this._syncUI();
        this._broadcastVoices();
    }


    public async loadCurrentDocument(): Promise<boolean> {
        // [REINFORCEMENT] Clear current playback immediately to prevent audio overlap
        this.stop();

        const success = await this._docController.loadActiveDocument();
        if (!success) {
            this._postToAll({
                command: 'synthesisError',
                error: 'No active document found to read.',
                isFallingBack: false
            });
            return false;
        }

        const metadata = this._docController.metadata;
        const chapters = this._docController.chapters;

        // [ATOMIC] Calculate progress BEFORE updating state to prevent double-sync flicker [ISSUE 25]
        const saved = metadata.uri ? this._loadProgress(metadata.uri, metadata.versionSalt, metadata.contentHash) : null;

        // Commit to STATE: Update the active context (Loaded File) Atomically
        this._stateStore.setActiveDocument(
            metadata.uri,
            metadata.fileName,
            metadata.relativeDir,
            metadata.versionSalt,
            metadata.contentHash,
            saved
        );

        if (saved) {
            this._logger(`[PERSISTENCE] Restored position: ${saved.chapterIndex}:${saved.sentenceIndex}`);
        }

        // UNIFIED SYNC: Propagate the updated state to Dashboard
        this._syncUI();

        if (chapters.length > 0) {
            const currentPos = this._stateStore.state;
            const currentChapter = chapters[currentPos.currentChapterIndex] || chapters[0];
            const text = currentChapter.sentences[currentPos.currentSentenceIndex] || currentChapter.sentences[0];

            this._postToAll({
                command: 'sentenceChanged',
                text: text,
                index: currentPos.currentSentenceIndex
            });
        }

        return true;
    }

    private _resetContext() {
        this._audioBridge.stop();
        this._docController.clear();
        this._stateStore.clearActiveContext();

        this._syncUI();
        this._logger('[READALOUD] Context Reset: Reader cleared.');
    }

    public play(text: string, startFromChapter: number = 0, fileName?: string) {
        this._stateStore.setProgress(startFromChapter, 0);
        this._playbackEngine.setPlaying(true);
        this._audioBridge.start(startFromChapter, 0, this._getOptions());
    }

    public pause() {
        this._audioBridge.pause();
        this._playbackEngine.setPaused(true);
        this._syncUI();
    }

    public stop() {
        this._audioBridge.stop();
        this._playbackEngine.setPlaying(false);
        this._playbackEngine.setPaused(false);
        this._syncUI();
        this._logger('[STOP] playback_stop');
    }

    public continue() {
        this._stateStore.setPreviewing(false); // Commit to full playback
        this._playbackEngine.setPlaying(true);
        this._playbackEngine.setPaused(false);
        this._syncUI();
        this._audioBridge.start(this._stateStore.state.currentChapterIndex, this._stateStore.state.currentSentenceIndex, this._getOptions());
    }

    public startOver() {
        this.jumpToSentence(0);
    }

    public jumpToSentence(index: number) {
        this._stateStore.setPreviewing(false); // Navigation often implies intent to play from there
        this._playbackEngine.setPlaying(true);
        this._audioBridge.start(this._stateStore.state.currentChapterIndex, index, this._getOptions());
    }

    public jumpToChapter(index: number) {
        const chapters = this._docController.chapters;
        if (index < 0 || index >= chapters.length) { return; }
        this._stateStore.setPreviewing(false);
        this._playbackEngine.setPlaying(true);
        this._audioBridge.start(index, 0, this._getOptions());
    }

    public nextChapter() {
        const state = this._stateStore.state;
        const chapters = this._docController.chapters;
        if (!chapters || chapters.length === 0) { return; }

        const nextIdx = state.currentChapterIndex + 1;
        if (nextIdx < chapters.length) {
            this.jumpToChapter(nextIdx);
        } else {
            this._logger('[READALOUD] Already at the last chapter.');
        }
    }

    public prevChapter() {
        const state = this._stateStore.state;
        const chapters = this._docController.chapters;
        if (!chapters || chapters.length === 0) { return; }

        if (state.currentSentenceIndex > 0) {
            // Restart current chapter
            this.jumpToChapter(state.currentChapterIndex);
        } else if (state.currentChapterIndex > 0) {
            // Jump to previous chapter
            this.jumpToChapter(state.currentChapterIndex - 1);
        } else {
            this._logger('[READALOUD] Already at the first chapter.');
        }
    }

    public prevSentence() {
        this._audioBridge.previous(this._getOptions());
    }

    public nextSentence() {
        this._audioBridge.next(this._getOptions(), true, this._stateStore.state.autoPlayMode);
    }

    private _getOptions(): PlaybackOptions {
        const state = this._stateStore.state;
        return {
            voice: state.selectedVoice || 'en-US-AriaNeural',
            rate: state.rate,
            volume: state.volume,
            mode: state.engineMode
        };
    }

    private _broadcastCacheStats() {
        this._dashboardRelay.postMessage({
            command: 'cacheStats',
            count: this._playbackEngine.getCacheStats().count
        });
    }

    // getFileVersionSalt logic moved to DocumentLoadController
}
