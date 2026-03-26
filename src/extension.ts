import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import { MissionControlPanel } from './missionControl';
import { BridgeServer } from './bridgeServer';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

interface Chapter {
    title: string;
    level: number;
    lineStart: number;
    lineEnd: number;
    text: string;           // Cleaned speech text
    originalMarkdown: string; // Pre-cleaned source for future editing
    sentences: string[];
}

let playBarItem: vscode.StatusBarItem;
let pauseBarItem: vscode.StatusBarItem;
let stopBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let logFilePath: string;
let bridgeServer: BridgeServer;

function log(msg: string) {
    const time = new Date().toLocaleTimeString();
    const formatted = `[${time}] ${msg}`;
    
    if (outputChannel) {
        outputChannel.appendLine(formatted);
    }
    
    // Self-Debugging: Write to project file so Antigravity can read it
    if (logFilePath) {
        try {
            fs.appendFileSync(logFilePath, formatted + '\n');
        } catch (e) {
            // Silence FS errors to avoid loops
        }
    }
    
    console.log(`[READ ALOUD] ${formatted}`);
}




export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Read Aloud Diagnostics');
    outputChannel.show(true); 
    
    // Initialize log file
    logFilePath = path.join(context.extensionPath, 'diagnostics.log');
    try {
        fs.writeFileSync(logFilePath, `--- SESSION START: ${new Date().toLocaleString()} ---\n`);
    } catch (e) {
        console.error('Failed to init log file', e);
    }

    log('--- BOOTING READ ALOUD ENGINE ---');

    const speechProvider = new SpeechProvider(context.extensionUri, context.extensionPath);
    
    const config = vscode.workspace.getConfiguration('readAloud');
    const port = config.get<number>('bridgePort') || 3001;
    
    // Initialize Local Bridge for Antigravity Workspace (Environment Aware)
    bridgeServer = new BridgeServer(path.join(context.extensionPath, 'media'));
    
    log(`Initializing BridgeServer (Config: ${process.env.ANTIGRAVITY_BRIDGE_HOST || '127.0.0.1'}:${port})...`);
    
    bridgeServer.start(port).then(actualPort => {
        log(`BRIDGE ACTIVE on port ${actualPort}`);
        speechProvider.setBridge(bridgeServer);
    }).catch(err => {
        log(`BRIDGE FAILURE: ${err}`);
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'readme-preview-read-aloud.speech-engine',
            speechProvider,
            { 
                webviewOptions: { 
                    retainContextWhenHidden: true
                }
            }
        )
    );


    // Play Button
    playBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    playBarItem.command = 'readme-preview-read-aloud.play';
    playBarItem.text = '$(play) Read Aloud';
    playBarItem.tooltip = 'Start reading the current file';
    playBarItem.show();

    // Pause Button
    pauseBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    pauseBarItem.command = 'readme-preview-read-aloud.pause';
    pauseBarItem.text = '$(debug-pause)';
    pauseBarItem.tooltip = 'Pause reading';
    pauseBarItem.show();

    // Stop Button
    stopBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    stopBarItem.command = 'readme-preview-read-aloud.stop';
    stopBarItem.text = '$(debug-stop)';
    stopBarItem.tooltip = 'Stop reading';
    stopBarItem.show();

    try {
        context.subscriptions.push(
            playBarItem, pauseBarItem, stopBarItem,
            vscode.commands.registerCommand('readme-preview-read-aloud.show-dashboard', () => {
                log('Focusing Sidebar Dashboard...');
                vscode.commands.executeCommand('readme-preview-read-aloud.speech-engine.focus');
                speechProvider.refresh();
            }),

            vscode.commands.registerCommand('readme-preview-read-aloud.play', async () => {
                try {
                    log('Play command triggered.');
                    const editor = vscode.window.activeTextEditor;
                    let text = '';
                    
                    if (editor) {
                        const selection = editor.selection;
                        if (!selection.isEmpty) {
                            text = editor.document.getText(selection);
                            log('Playing user selection...');
                        } else {
                            text = editor.document.getText();
                            log(`Extracting full text from editor: ${editor.document.fileName}`);
                        }
                    } else {
                        log('No active editor. Searching tabs...');
                        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
                        if (tab) {
                            const input = tab.input;
                            let uri: vscode.Uri | undefined;
                            
                            if ((input as any).uri instanceof vscode.Uri) {
                                uri = (input as any).uri;
                            } else if ((input as any).resource instanceof vscode.Uri) {
                                uri = (input as any).resource;
                            } else if ((input as any).sourceUri) {
                                const potentialUri = (input as any).sourceUri;
                                uri = typeof potentialUri === 'string' ? vscode.Uri.parse(potentialUri) : potentialUri;
                            }

                            if (uri) {
                                log(`Reading from tab: ${uri.fsPath}`);
                                try {
                                    const doc = await vscode.workspace.openTextDocument(uri);
                                    text = doc.getText();
                                } catch (err) {
                                    log(`TAB OPEN ERROR: ${err}`);
                                }
                            }
                        }
                    }

                    if (text) {
                        speechProvider.play(text, 0, editor?.document.fileName);
                    } else {
                        vscode.window.showWarningMessage('No text found to read.');
                    }
                } catch (err) {
                    log(`PLAY COMMAND ERROR: ${err}`);
                }
            }),

            vscode.commands.registerCommand('readme-preview-read-aloud.pause', () => speechProvider.pause()),
            vscode.commands.registerCommand('readme-preview-read-aloud.stop', () => speechProvider.stop()),

            vscode.commands.registerCommand('readme-preview-read-aloud.read-from-cursor', async () => {
                try {
                    log('Read-From-Cursor triggered.');
                    const editor = vscode.window.activeTextEditor;
                    if (!editor) { vscode.window.showWarningMessage('No active editor.'); return; }
                    const text = editor.document.getText();
                    const cursorLine = editor.selection.active.line;
                    const chapters = parseChapters(text);
                    let targetIndex = 0;
                    for (let i = 0; i < chapters.length; i++) {
                        if (chapters[i].lineStart <= cursorLine) { targetIndex = i; }
                    }
                    log(`Read-From-Cursor: chapter ${targetIndex + 1} (cursor line ${cursorLine})`);
                    speechProvider.play(text, targetIndex, editor.document.fileName);
                } catch (err) {
                    log(`READ-FROM-CURSOR ERROR: ${err}`);
                }
            })
        );
    } catch (err) {
        log(`ACTIVATION ERROR: ${err}`);
    }

    // PASSIVE SYNC: Watch for tab changes to update the "Mission Control" context automatically
    const syncActiveTab = async () => {
        let tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        
        // Helper to extract URI from any tab input
        const getUri = (t: vscode.Tab | undefined): vscode.Uri | undefined => {
            const input = t?.input as any;
            if (!input) return undefined;
            if (input.uri instanceof vscode.Uri) return input.uri;
            if (input.resource instanceof vscode.Uri) return input.resource;
            if (input.sourceUri) return typeof input.sourceUri === 'string' ? vscode.Uri.parse(input.sourceUri) : input.sourceUri;
            return undefined;
        };

        const isMD = (uri: vscode.Uri | undefined) => uri && (uri.path.endsWith('.md') || uri.path.endsWith('.markdown'));

        let activeUri = getUri(tab);
        
        // DEEP SCAN FALLBACK: If current tab is NOT Markdown, hunt for the first open MD tab
        if (!isMD(activeUri)) {
            for (const group of vscode.window.tabGroups.all) {
                for (const t of group.tabs) {
                    const u = getUri(t);
                    if (isMD(u)) {
                        activeUri = u;
                        break;
                    }
                }
                if (isMD(activeUri)) break;
            }
        }

        if (isMD(activeUri)) {
            try {
                const doc = await vscode.workspace.openTextDocument(activeUri!);
                speechProvider.updateWorkingDocument(doc);
            } catch (e) {
                // Ignore errors for non-textual tabs
            }
        }
    };

    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(syncActiveTab),
        vscode.window.tabGroups.onDidChangeTabGroups(syncActiveTab),
        vscode.window.onDidChangeActiveTextEditor(syncActiveTab)
    );

    // Initial Sync
    syncActiveTab();

    return {
        bridge: bridgeServer
    };
}

class SpeechProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _panel?: vscode.WebviewPanel;
    private _isReady: boolean = false;
    private _isPanelReady: boolean = false;
    private _isRefreshing: boolean = false;
    private _voices: any[] = [];
    private _bridge?: BridgeServer;
    private _messageQueue: any[] = [];
    private _nativeProcess: any = null;
    private _lastText = '';
    private _chapters: Chapter[] = [];
    private _currentChapterIndex: number = 0;
    private _currentSentenceIndex: number = 0;
    private _followMode: boolean = false;
    private _autoAdvance: boolean = true;
    private _isPaused: boolean = false;
    private _isPlaying: boolean = false;
    
    // Audio Precision Sync
    private _selectedVoice: string = 'en-US-AriaNeural';
    private _rate: number = 0;
    private _volume: number = 100;
    private _currentFileName: string = 'No Document';
    private _currentRelativeDir: string = '';
    private _engineMode: 'local' | 'neural' = 'neural';
    private _tts: MsEdgeTTS;
    private _neuralVoices: any[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _extensionPath: string
    ) {
        this._tts = new MsEdgeTTS();
        this._loadVoices();
    }

    public setBridge(bridge: BridgeServer) {
        this._bridge = bridge; 
        log('Bridge attached to SpeechProvider. Refreshing view...');
        this.refresh();
    }


    private async _loadVoices() {
        try {
            const command = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices().VoiceInfo.Name';
            child_process.exec(`powershell -Command "${command}"`, (error, stdout, stderr) => {
                if (!error && stdout) {
                    this._voices = stdout.split('\r\n').filter(v => v.trim()).map(v => v.trim());
                    log(`Detected ${this._voices.length} local SAPI voices.`);
                    this._broadcastVoices();
                }
            });

            // Fetch Neural Voices
            const neural = await this._tts.getVoices();
            this._neuralVoices = neural.map(v => ({
                name: v.FriendlyName,
                id: v.ShortName,
                lang: v.Locale,
                gender: v.Gender
            }));
            log(`Detected ${this._neuralVoices.length} neural voices.`);
            this._broadcastVoices();
        } catch (e) {
            log(`VOICE SCAN ERROR: ${e}`);
        }
    }

    private _broadcastVoices() {
        this._postToAll({ 
            command: 'voices', 
            voices: this._voices, 
            neuralVoices: this._neuralVoices,
            engineMode: this._engineMode
        });
    }

    /** Unified handler for messages from any webview surface */
    private _handleWebviewMessage(data: any, source: 'sidebar' | 'panel') {
        switch (data.command) {
            case 'ready':
                this._sendInitialState();
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
            case 'toggleFollow':
                this.setFollowMode(data.enabled);
                break;
            case 'toggleAutoPlay':
                this.setAutoAdvance(data.enabled);
                break;
            case 'voiceChanged':
                this._selectedVoice = data.voice;
                log(`Voice set to: ${this._selectedVoice}`);
                break;
            case 'rateChanged':
                this._rate = data.rate;
                log(`Audio Rate: ${this._rate}`);
                break;
            case 'volumeChanged':
                this._volume = data.volume;
                log(`Audio Volume: ${this._volume}`);
                break;
            case 'engineModeChanged':
                this._engineMode = data.mode;
                log(`Engine Mode Switched to: ${this._engineMode}`);
                // Stop current if switching mid-stream
                this._isPaused = true;
                this.stopProcess();
                this._broadcastVoices();
                break;
            case 'sentenceEnded':
                if (!this._isPaused) {
                    this._moveNext();
                }
                break;
            case 'prevSentence':
                this.prevSentence();
                break;
            case 'nextSentence':
                this.nextSentence();
                break;
            case 'jumpToSentence':
                this.jumpToSentence(data.index);
                break;
            case 'continue':
                this.continue();
                break;
            case 'pause':
                this.pause();
                break;
            case 'stop':
                this.stop();
                break;
            case 'startOver':
                this.startOver();
                break;
            case 'loadDocument':
                this.loadCurrentDocument();
                break;
            case 'log':
                log(`[${source.toUpperCase()}] ${data.message}`);
                break;
        }
    }

    private _sendInitialState() {
        this._postToAll({
            command: 'initialState',
            voice: this._selectedVoice,
            rate: this._rate,
            volume: this._volume,
            follow: this._followMode,
            autoPlay: this._autoAdvance,
            isPaused: this._isPaused,
            fileName: this._currentFileName,
            relativeDir: this._currentRelativeDir,
            engineMode: this._engineMode
        });
    }

    public updateWorkingDocument(document: vscode.TextDocument) {
        this._currentFileName = path.basename(document.fileName);
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (folder) {
            const rel = path.relative(folder.uri.fsPath, path.dirname(document.fileName));
            this._currentRelativeDir = (rel && rel !== '.') ? rel : '';
        } else {
            this._currentRelativeDir = '';
        }
        this.broadcastDocumentInfo(this._currentFileName, this._currentRelativeDir);
    }

    public broadcastDocumentInfo(fileName: string, relativeDir: string = '') {
        this._postToAll({
            command: 'documentInfo',
            fileName: fileName,
            relativeDir: relativeDir
        });
    }

    public setFollowMode(enabled: boolean) {
        this._followMode = enabled;
        log(`Follow mode: ${enabled}`);
    }

    public setAutoAdvance(enabled: boolean) {
        this._autoAdvance = enabled;
        log(`Auto-advance: ${enabled}`);
    }

    public nextChapter() {
        this.jumpToChapter(this._currentChapterIndex + 1);
    }

    public prevChapter() {
        this.jumpToChapter(this._currentChapterIndex - 1);
    }

    public openDashboard() {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.Beside);
            return;
        }

        log('--- OPENING FLOATING MISSION CONTROL ---');
        this._panel = vscode.window.createWebviewPanel(
            'readAloudDashboard',
            'Read Aloud: Mission Control',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                enableCommandUris: true,
                enableForms: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this._extensionUri, 'media')
                ],
                retainContextWhenHidden: false
            }
        );

        // Synchronous Occupancy: Set HTML immediately to stabilize ServiceWorker
        this._panel.webview.html = this._bridge
            ? this._bridge.getHtml(this._panel.webview)
            : '<body>Connecting to Bridge...</body>';
        log('Dashboard Injected Synchronously.');

        this._panel.webview.onDidReceiveMessage(data => {
            if (data.command === 'ready') {
                log('Dashboard Signal: READY.');
                this._isPanelReady = true;
                this._sendInitialState(); // PUSH startup context (cached filename)
                this._broadcastVoices();
                this._flushQueue();
                return;
            }
            this._handleWebviewMessage(data, 'panel');
        });

        this._panel.onDidDispose(() => {
            log('Dashboard Closed.');
            this._panel = undefined;
            this._isPanelReady = false;
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        log('--- ACTIVATING MISSION CONTROL (Sidebar) ---');
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media')
            ]
        };

        // Handshake: Listen for dashboard signals
        webviewView.webview.onDidReceiveMessage(data => {
            if (data.command === 'ready') {
                log('Sidebar Dashboard: READY.');
                this._isReady = true;
                this._sendInitialState(); // PUSH startup context (cached filename)
                this._broadcastVoices();
                this._flushQueue();
                return;
            }
            this._handleWebviewMessage(data, 'sidebar');
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                log('Sidebar became visible. Refreshing state...');
                this._broadcastVoices();
            }
        });

        // Synchronous Safety Occupancy: Set a minimal loader to anchor the ServiceWorker
        webviewView.webview.html = `<!DOCTYPE html><html><body style="background:transparent;color:#888;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;">Initializing Handshake...</body></html>`;

        // Initial load (Increased delay to 500ms to allow workbench stable state)
        setTimeout(() => this.refresh(), 500);
    }

    /**
     * Force a full UI re-render from the backend with safety locks and retries
     */
    public async refresh() {
        if (!this._view) {
            log('Refresh requested but view not resolved yet.');
            return;
        }

        if (this._isRefreshing) {
            log('Refresh skipped: Concurrent update already in progress.');
            return;
        }

        if (!this._bridge) {
            log('Refresh requested but bridge not initialized.');
            return;
        }

        this._isRefreshing = true;
        log('--- FORCING HERMETIC REFRESH (Unified Bridge) ---');
        
        try {
            // REBUILD: The bridge now generates the CSP and all inlines internally.
            const html = this._bridge.getHtml(this._view.webview);
            
            this._view.webview.html = html;
            log(`Sidebar Engine Injected: ${html.length} chars. Handshake Re-established.`);
        } catch (e) {
            log(`[CRITICAL] Webview refresh failed (InvalidState?): ${e}. Retrying in 1s...`);
            setTimeout(() => this.refresh(), 1000);
        } finally {
            this._isRefreshing = false;
        }
    }




    private _flushQueue() {
        const hasSidebar = this._view && this._isReady;
        const hasPanel = this._panel && this._isPanelReady;
        
        if (!hasSidebar && !hasPanel) return;

        while (this._messageQueue.length > 0) {
            const msg = this._messageQueue.shift();
            if (hasSidebar) this._view!.webview.postMessage(msg);
            if (hasPanel) this._panel!.webview.postMessage(msg);
            if (this._bridge) this._bridge.broadcast(msg);
        }
    }

    /** Broadcast a message to all active UI surfaces */
    private _postToAll(msg: any) {
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
    }

    public loadCurrentDocument() {
        log('Manual Load Document request.');
        const editor = vscode.window.activeTextEditor;
        let text = '';
        let fileName = '';

        if (editor) {
            text = editor.document.getText();
            fileName = editor.document.fileName;
            this.updateWorkingDocument(editor.document);
        }

        if (text) {
            this._lastText = text;
            this._chapters = parseChapters(text);
            log(`Loaded ${this._chapters.length} chapters.`);

            // Broadcast chapter list to all UI surfaces
            this._postToAll({
                command: 'chapters',
                chapters: this._chapters.map((c, i) => ({ title: c.title, level: c.level, index: i })),
                current: 0,
                total: this._chapters.length
            });
            
            vscode.window.showInformationMessage(`Loaded ${this._chapters.length} chapters from ${this._currentFileName || 'document'}`);
        } else {
            vscode.window.showWarningMessage('No active document found to load.');
        }
    }

    public play(text: string, startFromChapter: number = 0, fileName?: string) {
        if (fileName) {
            this._currentFileName = path.basename(fileName);
            // Get relative path from workspace root if possible
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fileName));
            if (workspaceFolder) {
                const relativePath = path.relative(workspaceFolder.uri.fsPath, path.dirname(fileName));
                this._currentRelativeDir = relativePath && relativePath !== '.' ? relativePath : '';
            } else {
                this._currentRelativeDir = '';
            }
            this.broadcastDocumentInfo(this._currentFileName, this._currentRelativeDir);
        }
        log(`PLAY REQUEST from chapter ${startFromChapter}: ${text.substring(0, 30)}...`);
        this._lastText = text;

        // Parse document into chapters
        this._chapters = parseChapters(text);
        log(`Parsed ${this._chapters.length} chapters.`);

        // Broadcast chapter list to all UI surfaces
        this._postToAll({
            command: 'chapters',
            chapters: this._chapters.map((c, i) => ({ title: c.title, level: c.level, index: i })),
            current: startFromChapter,
            total: this._chapters.length
        });

        // Start playback from target chapter
        this._isPaused = false;
        this._isPlaying = true;
        this._playChapter(startFromChapter, 0);
    }

    private _playChapter(chapterIndex: number, sentenceIndex: number = 0) {
        if (chapterIndex < 0 || chapterIndex >= this._chapters.length) {
            log(`Chapter index ${chapterIndex} out of range.`);
            return;
        }

        this._currentChapterIndex = chapterIndex;
        this._currentSentenceIndex = sentenceIndex;
        const chapter = this._chapters[chapterIndex];

        // Notify UI of chapter change only at the start of chapter
        if (sentenceIndex === 0) {
            this._postToAll({
                command: 'chapterChanged',
                index: chapterIndex,
                total: this._chapters.length,
                title: chapter.title
            });

            // Follow mode: scroll editor
            if (this._followMode) {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const pos = new vscode.Position(chapter.lineStart, 0);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
            }
        }

        if (!chapter.sentences || chapter.sentences.length === 0) {
            this._moveNext();
            return;
        }

        const sentence = chapter.sentences[sentenceIndex];
        log(`Playing [C${chapterIndex} S${sentenceIndex}]: "${sentence.substring(0, 40)}..."`);
        
        this._postToAll({
            command: 'sentenceChanged',
            text: sentence,
            chapterIndex: chapterIndex,
            sentenceIndex: sentenceIndex,
            totalSentences: chapter.sentences.length,
            sentences: chapter.sentences
        });

        if (this._engineMode === 'neural') {
            this._executeNeural(sentence);
        } else {
            this._executeSAPI(sentence);
        }
    }

    private async _executeNeural(text: string) {
        log(`Streaming Neural Audio for: "${text.substring(0, 30)}..."`);
        try {
            // Configure TTS for current sentence
            // Ensure the voice name is a valid neural voice (ShortName format: xx-XX-NameNeural)
            let voiceId = this._selectedVoice || "en-US-AriaNeural";
            const isNeuralVoice = this._neuralVoices.some(v => v.id === voiceId);
            if (!isNeuralVoice) {
                log(`[NEURAL] Voice "${voiceId}" is not a neural voice. Defaulting to Aria.`);
                voiceId = "en-US-AriaNeural";
            }

            log(`[NEURAL] Initializing voice: ${voiceId}`);
            // [FIX] msedge-tts library throws if 3rd arg is missing: "reading voiceLocale of undefined"
            await this._tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {});
            
            // Note: Volume and Rate are now handled client-side in the webview for immediate feedback.
            // We synthesize at default parameters to allow dynamic adjustments in the browser.
            log(`[NEURAL] Requesting stream (Standard Prosody)...`);
            const { audioStream } = this._tts.toStream(text);
            const chunks: any[] = [];
            
            audioStream.on("data", (data) => chunks.push(data));
            
            await new Promise((resolve, reject) => {
                audioStream.on("end", () => {
                    log(`[NEURAL] Stream ended. Collected ${chunks.length} chunks.`);
                    resolve(null);
                });
                audioStream.on("error", (err) => {
                    log(`[NEURAL] Stream Error: ${err}`);
                    reject(err);
                });
            });

            const buffer = Buffer.concat(chunks);
            log(`[NEURAL] Buffer ready: ${buffer.length} bytes.`);
            
            // Broadcast the audio to the webview only if we're still playing
            if (this._isPlaying) {
                this._postToAll({
                    command: 'playAudio',
                    data: buffer.toString('base64'),
                    text: text
                });
            } else {
                log(`[NEURAL] Playback was stopped during synthesis. Ignoring buffer.`);
            }

        } catch (err) {
            if (!this._isPlaying) return;
            log(`NEURAL TTS ERROR: ${err}`);
            vscode.window.showErrorMessage(`Neural TTS Failed: ${err}. Falling back to Native.`);
            this._engineMode = 'local';
            this._broadcastVoices();
            this._executeSAPI(text);
        }
    }

    private _executeSAPI(text: string) {
        if (this._nativeProcess) {
            try { child_process.execSync(`taskkill /F /T /PID ${this._nativeProcess.pid}`); } catch (e) {}
            this._nativeProcess = null;
        }

        const safeText = text.replace(/["']/g, '');
        
        // Multi-line PowerShell script for SAPI control
        const psScript = `
            $v = New-Object -ComObject SAPI.SpVoice;
            $v.Volume = ${this._volume};
            $v.Rate = ${this._rate};
            if ('${this._selectedVoice}') {
                $v.Voice = $v.GetVoices() | Where-Object { $_.GetDescription() -eq '${this._selectedVoice}' };
            }
            $v.Speak('${safeText}')
        `.trim().replace(/\n/g, ' ');

        this._nativeProcess = child_process.spawn('powershell', ['-Command', psScript]);

        this._nativeProcess.on('exit', (code: number | null) => {
            this._nativeProcess = null;
            if (code === 0 && !this._isPaused) {
                this._moveNext();
            }
        });
    }

    private _moveNext() {
        const chapter = this._chapters[this._currentChapterIndex];
        const nextSent = this._currentSentenceIndex + 1;

        if (nextSent < chapter.sentences.length) {
            // Next sentence in current chapter
            setTimeout(() => this._playChapter(this._currentChapterIndex, nextSent), 100);
        } else if (this._autoAdvance) {
            // Next chapter
            const nextChap = this._currentChapterIndex + 1;
            if (nextChap < this._chapters.length) {
                setTimeout(() => this._playChapter(nextChap, 0), 300);
            } else {
                log('End of document reached.');
                this.stop();
            }
        } else {
            this.stop();
        }
    }

    public jumpToChapter(index: number) {
        if (index < 0 || index >= this._chapters.length) return;
        this._isPaused = false;
        this.stopProcess();
        this._postToAll({ command: 'playbackStateChanged', state: 'playing' });
        setTimeout(() => this._playChapter(index, 0), 100);
    }

    public prevSentence() {
        this.jumpToSentence(this._currentSentenceIndex - 1);
    }

    public nextSentence() {
        this.jumpToSentence(this._currentSentenceIndex + 1);
    }

    public jumpToSentence(index: number) {
        log(`Jumping to sentence ${index}`);
        this._isPaused = false;
        this.stopProcess();
        this._postToAll({ command: 'playbackStateChanged', state: 'playing' });
        
        const chapter = this._chapters[this._currentChapterIndex];
        if (!chapter) return;

        if (index < 0) {
            // Boundary crossing: previous chapter
            if (this._currentChapterIndex > 0) {
                const prevChap = this._chapters[this._currentChapterIndex - 1];
                setTimeout(() => this._playChapter(this._currentChapterIndex - 1, prevChap.sentences.length - 1), 100);
            }
            return;
        }

        if (index >= chapter.sentences.length) {
            // Boundary crossing: next chapter
            if (this._currentChapterIndex < this._chapters.length - 1) {
                setTimeout(() => this._playChapter(this._currentChapterIndex + 1, 0), 100);
            }
            return;
        }

        setTimeout(() => this._playChapter(this._currentChapterIndex, index), 100);
    }

    public continue() {
        if (this._isPaused) {
            log('Continuing playback...');
            this._isPaused = false;
            this._postToAll({ command: 'playbackStateChanged', state: 'playing' });
            this._playChapter(this._currentChapterIndex, this._currentSentenceIndex);
        } else if (!this._nativeProcess) {
            // If nothing is playing, trigger the global play command (which picks up selection)
            vscode.commands.executeCommand('readme-preview-read-aloud.play');
        }
    }

    public startOver() {
        log('Starting over from beginning...');
        this.play(this._lastText, 0);
    }

    public pause() {
        log('Pausing playback...');
        this._isPaused = true;
        this._isPlaying = false;
        this.stopProcess();
        this._postToAll({ command: 'pause' });
    }

    public stop() {
        log('Stopping playback...');
        this._isPaused = false;
        this._isPlaying = false;
        this._currentChapterIndex = 0;
        this._currentSentenceIndex = 0;
        this.stopProcess();
        this._postToAll({ command: 'stop' });
    }

    private stopProcess() {
        if (this._nativeProcess) {
            try {
                // Windows specific kill sequence
                child_process.execSync(`taskkill /F /T /PID ${this._nativeProcess.pid}`);
            } catch (err) {}
            this._nativeProcess = null;
        }
    }
}

function parseChapters(rawText: string): Chapter[] {
    const lines = rawText.split('\n');
    // Match only #, ##, ### headings (not #### or deeper)
    const headingRegex = /^(#{1,3})(?!#)\s+(.+)/;
    const headings: { level: number; title: string; lineIndex: number }[] = [];

    lines.forEach((line, i) => {
        const match = line.match(headingRegex);
        if (match) {
            headings.push({ level: match[1].length, title: match[2].trim(), lineIndex: i });
        }
    });

    const chapters: Chapter[] = [];
    headings.forEach((h, i) => {
        const lineStart = h.lineIndex;
        const lineEnd = i + 1 < headings.length ? headings[i + 1].lineIndex - 1 : lines.length - 1;
        const chunkText = lines.slice(lineStart, lineEnd + 1).join('\n');
        const stripped = stripMarkdown(chunkText);
        if (stripped.trim().length > 0) {
            const sentences = splitIntoSentences(stripped);
            chapters.push({ 
                title: h.title, 
                level: h.level, 
                lineStart, 
                lineEnd, 
                text: stripped,
                originalMarkdown: chunkText,
                sentences: sentences
            });
        }
    });

    // Fallback: no headings found → treat entire doc as one chapter
    if (chapters.length === 0) {
        const stripped = stripMarkdown(rawText);
        chapters.push({
            title: 'Document',
            level: 1,
            lineStart: 0,
            lineEnd: lines.length - 1,
            text: stripped,
            originalMarkdown: rawText,
            sentences: splitIntoSentences(stripped)
        });
    }

    return chapters;
}

function splitIntoSentences(text: string): string[] {
    // Advanced sentence splitting that respects common abbreviations
    const abbreviations = [
        'Dr', 'Mr', 'Mrs', 'Ms', 'Jr', 'Sr', 'Prof', 'St', 
        'e\\.g', 'i\\.e', 'vs', 'etc', 'Vol', 'Fig', 'p\\.', 'pp\\.'
    ];
    const abbrRegex = `(?<!\\b(?:${abbreviations.join('|')}))`;
    const splitter = new RegExp(`${abbrRegex}[.!?]+(?:\\s+|$)`, 'g');

    const result: string[] = [];
    let match;
    let lastIndex = 0;

    while ((match = splitter.exec(text)) !== null) {
        result.push(text.slice(lastIndex, match.index + match[0].length).trim());
        lastIndex = splitter.lastIndex;
    }

    if (lastIndex < text.length) {
        const remaining = text.slice(lastIndex).trim();
        if (remaining) result.push(remaining);
    }

    // Filter results to ensure we don't send "empty" or punctuation-only strings to TTS
    return result
        .map(s => s.trim())
        .filter(s => {
            // Must contain at least one letter or number (Universal support for Hebrew, English, etc.)
            return s.length > 0 && /[\p{L}\p{N}]/u.test(s);
        });
}

function stripMarkdown(md: string): string {
    return md
        .replace(/^[*-]{3,}$/gm, '') // Filter horizontal rules (---, ***)
        .replace(/^#+\s+(.+)$/gm, '$1. ') 
        .replace(/\*\*|__/g, '') 
        .replace(/\*|_/g, '') 
        // Images: Keep alt-text for meaningful context
        .replace(/!\[(.*?)\]\(.*?\)/g, '$1. ') 
        // Links: Keep text
        .replace(/\[(.*?)\]\(.*?\)/g, '$1') 
        // Code Blocks: Option B - Omit with marker
        .replace(/`{3,}[\s\S]*?`{3,}/g, '\n[Code block omitted].\n') 
        // Tables: Omit with marker
        .replace(/^\|.*?|$/gm, '') // Crude table line removal
        .replace(/`(.+?)`/g, '$1') 
        // Lists: Add punctuation to force SAPI pause between items
        .replace(/^\s*[-*+]\s+(.+)$/gm, '$1. ') 
        .replace(/^\s*(>\s+)+(.+)$/gm, 'Quote: $2. ') 
        .replace(/<[^>]*>/g, '') 
        .replace(/\n{2,}/g, '\n') // Collapse excessive newlines
        .trim();
}

export function deactivate() {}
