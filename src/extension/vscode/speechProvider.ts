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

export class SpeechProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _extensionPath: string;

    // Configuration
    private _autoPlayMode: 'auto' | 'chapter' | 'row' = 'auto';
    private _selectedVoice: string = 'en-US-AriaNeural';
    private _rate: number = 0;
    private _volume: number = 50;
    private _engineMode: 'local' | 'neural' = 'neural';

    private _docController: DocumentLoadController;
    private _sequenceManager: SequenceManager;
    private _stateStore: StateStore;
    private _audioBridge: AudioBridge;
    private _dashboardRelay: DashboardRelay;
    
    // Selection state (passive) - Moved to StateStore
    
    private _playbackEngine: PlaybackEngine;
    private _localVoices: any[] = [];
    private _neuralVoices: any[] = [];
    private _statusBarItem: vscode.StatusBarItem;
    
    private _lastReportedProgress: number = -1;
    

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

        // Load Persisted Settings
        this._rate = this._context.globalState.get<number>('readAloud.rate', 0);
        this._volume = this._context.globalState.get<number>('readAloud.volume', 50);
        this._selectedVoice = this._context.globalState.get<string>('readAloud.voice', 'en-US-AriaNeural');

        // Initial setup of document context listeners
        this._setupDocumentListeners();

        // Tier-3: High-Density Log Format (Extension Boot)
        this._logger('[BOOT] extension_activated');
        this._loadVoices();

        // [Reactive Sync] Subscribe to StateStore changes
        this._stateStore.on('change', () => this._syncUI());
        this._playbackEngine.on('status', () => this._syncUI());
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




    public setActiveEditor(uri: vscode.Uri | undefined) {
        if (uri?.toString() === this._stateStore.state.activeDocumentUri?.toString()) {
            return; // Avoid redundant broadcasts
        }

        if (!uri) {
            this._stateStore.reset();
        } else {
            const fullPath = uri.fsPath;
            const fileName = path.basename(fullPath);
            let relativeDir = '';
            
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (workspaceFolder) {
                relativeDir = path.dirname(path.relative(workspaceFolder.uri.fsPath, fullPath));
                if (relativeDir === '.') {relativeDir = '';}
            } else {
                relativeDir = path.dirname(fullPath);
            }
            this._stateStore.setSelection(uri, fileName, relativeDir);
        }
        this._logger(`[SYNC] focus:${this._stateStore.state.activeFileName}`);
        // [REFAC] Manual _broadcastState() call will eventually be redundant 
        // since setSelection() now triggers 'change' -> _syncUI()
    }

    private async _loadVoices() {
        try {
            const { local, neural } = await this._playbackEngine.getVoices();
            this._localVoices = local;
            this._neuralVoices = neural;
            this._logger(`Detected ${this._localVoices.length} local SAPI voices and ${this._neuralVoices.length} neural voices.`);
            this._broadcastVoices();
        } catch (e) {
            this._logger(`VOICE SCAN ERROR: ${e}`);
        }
    }

    private _broadcastVoices() {
        this._dashboardRelay.broadcastVoices(this._localVoices, this._neuralVoices, this._engineMode);
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
        this._dashboardRelay.sync(
            this._autoPlayMode, 
            this._engineMode,
            this._selectedVoice,
            this._rate,
            this._volume,
            this._localVoices,
            this._neuralVoices
        );
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
                this._logger('[VISIBILITY] Sidebar revealed. Triggering sync...');
                if (this.onVisibilityChanged) {
                    this.onVisibilityChanged();
                }
                this._sendInitialState();
                this._broadcastVoices();
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
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'dashboard.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'style.css'));
        
        const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'speechEngine.html');
        let html = fs.readFileSync(htmlPath.fsPath, 'utf8');

        // Inject URIs
        html = html.replace('${inlineStyle}', '') // Remove old injection point
                   .replace('${inlineScript}', '') // Remove old injection point
                   .replace('</head>', `<link rel="stylesheet" href="${styleUri}">\n</head>`)
                   .replace('</body>', `<script src="${scriptUri}"></script>\n</body>`);

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

    private async _handleWebviewMessage(data: any, source: string) {
        this._logger(`[READALOUD <- WEBVIEW] Command: ${data.command}`);
        

        switch (data.command) {
            case 'ready':
                this._sendInitialState();
                if (this._docController.chapters.length > 0) {
                    this.refreshView();
                }
                break;
            case 'jumpToChapter':
                this.jumpToChapter(data.index);
                break;
            case 'nextChapter':
                this.nextChapter();
                break;
            case 'prevChapter':
                this.prevChapter();
                break;

            case 'setAutoPlayMode':
                this._autoPlayMode = data.mode;
                break;
            case 'toggleAutoPlay':
                // Backward compatibility for old calls if any
                this._autoPlayMode = data.enabled ? 'auto' : 'row';
                break;
            case 'voiceChanged':
                this._selectedVoice = data.voice;
                this._context.globalState.update('readAloud.voice', data.voice);
                this._logger(`[VOICE] ${data.voice} | SURGICAL_PREVIEW`);
                // Stop any current full playback but trigger a single-sentence preview synth
                this._playbackEngine.stop();
                this._audioBridge.start(this._stateStore.state.currentChapterIndex, this._stateStore.state.currentSentenceIndex, this._getOptions(), true);
                break;
            case 'rateChanged':
                this._rate = data.rate;
                this._context.globalState.update('readAloud.rate', data.rate);
                break;
            case 'volumeChanged':
                this._volume = data.volume;
                this._context.globalState.update('readAloud.volume', data.volume);
                break;
            case 'engineModeChanged':
                this._engineMode = data.mode;
                this._playbackEngine.stop();
                this._broadcastVoices();
                this._broadcastCacheStats();
                break;

            case 'sentenceEnded':
                if (!this._playbackEngine.isPaused) {
                    this._audioBridge.next(this._getOptions(), false, this._autoPlayMode);
                }
                break;
            case 'nextSentence': 
                this._audioBridge.next(this._getOptions(), true, this._autoPlayMode); 
                break;
            case 'prevSentence':
                this._audioBridge.previous(this._getOptions());
                break;
            case 'jumpToSentence': this.jumpToSentence(data.index); break;
            case 'continue': this.continue(); break;
            case 'loadAndPlay': 
                const loaded = await this.loadCurrentDocument();
                if (loaded) {
                    this.continue();
                }
                break;
            case 'resetContext': this._resetContext(); break;
            case 'stop': this.stop(); break;
            case 'pause': this.pause(); break;
            case 'loadDocument': this.loadCurrentDocument(); break;
            case 'log': this._logger(`[${source.toUpperCase()}] ${data.message}`); break;
        }
    }

    private _sendInitialState() {
        this._syncUI();
        this._broadcastVoices();
    }


    public async loadCurrentDocument(): Promise<boolean> {
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

        this._postToAll({
            command: 'documentInfo',
            fileName: metadata.fileName,
            relativeDir: metadata.relativeDir,
            version: metadata.versionSalt
        });

        // Reset Indices and Stop Playback on Document Change
        this._stateStore.setProgress(0, 0);
        this._playbackEngine.stop();
        
        this._postToAll({
            command: 'chapters',
            chapters: chapters.map((c: Chapter, i: number) => ({ 
                title: c.title, 
                level: c.level, 
                index: i,
                count: c.sentences.length 
            })),
            currentChapterIndex: 0,
            totalChapters: chapters.length,
            currentSentenceIndex: 0,
            totalSentences: chapters[0]?.sentences.length || 0
        });

        if (chapters.length > 0) {
            const firstChapter = chapters[0];
            this._postToAll({
                command: 'sentenceChanged',
                text: firstChapter.sentences[0],
                chapterIndex: 0,
                sentenceIndex: 0,
                totalSentences: firstChapter.sentences.length,
                sentences: firstChapter.sentences,
                suppressButtonToggle: true
            });
        }
        
        this._syncUI();
        return true;
    }

    private _resetContext() {
        this._audioBridge.stop();
        this._docController.clear();
        this._stateStore.reset();
        
        this._postToAll({
            command: 'chapters',
            chapters: [],
            current: 0,
            total: 0
        });

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
        this._postToAll({ command: 'playbackStateChanged', state: 'paused' });
    }

    public stop() {
        this._audioBridge.stop();
        this._postToAll({ command: 'stop' });
        this._logger('[STOP] playback_stop');
    }

    public continue() {
        this._stateStore.setPreviewing(false); // Commit to full playback
        this._playbackEngine.setPlaying(true);
        this._playbackEngine.setPaused(false);
        this._postToAll({ command: 'playbackStateChanged', state: 'playing' });
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
        if (index < 0 || index >= chapters.length) {return;}
        this._stateStore.setPreviewing(false);
        this._playbackEngine.setPlaying(true);
        this._audioBridge.start(index, 0, this._getOptions());
    }

    public nextChapter() {
        this._audioBridge.next(this._getOptions(), true, this._autoPlayMode);
    }

    public prevChapter() {
        this._audioBridge.previous(this._getOptions());
    }

    public prevSentence() {
        this._audioBridge.previous(this._getOptions());
    }

    public nextSentence() {
        this._audioBridge.next(this._getOptions(), true, this._autoPlayMode);
    }

    private _getOptions(): PlaybackOptions {
        return {
            voice: this._selectedVoice,
            rate: this._rate,
            volume: this._volume,
            mode: this._engineMode
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
