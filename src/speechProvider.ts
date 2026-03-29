import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Chapter } from './documentParser';
import { DocumentLoadController } from './documentLoadController';
import { StateStore } from './stateStore';
import { PlaybackEngine, PlaybackOptions } from './playbackEngine';

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
    private _stateStore: StateStore;
    
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
        this._stateStore = new StateStore(this._logger);
        this._playbackEngine = new PlaybackEngine(_logger, () => this._broadcastCacheStats());
        this._statusBarItem = statusBarItem;

        // Load Persisted Settings
        this._rate = this._context.globalState.get<number>('readAloud.rate', 0);
        this._volume = this._context.globalState.get<number>('readAloud.volume', 50);
        this._selectedVoice = this._context.globalState.get<string>('readAloud.voice', 'en-US-AriaNeural');

        // Initial setup of document context listeners
        this._setupDocumentListeners();

        // Tier-3: High-Density Log Format (Extension Boot)
        this._logger('[BOOT] extension_activated');
        this._loadVoices();
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
        this._broadcastState();
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
        this._postToAll({ 
            command: 'voices', 
            voices: this._localVoices, 
            neuralVoices: this._neuralVoices,
            engineMode: this._engineMode
        });
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

    private _postToAll(msg: any) {
        const cmd = msg.command;
        // SILENCE: High-frequency synchronization heartbeats
        if (cmd !== 'state-sync' && cmd !== 'cacheStatus' && cmd !== 'progress') {
            try {
                const logPayload = this._getSanitizedPayload(msg);
                const cmdLabel = `[${cmd.toUpperCase()}]`;
                
                // Tier-3: Compact High-Density Log Format
                const payloadString = Object.entries(logPayload)
                    .filter(([k]) => k !== 'command')
                    .map(([k, v]) => {
                        const valStr = typeof v === 'string' ? v : JSON.stringify(v);
                        return `${k}:${valStr}`;
                    })
                    .join(' | ');
                
                this._logger(`[READALOUD -> WEBVIEW] ${cmdLabel} ${payloadString}`);
            } catch (e) {
                this._logger(`[READALOUD] Payload serialization failed (non-critical): ${e}`);
            }
        }
        
        if (this._view) {
            this._view.webview.postMessage(msg);
        }
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
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._logger('--- ACTIVATING MISSION CONTROL (Sidebar) ---');
        this._view = webviewView;

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
        this._broadcastState();
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
                this._playChapter(this._stateStore.state.currentChapterIndex, this._stateStore.state.currentSentenceIndex, true);
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
                    this._moveNext();
                }
                break;
            case 'nextSentence': 
                this._moveNext(true); 
                break;
            case 'prevSentence':
                this._movePrev();
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
        const metadata = this._docController.metadata;
        this._postToAll({
            command: 'initialState',
            activeUri: this._stateStore.state.activeDocumentUri?.toString() || '',
            activeFileName: this._stateStore.state.activeFileName,
            activeRelativeDir: this._stateStore.state.activeRelativeDir,
            readingUri: metadata.uri?.toString() || '',
            readingFileName: metadata.fileName,
            readingRelativeDir: metadata.relativeDir,
            currentChapterIndex: this._stateStore.state.currentChapterIndex,
            currentSentenceIndex: this._stateStore.state.currentSentenceIndex,
            totalChapters: this._docController.chapters.length,
            totalSentences: this._docController.chapters[this._stateStore.state.currentChapterIndex]?.sentences.length || 0,
            autoPlayMode: this._autoPlayMode,
            engineMode: this._engineMode,
            rate: this._rate,
            volume: this._volume,
            activeVersion: this._stateStore.state.activeDocumentUri ? this._docController.getFileVersionSalt(this._stateStore.state.activeDocumentUri) : undefined,
            readingVersion: metadata.versionSalt
        });
        this._broadcastState();
    }

    private _broadcastState() {
        const metadata = this._docController.metadata;
        this._postToAll({
            command: 'state-sync',
            activeUri: this._stateStore.state.activeDocumentUri?.toString() || '',
            activeFileName: this._stateStore.state.activeFileName,
            activeRelativeDir: this._stateStore.state.activeRelativeDir,
            readingUri: metadata.uri?.toString() || '',
            readingFileName: metadata.fileName,
            readingRelativeDir: metadata.relativeDir,
            isPlaying: this._playbackEngine.isPlaying,
            isPaused: this._playbackEngine.isPaused,
            currentChapterIndex: this._stateStore.state.currentChapterIndex,
            currentSentenceIndex: this._stateStore.state.currentSentenceIndex,
            totalSentences: this._docController.chapters[this._stateStore.state.currentChapterIndex]?.sentences.length || 0,
            engineMode: this._engineMode,
            rate: this._rate,
            volume: this._volume,
            activeVersion: this._stateStore.state.activeDocumentUri ? this._docController.getFileVersionSalt(this._stateStore.state.activeDocumentUri) : undefined,
            readingVersion: metadata.uri ? this._docController.getFileVersionSalt(metadata.uri) : metadata.versionSalt,
        });
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
        
        this._broadcastState();
        return true;
    }

    private _resetContext() {
        this.stop();
        this._docController.clear();
        this._stateStore.reset();
        
        this._postToAll({
            command: 'chapters',
            chapters: [],
            current: 0,
            total: 0
        });

        this._broadcastState();
        this._logger('[READALOUD] Context Reset: Reader cleared.');
    }

    public play(text: string, startFromChapter: number = 0, fileName?: string) {
        this._stateStore.setProgress(startFromChapter, 0);
        
        this._playbackEngine.setPlaying(true);
        this._playChapter(startFromChapter, 0);
    }

    public pause() {
        this._playbackEngine.setPaused(true);
        this._postToAll({ command: 'playbackStateChanged', state: 'paused' });
    }

    public stop() {
        this._playbackEngine.stop();
        this._stateStore.setProgress(0, 0);
        this._postToAll({ command: 'stop' });
        this._logger('[STOP] playback_stop');
    }

    public continue() {
        this._stateStore.setPreviewing(false); // Commit to full playback
        this._playbackEngine.setPlaying(true);
        this._playbackEngine.setPaused(false);
        this._postToAll({ command: 'playbackStateChanged', state: 'playing' });
        this._playChapter(this._stateStore.state.currentChapterIndex, this._stateStore.state.currentSentenceIndex);
    }

    public startOver() {
        this.jumpToSentence(0);
    }

    public jumpToSentence(index: number) {
        this._stateStore.setPreviewing(false); // Navigation often implies intent to play from there
        this._playbackEngine.setPlaying(true);
        this._playChapter(this._stateStore.state.currentChapterIndex, index);
    }

    public jumpToChapter(index: number) {
        const chapters = this._docController.chapters;
        if (index < 0 || index >= chapters.length) {return;}
        this._stateStore.setPreviewing(false);
        this._playbackEngine.setPlaying(true);
        this._playChapter(index, 0);
    }

    public nextChapter() {
        this.jumpToChapter(this._stateStore.state.currentChapterIndex + 1);
    }

    public prevChapter() {
        this.jumpToChapter(this._stateStore.state.currentChapterIndex - 1);
    }

    public prevSentence() {
        const chapters = this._docController.chapters;
        if (this._stateStore.state.currentSentenceIndex > 0) {
            this.jumpToSentence(this._stateStore.state.currentSentenceIndex - 1);
        } else if (this._stateStore.state.currentChapterIndex > 0) {
            const prevChap = chapters[this._stateStore.state.currentChapterIndex - 1];
            this._playChapter(this._stateStore.state.currentChapterIndex - 1, prevChap.sentences.length - 1);
        }
    }

    public nextSentence() {
        const chapter = this._docController.chapters[this._stateStore.state.currentChapterIndex];
        if (this._stateStore.state.currentSentenceIndex + 1 < chapter.sentences.length) {
            this.jumpToSentence(this._stateStore.state.currentSentenceIndex + 1);
        } else {
            this.nextChapter();
        }
    }

    private _playChapter(chapterIndex: number, sentenceIndex: number = 0, previewOnly: boolean = false) {
        const chapters = this._docController.chapters;
        if (chapterIndex < 0 || chapterIndex >= chapters.length) {return;}
        
        this._stateStore.setProgress(chapterIndex, sentenceIndex);
        this._stateStore.setPreviewing(previewOnly);
        
        const chapter = chapters[chapterIndex];

        if (sentenceIndex === 0) {
            this._postToAll({
                command: 'chapterChanged',
                index: chapterIndex,
                total: chapters.length,
                totalSentences: chapter.sentences.length,
                title: chapter.title
            });
        }

        if (!chapter.sentences || chapter.sentences.length === 0) {
            this._moveNext();
            return;
        }

        const sentence = chapter.sentences[sentenceIndex];

        const metadata = this._docController.metadata;
        const docId = metadata.uri?.toString() || metadata.fileName;
        const saltStr = metadata.versionSalt ? `-${metadata.versionSalt}` : '';
        const cacheKey = `${this._selectedVoice}-${docId}${saltStr}-${chapterIndex}-${sentenceIndex}`;

        this._logger(`[NEURAL] CACHE KEY: ${cacheKey}`);

        this._postToAll({
            command: 'sentenceChanged',
            text: sentence,
            chapterIndex: chapterIndex,
            sentenceIndex: sentenceIndex,
            totalSentences: chapter.sentences.length,
            sentences: chapter.sentences
        });

        const options: PlaybackOptions = {
            voice: this._selectedVoice,
            rate: this._rate,
            volume: this._volume,
            mode: this._engineMode
        };

        if (this._engineMode === 'neural') {
            this._playbackEngine.speakNeural(sentence, cacheKey, options).then(data => {
                // Send to webview if we are either playing or just previewing the new voice
                if (data && (this._playbackEngine.isPlaying || this._stateStore.state.isPreviewing)) {
                    this._postToAll({
                        command: 'playAudio',
                        data: data,
                        text: sentence,
                        chapterIndex: chapterIndex,
                        sentenceIndex: sentenceIndex,
                        totalSentences: chapter.sentences.length,
                        sentences: chapter.sentences
                    });
                }
            }).catch(err => {
                
                // --- IGNORE Abort Error (from stop or jump) ---
                const errorMessage = err?.message || String(err);
                if (errorMessage.includes('Abort') || errorMessage.includes('Cancel')) {
                    this._logger(`[NEURAL] Synthesis cancelled: ${errorMessage}`);
                    return;
                }

                // --- Verify engine is still active before fallback ---
                if (!this._playbackEngine.isPlaying) {
                    this._logger('[GUARD] Synthesis failed, but engine is stopped. Ignoring fallback.');
                    return;
                }

                this._logger(`[ERR] Neural synthesis failed: ${errorMessage}. Falling back to SAPI.`);

                this._postToAll({
                    command: 'synthesisError',
                    error: errorMessage,
                    isFallingBack: true
                });
                this._postToAll({
                    command: 'engineStatus',
                    status: 'local-fallback'
                });
                this._playbackEngine.speakLocal(sentence, options, (code: number | null) => this._onLocalExit(code));
            });
            // In Preview Mode, we STOP here and don't trigger pre-fetch
            if (!this._stateStore.state.isPreviewing) {
                this._triggerPreFetch(chapterIndex, sentenceIndex + 1, options);
            }
        } else {
            this._playbackEngine.speakLocal(sentence, options, (code: number | null) => {
                this._onLocalExit(code);
            });
        }
    }


    private _triggerPreFetch(chapterIndex: number, sentenceIndex: number, options: PlaybackOptions) {
        if (!this._playbackEngine.isPlaying || this._stateStore.state.isPreviewing) {
            return;
        }
        setTimeout(() => {
            let count = 0;
            let cIdx = chapterIndex;
            let sIdx = sentenceIndex;

            // Prefetch a window of 5 sentences
            while (count < 5) {
                const chapter = this._docController.chapters[cIdx];
                if (!chapter) {break;}

                if (sIdx < chapter.sentences.length) {
                    const text = chapter.sentences[sIdx];
                    const metadata = this._docController.metadata;
                    const docId = metadata.uri?.toString() || metadata.fileName;
                    const saltStr = metadata.versionSalt ? `-${metadata.versionSalt}` : '';
                    const cacheKey = `${this._selectedVoice}-${docId}${saltStr}-${cIdx}-${sIdx}`;
                    this._playbackEngine.triggerPrefetch(text, cacheKey, options);
                    sIdx++;
                    count++;
                } else {
                    // Move to next chapter
                    cIdx++;
                    sIdx = 0;
                    if (this._autoPlayMode !== 'auto') {break;} 
                }
            }
        }, 300);
    }




    private _onLocalExit(code: number | null) {
        if (code === 0 && !this._playbackEngine.isPaused && this._playbackEngine.isPlaying) {
            this._moveNext();
        }
    }

    private _broadcastCacheStats() {
        const stats = this._playbackEngine.getCacheStats();
        this._postToAll({
            command: 'cacheStatus',
            ...stats
        });
    }

    private _movePrev() {
        const chapters = this._docController.chapters;
        if (this._stateStore.state.currentSentenceIndex > 0) {
            this._playChapter(this._stateStore.state.currentChapterIndex, this._stateStore.state.currentSentenceIndex - 1);
        } else if (this._stateStore.state.currentChapterIndex > 0) {
            const prevChapterIdx = this._stateStore.state.currentChapterIndex - 1;
            const prevChapter = chapters[prevChapterIdx];
            // Start from the last sentence of the previous chapter
            this._playChapter(prevChapterIdx, prevChapter.sentences.length - 1);
        } else {
            this._logger('[READALOUD] Start of document reached.');
        }
    }

    private _moveNext(manual: boolean = false) {
        if (this._stateStore.state.isPreviewing) {
            this._stateStore.setPreviewing(false);
            this._logger(`[VOICE] Preview finished. Waiting for user Play.`);
            return;
        }

        if (manual) {
            this._advanceNormally();
            return;
        }

        switch (this._autoPlayMode) {
            case 'row':
                this.stop();
                break;
            case 'chapter':
                const chapters = this._docController.chapters;
                const chapter = chapters[this._stateStore.state.currentChapterIndex];
                if (this._stateStore.state.currentSentenceIndex + 1 < chapter.sentences.length) {
                    this._playChapter(this._stateStore.state.currentChapterIndex, this._stateStore.state.currentSentenceIndex + 1);
                } else {
                    this.stop();
                }
                break;
            case 'auto':
            default:
                this._advanceNormally();
                break;
        }
    }

    private _advanceNormally() {
        const chapters = this._docController.chapters;
        const chapter = chapters[this._stateStore.state.currentChapterIndex];
        if (this._stateStore.state.currentSentenceIndex + 1 < chapter.sentences.length) {
            this._playChapter(this._stateStore.state.currentChapterIndex, this._stateStore.state.currentSentenceIndex + 1);
        } else {
            this.jumpToChapter(this._stateStore.state.currentChapterIndex + 1);
        }
    }

    // getFileVersionSalt logic moved to DocumentLoadController
}
