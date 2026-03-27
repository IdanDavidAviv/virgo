import * as vscode from 'vscode';
import * as path from 'path';
import { BridgeServer } from './bridgeServer';
import { MissionControlPanel } from './missionControl';
import { Chapter, parseChapters } from './documentParser';
import { PlaybackEngine, PlaybackOptions } from './playbackEngine';

export class SpeechProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _panel?: vscode.WebviewPanel;
    private _isReady: boolean = false;
    private _isPanelReady: boolean = false;
    private _isRefreshing: boolean = false;
    private _bridge?: BridgeServer;
    
    private _chapters: Chapter[] = [];
    private _currentChapterIndex: number = 0;
    private _currentSentenceIndex: number = 0;
    
    // Configuration
    private _autoAdvance: boolean = true;
    private _selectedVoice: string = 'en-US-AriaNeural';
    private _rate: number = 0;
    private _volume: number = 100;
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
        private readonly _extensionUri: vscode.Uri,
        private readonly _extensionPath: string,
        private readonly _logger: (msg: string) => void,
        statusBarItems: { pause: vscode.StatusBarItem; stop: vscode.StatusBarItem }
    ) {
        this._playbackEngine = new PlaybackEngine(_logger, () => this._broadcastCacheStats());
        this._statusBarItems = statusBarItems;

        this._loadVoices();
    }

    public setBridge(bridge: BridgeServer) {
        this._bridge = bridge;
        this._logger('Bridge attached to SpeechProvider. Refreshing view...');
        this.refresh();
    }

    public setActiveEditor(uri: vscode.Uri | undefined) {
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
                if (this._activeRelativeDir === '.') this._activeRelativeDir = '';
            } else {
                this._activeRelativeDir = path.dirname(fullPath);
            }
        }
        this._logger(`ACTIVE SELECTION UPDATED: ${this._activeFileName}`);
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

    private _postToAll(msg: any) {
        this._logger(`[BRIDGE -> WEBVIEW] Command: ${msg.command} | Data length: ${msg.data ? msg.data.length : 'N/A'}`);
        if (this._view && this._view.visible && this._isReady) {
            this._view.webview.postMessage(msg);
        }
        if (this._panel && this._panel.visible && this._isPanelReady) {
            this._panel.webview.postMessage(msg);
        }
        if (this._bridge) {
            this._bridge.broadcast(msg);
        }
        if (MissionControlPanel.currentPanel) {
            MissionControlPanel.currentPanel.postMessage(msg);
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
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
        };

        webviewView.webview.onDidReceiveMessage(data => {
            if (data.command === 'ready') {
                this._isReady = true;
                this._sendInitialState();
                this._broadcastVoices();
                return;
            }
            this._handleWebviewMessage(data, 'sidebar');
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._broadcastVoices();
            }
        });

        webviewView.webview.html = `<!DOCTYPE html><html><body style="background:transparent;color:#888;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;">Initializing Handshake...</body></html>`;
        setTimeout(() => this.refresh(), 500);
    }

    public async refresh() {
        if (!this._view || this._isRefreshing || !this._bridge) return;
        this._isRefreshing = true;
        try {
            this._view.webview.html = this._bridge.getHtml(this._view.webview, {});
        } catch (e) {
            this._logger(`Webview refresh failed: ${e}. Retrying...`);
            setTimeout(() => this.refresh(), 1000);
        } finally {
            this._isRefreshing = false;
        }
    }

    public refreshView() {
        this._broadcastState();
        this._broadcastVoices();
        
        if (this._chapters.length > 0) {
            this._postToAll({
                command: 'chapters',
                chapters: this._chapters.map((c, i) => ({ title: c.title, level: c.level, index: i })),
                current: this._currentChapterIndex,
                total: this._chapters.length
            });
        }
    }

    private async _handleWebviewMessage(data: any, source: string) {
        this._logger(`[BRIDGE <- WEBVIEW] Command: ${data.command}`);
        
        // --- NEW: Self-Hydrating UI (Play Intent Interceptor) ---
        // If the user intends to play/navigate but nothing is loaded, auto-load the active file.
        const playIntents = ['continue', 'nextChapter', 'prevChapter', 'prevSentence', 'nextSentence', 'jumpToSentence', 'jumpToChapter'];
        if (playIntents.includes(data.command) && this._chapters.length === 0) {
            this._logger(`[BRIDGE] Auto-hydrating engine state for command: ${data.command}`);
            const loaded = await this.loadCurrentDocument();
            if (!loaded) {
                this._logger(`[BRIDGE] Auto-hydration failed. Aborting command.`);
                return;
            }
        }

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

            case 'toggleAutoPlay':
                this._autoAdvance = data.enabled;
                break;
            case 'voiceChanged':
                this._selectedVoice = data.voice;
                break;
            case 'rateChanged':
                this._rate = data.rate;
                break;
            case 'volumeChanged':
                this._volume = data.volume;
                break;
            case 'engineModeChanged':
                this._engineMode = data.mode;
                this._playbackEngine.stop();
                this._broadcastVoices();
                break;

            case 'sentenceEnded':
                if (!this._playbackEngine.isPaused) {
                    this._moveNext();
                }
                break;
            case 'nextSentence': this.nextSentence(); break;
            case 'jumpToSentence': this.jumpToSentence(data.index); break;
            case 'continue': this.continue(); break;
            case 'stop': this.stop(); break;
            case 'pause': this.pause(); break;
            case 'loadDocument': this.loadCurrentDocument(); break;
            case 'log': this._logger(`[${source.toUpperCase()}] ${data.message}`); break;
        }
    }

    private _sendInitialState() {
        this._postToAll({
            command: 'initialState',
            voice: this._selectedVoice,
            rate: this._rate,
            volume: this._volume,
            autoPlay: this._autoAdvance,
            engineMode: this._engineMode
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
            currentSentenceIndex: this._currentSentenceIndex
        });
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
        
        this._postToAll({
            command: 'documentInfo',
            fileName: this._currentFileName,
            relativeDir: this._currentRelativeDir
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
        this._chapters = parseChapters(text);
        
        // --- NEW: Reset Indices and Stop Playback on Document Change ---
        this._currentChapterIndex = 0;
        this._currentSentenceIndex = 0;
        this._playbackEngine.stop();
        
        this._postToAll({
            command: 'chapters',
            chapters: this._chapters.map((c, i) => ({ title: c.title, level: c.level, index: i })),
            current: 0,
            total: this._chapters.length
        });
        return true;
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
            chapters: this._chapters.map((c, i) => ({ title: c.title, level: c.level, index: i })),
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
        if (index < 0 || index >= this._chapters.length) return;
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
        if (chapterIndex < 0 || chapterIndex >= this._chapters.length) return;
        
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

        // --- NEW: File-Unique Cache Key ---
        const docId = this._currentDocumentUri?.toString() || this._currentFileName;
        const cacheKey = `${docId}-${chapterIndex}-${sentenceIndex}`;

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
                this._logger(`[ERR] Neural synthesis failed: ${err.message || err}. Falling back to SAPI.`);
                this._postToAll({
                    command: 'synthesisError',
                    error: err.message || String(err),
                    isFallingBack: true
                });
                this._postToAll({
                    command: 'engineStatus',
                    status: 'local-fallback'
                });
                this._playbackEngine.speakSAPI(sentence, options, (code) => this._onSAPIExit(code));
            });
            // Pre-fetch
            this._triggerPreFetch(chapterIndex, sentenceIndex + 1, options);
        } else {
            this._playbackEngine.speakSAPI(sentence, options, (code) => this._onSAPIExit(code));
        }
    }

    private _triggerPreFetch(chapterIndex: number, sentenceIndex: number, options: PlaybackOptions) {
        let count = 0;
        let cIdx = chapterIndex;
        let sIdx = sentenceIndex;

        // Prefetch a window of 5 sentences
        while (count < 5) {
            const chapter = this._chapters[cIdx];
            if (!chapter) break;

            if (sIdx < chapter.sentences.length) {
                const text = chapter.sentences[sIdx];
                const docId = this._currentDocumentUri?.toString() || this._currentFileName;
                const cacheKey = `${docId}-${cIdx}-${sIdx}`;
                this._playbackEngine.triggerPrefetch(text, cacheKey, options);
                sIdx++;
                count++;
            } else {
                // Move to next chapter
                cIdx++;
                sIdx = 0;
                if (!this._autoAdvance) break; // Don't prefetch next chapter if auto-advance is off
            }
        }
    }




    private _onSAPIExit(code: number | null) {
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

    private _moveNext() {
        const chapter = this._chapters[this._currentChapterIndex];
        if (this._currentSentenceIndex + 1 < chapter.sentences.length) {
            this._playChapter(this._currentChapterIndex, this._currentSentenceIndex + 1);
        } else if (this._autoAdvance) {
            this.jumpToChapter(this._currentChapterIndex + 1);
        } else {
            this.stop();
        }
    }
}
