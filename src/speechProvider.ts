import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BridgeServer } from './bridgeServer';
import { Chapter, parseChapters } from './documentParser';
import { PlaybackEngine, PlaybackOptions } from './playbackEngine';

export class SpeechProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _isRefreshing: boolean = false;
    private _bridge?: BridgeServer;

    
    private _extensionUri: vscode.Uri;
    private _extensionPath: string;
    private _chapters: Chapter[] = [];
    private _currentChapterIndex: number = 0;
    private _currentSentenceIndex: number = 0;
    
    // Configuration
    private _autoPlayMode: 'auto' | 'chapter' | 'row' = 'auto';
    private _selectedVoice: string = 'en-US-AriaNeural';
    private _rate: number = 0;
    private _volume: number = 50;
    private _engineMode: 'local' | 'neural' = 'neural';
    
    private _currentFileName: string = 'No Document';
    private _currentRelativeDir: string = '';
    private _currentDocumentUri: vscode.Uri | undefined;
    
    // Selection state (passive)
    private _activeFileName: string = 'No Selection';
    private _activeRelativeDir: string = '';
    private _activeDocumentUri: vscode.Uri | undefined;
    
    private _playbackEngine: PlaybackEngine;
    private _localVoices: any[] = [];
    private _neuralVoices: any[] = [];
    private _statusBarItems: { pause: vscode.StatusBarItem; stop: vscode.StatusBarItem };
    
    private _lastReportedProgress: number = -1;
    

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _logger: (msg: string) => void,
        statusBarItems: { pause: vscode.StatusBarItem; stop: vscode.StatusBarItem },
        public onVisibilityChanged?: () => void,
        bridge?: BridgeServer
    ) {
        this._extensionUri = _context.extensionUri;
        this._extensionPath = _context.extensionPath;
        this._playbackEngine = new PlaybackEngine(_logger, () => this._broadcastCacheStats());
        this._statusBarItems = statusBarItems;
        this._bridge = bridge;

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

    private _currentVersionSalt: string = '';

    private _setupDocumentListeners() {
        // Listen for changes to the active document to update version badges
        vscode.workspace.onDidChangeTextDocument(e => {
            if (this._currentDocumentUri && e.document.uri.toString() === this._currentDocumentUri.toString()) {
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
            this.updateWorkingDocument(document);
        }, 500);
    }


    public setBridge(bridge: BridgeServer) {
        this._logger(`[PROVIDER] Bridge received (Port: ${bridge.port}). Refreshing view...`);
        this._bridge = bridge;
        this.refresh();
    }

    public setActiveEditor(uri: vscode.Uri | undefined) {
        if (uri?.toString() === this._activeDocumentUri?.toString()) {
            return; // Avoid redundant broadcasts
        }

        if (!uri) {
            this._activeFileName = 'No Selection';
            this._activeRelativeDir = '';
            this._activeDocumentUri = undefined;
        } else {
            const fullPath = uri.fsPath;
            this._activeFileName = path.basename(fullPath);
            this._activeDocumentUri = uri;
            
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (workspaceFolder) {
                this._activeRelativeDir = path.dirname(path.relative(workspaceFolder.uri.fsPath, fullPath));
                if (this._activeRelativeDir === '.') {this._activeRelativeDir = '';}
            } else {
                this._activeRelativeDir = path.dirname(fullPath);
            }
        }
        this._logger(`[SYNC] focus:${this._activeFileName}`);
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
                    sanitized[key] = this._compressPath(val);
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
                
                this._logger(`[BRIDGE -> WEBVIEW] ${cmdLabel} ${payloadString}`);
            } catch (e) {
                this._logger(`[BRIDGE] Payload serialization failed (non-critical): ${e}`);
            }
        }
        
        if (this._view && this._view.visible && this._view.webview) {
            this._view.webview.postMessage(msg);
        }
        if (this._bridge) {
            this._bridge.broadcast(msg);
        }
        this._syncStatusBars();
    }

    private _syncStatusBars() {
        const isPlaying = this._playbackEngine.isPlaying;
        const isPaused = this._playbackEngine.isPaused;

        if (isPlaying) {
            this._statusBarItems.pause.show();
            this._statusBarItems.stop.show();
            this._statusBarItems.pause.text = isPaused ? "$(play) Resume" : "$(pause) Pause";
        } else {
            this._statusBarItems.pause.hide();
            this._statusBarItems.stop.hide();
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
        if (this._bridge) {
            this.refresh();
        }
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
        if (!this._view || this._isRefreshing || !this._bridge) {
            return;
        }

        try {
            this._isRefreshing = true;
            const html = this._bridge.getHtml();
            this._logger(`[REFRESH] INJECTING HTML FOR ${this._bridge.port}`);
            this._view.webview.html = html;
        } catch (e) {
            this._logger(`[REFRESH] FAILED TO INJECT HTML: ${e}`);
            setTimeout(() => this.refresh(), 1000);
        } finally {
            this._isRefreshing = false;
        }
    }

    private _getErrorHtml(message: string): string {
        return `
            <html>
            <body style="background:transparent;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:sans-serif;color:#ff4d4d;margin:0;padding:0;overflow:hidden;">
                <div style="padding:20px 30px;background:rgba(40,0,0,0.8);border-radius:12px;border:1px solid rgba(255,0,0,0.2);text-align:center;backdrop-filter:blur(8px);box-shadow: 0 8px 32px rgba(0,0,0,0.5);">
                    <div style="font-size:10px;letter-spacing:3px;margin-bottom:8px;opacity:0.8;font-weight:bold;color:#ffaaaa;">CRITICAL FAILURE</div>
                    <div style="font-size:14px;font-weight:600;color:#ffffff;">ENGINE FAILED TO START</div>
                    <div style="font-size:10px;opacity:0.6;margin-top:8px;font-family:monospace;max-width:240px;word-break:break-all;">${message}</div>
                    <div style="margin-top:16px;font-size:11px;color:#cccccc;">Try restarting VS Code or checking for port conflicts.</div>
                </div>
            </body>
            </html>
        `;
    }

    public refreshView() {
        this._broadcastState();
        this._broadcastVoices();
        
        if (this._chapters.length > 0) {
            this._postToAll({
                command: 'chapters',
                chapters: this._chapters.map((c, i) => ({ 
                    title: c.title, 
                    level: c.level, 
                    index: i,
                    count: c.sentences.length 
                })),
                current: this._currentChapterIndex,
                total: this._chapters.length
            });
        }
    }

    private async _handleWebviewMessage(data: any, source: string) {
        this._logger(`[BRIDGE <- WEBVIEW] Command: ${data.command}`);
        

        switch (data.command) {
            case 'ready':
                this._sendInitialState();
                if (this._chapters.length > 0) {
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
        this._postToAll({
            command: 'initialState',
            activeUri: this._activeDocumentUri?.toString() || '',
            activeFileName: this._activeFileName,
            activeRelativeDir: this._activeRelativeDir,
            readingUri: this._currentDocumentUri?.toString() || '',
            readingFileName: this._currentFileName,
            readingRelativeDir: this._currentRelativeDir,
            currentChapterIndex: this._currentChapterIndex,
            currentSentenceIndex: this._currentSentenceIndex,
            totalChapters: this._chapters.length,
            totalSentences: this._chapters[this._currentChapterIndex]?.sentences.length || 0,
            autoPlayMode: this._autoPlayMode,
            engineMode: this._engineMode,
            rate: this._rate,
            volume: this._volume,
            activeVersion: this._activeDocumentUri ? this._getFileVersionSalt(this._activeDocumentUri.fsPath) : undefined,
            readingVersion: this._currentVersionSalt // Already calculated during load
        });
        this._broadcastState();
    }

    private _broadcastState() {
        this._postToAll({
            command: 'state-sync',
            activeUri: this._activeDocumentUri?.toString() || '',
            activeFileName: this._activeFileName,
            activeRelativeDir: this._activeRelativeDir,
            readingUri: this._currentDocumentUri?.toString() || '',
            readingFileName: this._currentFileName,
            readingRelativeDir: this._currentRelativeDir,
            isPlaying: this._playbackEngine.isPlaying,
            isPaused: this._playbackEngine.isPaused,
            currentChapterIndex: this._currentChapterIndex,
            currentSentenceIndex: this._currentSentenceIndex,
            totalSentences: this._chapters[this._currentChapterIndex]?.sentences.length || 0,
            engineMode: this._engineMode,
            rate: this._rate,
            volume: this._volume,
            // Recalculate salts in real-time to pick up metadata/timestamp changes
            activeVersion: this._activeDocumentUri ? this._getFileVersionSalt(this._activeDocumentUri.fsPath) : undefined,
            readingVersion: this._currentDocumentUri ? this._getFileVersionSalt(this._currentDocumentUri.fsPath) : this._currentVersionSalt,
            bridgeMetadata: this._bridge?.metadata
        });
        
        // Update the internal salt so next playback uses the fresh one
        if (this._currentDocumentUri) {
            this._currentVersionSalt = this._getFileVersionSalt(this._currentDocumentUri.fsPath);
        }
    }

    private _compressPath(rawPath: string): string {
        // Shorten UUIDs: f7b06bbe-3ecb-450d-8db1-486bfbe69dbd -> f7b0...9dbd
        return rawPath.replace(/([0-9a-f]{4})[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8}([0-9a-f]{4})/gi, '$1...$2');
    }

    public updateWorkingDocument(document: vscode.TextDocument) {
        this._currentDocumentUri = document.uri;
        // Robust display name: use path basename, or fall back to URI string if it's a virtual path
        this._currentFileName = path.basename(document.fileName);
        if (this._currentFileName.includes('Untitled')) {
            // Fallback for some artifact views that might use virtual names
            this._currentFileName = document.uri.path.split('/').pop() || document.fileName;
        }

        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const fsPath = document.uri.fsPath;
        let relativeDir = '';

        if (folder) {
            // Regular File in Workspace: [WorkspaceName] / [RelPath]
            const workspaceName = folder.name;
            const relPath = path.relative(folder.uri.fsPath, path.dirname(fsPath));
            relativeDir = workspaceName + (relPath && relPath !== '.' ? ' / ' + relPath.replace(/\\/g, ' / ') : '');
        } else if (fsPath.toLowerCase().includes('.gemini') && fsPath.toLowerCase().includes('brain')) {
            // Artifact in Brain: Brain / [Compressed_Hash] / [Subdirs]
            const brainMatch = fsPath.match(/brain[\\\/]([^\\\/]+)(.*)/i);
            if (brainMatch) {
                const hash = brainMatch[1];
                // Remove filename from the subPath part
                const subPathWithFile = brainMatch[2].replace(/^[\\\/]/, '');
                const subPath = path.dirname(subPathWithFile);
                
                relativeDir = `Brain / ${this._compressPath(hash)}${subPath !== '.' ? ' / ' + subPath.replace(/[\\\/]/g, ' / ') : ''}`;
            } else {
                relativeDir = 'Brain / Artifacts';
            }
        } else {
            // Fallback for virtual storage or external files
            relativeDir = document.uri.scheme === 'file' ? path.dirname(fsPath).split(/[\\\/]/).slice(-2).join(' / ') : 'Virtual Storage';
        }

        this._currentRelativeDir = relativeDir;
        this._currentVersionSalt = this._getFileVersionSalt(document.uri.fsPath);
        
        this._postToAll({
            command: 'documentInfo',
            fileName: this._currentFileName,
            relativeDir: this._currentRelativeDir,
            version: this._currentVersionSalt
        });
    }

    public async loadCurrentDocument(): Promise<boolean> {
        // If there's an active text editor, use its document
        let document = vscode.window.activeTextEditor?.document;
        
        // Fallback: Check the active tab if editor is null or document isn't reachable
        if (!document) {
            const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
            const input = tab?.input as any;
            const uri = input?.uri || input?.resource || (input?.sourceUri && vscode.Uri.parse(input.sourceUri));
            
            if (uri) {
                try {
                    document = await vscode.workspace.openTextDocument(uri);
                } catch (e) {
                    this._logger(`Failed to load document from tab: ${e}`);
                }
            }
        }

        if (!document) {
            this._logger('No active document found to load.');
            this._postToAll({
                command: 'synthesisError',
                error: 'No active document found to read.',
                isFallingBack: false
            });
            return false;
        }

        const text = document.getText();
        this.updateWorkingDocument(document);
        
        const startTime = Date.now();
        this._chapters = parseChapters(text);
        const duration = Date.now() - startTime;
        
        this._logger(`[LOAD] document: ${this._currentFileName} | chapters: ${this._chapters.length} | parsing: ${duration}ms`);
        
        // --- Reset Indices and Stop Playback on Document Change ---
        this._currentChapterIndex = 0;
        this._currentSentenceIndex = 0;
        this._playbackEngine.stop();
        
        this._postToAll({
            command: 'chapters',
            chapters: this._chapters.map((c, i) => ({ 
                title: c.title, 
                level: c.level, 
                index: i,
                count: c.sentences.length 
            })),
            currentChapterIndex: 0,
            totalChapters: this._chapters.length,
            currentSentenceIndex: 0,
            totalSentences: this._chapters[0]?.sentences.length || 0
        });

        if (this._chapters.length > 0) {
            const firstChapter = this._chapters[0];
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
        
        // Ensure state sync after loading
        this._broadcastState();
        
        return true;
    }

    private _resetContext() {
        this.stop();
        this._currentDocumentUri = undefined;
        this._currentFileName = 'No File Loaded';
        this._currentRelativeDir = '';
        this._chapters = [];
        this._currentChapterIndex = 0;
        this._currentSentenceIndex = 0;
        
        this._postToAll({
            command: 'chapters',
            chapters: [],
            current: 0,
            total: 0
        });

        this._broadcastState();
        this._logger('[BRIDGE] Context Reset: Reader cleared.');
    }

    public play(text: string, startFromChapter: number = 0, fileName?: string) {
        if (fileName) {
            this._currentDocumentUri = vscode.Uri.file(fileName);
            this._currentFileName = path.basename(fileName);
            const folder = vscode.workspace.getWorkspaceFolder(this._currentDocumentUri);
            this._currentRelativeDir = folder ? path.relative(folder.uri.fsPath, path.dirname(fileName)) : '';
        }
        
        // --- FIXED: Reset sentence index to 0 when moving to a new file/start point ---
        this._currentChapterIndex = startFromChapter;
        this._currentSentenceIndex = 0;
        
        this._chapters = parseChapters(text);
        this._postToAll({
            command: 'chapters',
            chapters: this._chapters.map((c, i) => ({ 
                title: c.title, 
                level: c.level, 
                index: i,
                count: c.sentences.length
            })),
            current: startFromChapter,
            total: this._chapters.length
        });

        this._playbackEngine.setPlaying(true);
        this._playChapter(startFromChapter, 0);
    }

    public pause() {
        this._playbackEngine.setPaused(true);
        this._postToAll({ command: 'playbackStateChanged', state: 'paused' });
    }

    public stop() {
        this._playbackEngine.stop();
        this._currentChapterIndex = 0;
        this._currentSentenceIndex = 0;
        this._postToAll({ command: 'stop' });
        this._logger('[STOP] playback_stop');
    }

    public continue() {
        // FIXED: Explicitly set isPlaying to true and clear pause
        this._playbackEngine.setPlaying(true);
        this._playbackEngine.setPaused(false);
        this._postToAll({ command: 'playbackStateChanged', state: 'playing' });
        this._playChapter(this._currentChapterIndex, this._currentSentenceIndex);
    }

    public startOver() {
        this.jumpToSentence(0);
    }

    public jumpToSentence(index: number) {
        this._playbackEngine.setPlaying(true);
        this._playChapter(this._currentChapterIndex, index);
    }

    public jumpToChapter(index: number) {
        if (index < 0 || index >= this._chapters.length) {return;}
        this._playbackEngine.setPlaying(true);
        this._playChapter(index, 0);
    }

    public nextChapter() {
        this.jumpToChapter(this._currentChapterIndex + 1);
    }

    public prevChapter() {
        this.jumpToChapter(this._currentChapterIndex - 1);
    }

    public prevSentence() {
        if (this._currentSentenceIndex > 0) {
            this.jumpToSentence(this._currentSentenceIndex - 1);
        } else if (this._currentChapterIndex > 0) {
            const prevChap = this._chapters[this._currentChapterIndex - 1];
            this._playChapter(this._currentChapterIndex - 1, prevChap.sentences.length - 1);
        }
    }

    public nextSentence() {
        const chapter = this._chapters[this._currentChapterIndex];
        if (this._currentSentenceIndex + 1 < chapter.sentences.length) {
            this.jumpToSentence(this._currentSentenceIndex + 1);
        } else {
            this.nextChapter();
        }
    }

    private _playChapter(chapterIndex: number, sentenceIndex: number = 0) {
        if (chapterIndex < 0 || chapterIndex >= this._chapters.length) {return;}
        
        this._currentChapterIndex = chapterIndex;
        this._currentSentenceIndex = sentenceIndex;
        
        const chapter = this._chapters[chapterIndex];

        if (sentenceIndex === 0) {
            this._postToAll({
                command: 'chapterChanged',
                index: chapterIndex,
                total: this._chapters.length,
                title: chapter.title
            });
        }

        if (!chapter.sentences || chapter.sentences.length === 0) {
            this._moveNext();
            return;
        }

        const sentence = chapter.sentences[sentenceIndex];

        // --- NEW: File-Unique Cache Key with Version Salt ---
        const docId = this._currentDocumentUri?.toString() || this._currentFileName;
        const saltStr = this._currentVersionSalt ? `-${this._currentVersionSalt}` : '';
        const cacheKey = `${docId}${saltStr}-${chapterIndex}-${sentenceIndex}`;

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
                if (data && this._playbackEngine.isPlaying) {
                    this._postToAll({
                        command: 'playAudio',
                        data: data,
                        text: sentence,
                        sentenceIndex: sentenceIndex,
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
            // Pre-fetch
            this._triggerPreFetch(chapterIndex, sentenceIndex + 1, options);
        } else {
            this._playbackEngine.speakLocal(sentence, options, (code: number | null) => {
                this._onLocalExit(code);
            });
        }
    }


    private _triggerPreFetch(chapterIndex: number, sentenceIndex: number, options: PlaybackOptions) {
        setTimeout(() => {
            let count = 0;
            let cIdx = chapterIndex;
            let sIdx = sentenceIndex;

            // Prefetch a window of 5 sentences
            while (count < 5) {
                const chapter = this._chapters[cIdx];
                if (!chapter) {break;}

                if (sIdx < chapter.sentences.length) {
                    const text = chapter.sentences[sIdx];
                    const docId = this._currentDocumentUri?.toString() || this._currentFileName;
                    const saltStr = this._currentVersionSalt ? `-${this._currentVersionSalt}` : '';
                    const cacheKey = `${docId}${saltStr}-${cIdx}-${sIdx}`;
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
        if (this._currentSentenceIndex > 0) {
            this._playChapter(this._currentChapterIndex, this._currentSentenceIndex - 1);
        } else if (this._currentChapterIndex > 0) {
            const prevChapterIdx = this._currentChapterIndex - 1;
            const prevChapter = this._chapters[prevChapterIdx];
            // Start from the last sentence of the previous chapter
            this._playChapter(prevChapterIdx, prevChapter.sentences.length - 1);
        } else {
            this._logger('[BRIDGE] Start of document reached.');
        }
    }

    private _moveNext(manual: boolean = false) {
        if (manual) {
            this._advanceNormally();
            return;
        }

        switch (this._autoPlayMode) {
            case 'row':
                this.stop();
                break;
            case 'chapter':
                const chapter = this._chapters[this._currentChapterIndex];
                if (this._currentSentenceIndex + 1 < chapter.sentences.length) {
                    this._playChapter(this._currentChapterIndex, this._currentSentenceIndex + 1);
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
        const chapter = this._chapters[this._currentChapterIndex];
        if (this._currentSentenceIndex + 1 < chapter.sentences.length) {
            this._playChapter(this._currentChapterIndex, this._currentSentenceIndex + 1);
        } else {
            this.jumpToChapter(this._currentChapterIndex + 1);
        }
    }

    private _getFileVersionSalt(fsPath: string): string {
        // 1. Explicit Suffix (.resolved.N)
        const suffixMatch = fsPath.match(/\.resolved\.(\d+)$/i);
        if (suffixMatch) {
            return `V${suffixMatch[1]}`;
        }

        // 2. Metadata File (Brain managed)
        try {
            const metaPath = fsPath + '.metadata.json';
            if (fs.existsSync(metaPath)) {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                if (meta.version) {
                    return `V${meta.version}`;
                }
            }
        } catch (e) {}

        // 3. Passive Mtime (Temporal Salt for regular files)
        try {
            if (fs.existsSync(fsPath)) {
                const stats = fs.statSync(fsPath);
                return `T${Math.floor(stats.mtimeMs)}`;
            }
        } catch (e) {}

        return '';
    }
}
