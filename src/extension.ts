import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';

let playBarItem: vscode.StatusBarItem;
let pauseBarItem: vscode.StatusBarItem;
let stopBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let logFilePath: string;

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

export function activate(context: vscode.ExtensionContext) {
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
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'readme-preview-read-aloud.speech-engine',
            speechProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
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
                try {
                    log('Open Dashboard triggered.');
                    speechProvider.openDashboard();
                } catch (err) {
                    log(`DASHBOARD ERROR: ${err}`);
                }
            }),
            vscode.commands.registerCommand('readme-preview-read-aloud.play', async () => {
                try {
                    log('Play command triggered.');
                    const editor = vscode.window.activeTextEditor;
                    let text = '';
                    
                    if (editor) {
                        log(`Extracting text from editor: ${editor.document.fileName}`);
                        text = editor.document.getText();
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
                                } catch (e) {
                                    log(`ERROR: Failed to read ${uri.fsPath}: ${e}`);
                                }
                            }
                        }
                    }

                    if (text) {
                        const stripped = stripMarkdown(text);
                        log(`Extracted ${text.length} chars. Stripped to ${stripped.length}.`);
                        speechProvider.play(stripped);
                    } else {
                        log('WARNING: No text found to read.');
                        vscode.window.showInformationMessage('No readable text found.');
                    }
                } catch (err) {
                    log(`CRITICAL PLAY COMMAND ERROR: ${err}`);
                }
            }),
            vscode.commands.registerCommand('readme-preview-read-aloud.pause', () => {
                try {
                    log('Pause triggered.');
                    speechProvider.pause();
                } catch (err) {
                    log(`PAUSE ERROR: ${err}`);
                }
            }),
            vscode.commands.registerCommand('readme-preview-read-aloud.stop', () => {
                try {
                    log('Stop triggered.');
                    speechProvider.stop();
                } catch (err) {
                    log(`STOP ERROR: ${err}`);
                }
            })
        );
    } catch (err) {
        log(`CRITICAL ACTIVATION ERROR (SUBSCRIPTIONS): ${err}`);
    }

    log('Readme Preview Read Aloud: Sidebar Sanctuary Active!');
    vscode.window.showInformationMessage('Read Aloud: Ready!');
}

class SpeechProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _panel?: vscode.WebviewPanel;
    private _isReady: boolean = false;
    private _isPanelReady: boolean = false;
    private _messageQueue: any[] = [];
    private _nativeProcess: child_process.ChildProcess | null = null;
    private _lastText: string = '';
    private _voices: string[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _extensionPath: string
    ) {
        this._loadVoices();
    }

    private async _loadVoices() {
        try {
            const command = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices().VoiceInfo.Name';
            child_process.exec(`powershell -Command "${command}"`, (err, stdout) => {
                if (!err && stdout) {
                    this._voices = stdout.split('\r\n').filter(v => v.trim());
                    log(`Detected ${this._voices.length} native voices.`);
                    this._broadcastVoices();
                }
            });
        } catch (e) {
            log(`VOICE SCAN ERROR: ${e}`);
        }
    }

    private _broadcastVoices() {
        if (this._voices.length === 0) return;
        
        if (this._view && this._isReady) {
            this._view.webview.postMessage({ command: 'voices', voices: this._voices });
        }
        if (this._panel && this._isPanelReady) {
            this._panel.webview.postMessage({ command: 'voices', voices: this._voices });
        }
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
                // Removed localResourceRoots to bypass ServiceWorker registration failure
                retainContextWhenHidden: false
            }
        );

        // Wait-and-Push Protocol: 1000ms delay allows the host to stabilize 
        // its internal ServiceWorker before we inject HTML content.
        setTimeout(() => {
            if (this._panel) {
                const html = this._getHtmlContent(this._panel.webview);
                this._panel.webview.html = html;
                log('Dashboard Injected after 1000ms.');
            }
        }, 1000);

        this._panel.webview.onDidReceiveMessage(data => {
            switch (data.command) {
                case 'ready':
                    log('Dashboard Signal: READY.');
                    this._isPanelReady = true;
                    this._broadcastVoices();
                    this._flushQueue();
                    break;
                case 'log': log(`[DASHBOARD] ${data.message}`); break;
            }
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
            enableScripts: true
            // Removed localResourceRoots to bypass ServiceWorker registration failure
        };

        // Wait-and-Push Protocol: 1000ms delay for the Sidebar
        setTimeout(() => {
            if (this._view) {
                const html = this._getHtmlContent(this._view.webview);
                this._view.webview.html = html;
                log(`Sidebar Engine Injected: ${html.length} chars. Timestamp: ${new Date().toISOString()}`);
            }
        }, 1000);
    }

    private _getHtmlContent(webview: vscode.Webview, fileName: string = 'speechEngine.html'): string {
        const htmlPath = path.join(this._extensionPath, 'media', fileName);
        const scriptPath = path.join(this._extensionPath, 'media', 'dashboard.js');
        
        log(`--- ENGINE HTML REQUEST (${fileName}) ---`);
        
        try {
            if (!fs.existsSync(htmlPath)) {
                log(`CRITICAL: File missing at ${htmlPath}`);
                return `<h1>Missing File</h1><p>Expected at: ${htmlPath}</p>`;
            }
            
            let content = fs.readFileSync(htmlPath, 'utf8');
            
            // Only process templates if we are using the main engine file
            if (fileName === 'speechEngine.html') {
                const inlineScript = fs.readFileSync(scriptPath, 'utf8');
                content = content.replace(/\$\{inlineScript\}/g, inlineScript);
                content = content.replace(/\$\{cspSource\}/g, webview.cspSource);
            }
            
            return content;
        } catch (err) {
            log(`CRITICAL ERROR: Failed to read assets: ${err}`);
            return `<h1>Load Error</h1><p>${err}</p>`;
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
        }
    }

    public play(text: string) {
        log(`PLAY REQUEST: ${text.substring(0, 30)}...`);
        this._lastText = text;

        // 1. Visual Sync (UI)
        if (this._view && this._isReady) {
            this._view.webview.postMessage({ command: 'play', text });
        }
        if (this._panel && this._isPanelReady) {
            this._panel.webview.postMessage({ command: 'play', text });
        }
        
        if (!this._isReady && !this._isPanelReady) {
            log('No UI ready for visual feedback. Continuing with Native audio...');
        }

        // 2. Native Audio (Reliability)
        try {
            this.stop(); // Stop any existing speech
            
            // Limit text size for CLI safety
            const safeText = text.replace(/["']/g, '').substring(0, 5000); 
            const command = `(New-Object -ComObject SAPI.SpVoice).Speak('${safeText}')`;
            
            log('Spawning Native PowerShell Voice...');
            this._nativeProcess = child_process.spawn('powershell', ['-Command', command]);
            
            this._nativeProcess.on('error', (err) => {
                log(`NATIVE ERROR: ${err.message}`);
            });

            this._nativeProcess.on('exit', (code) => {
                log(`Native Speech Exit Code: ${code}`);
                this._nativeProcess = null;
            });
        } catch (err) {
            log(`CRITICAL NATIVE PLAY ERROR: ${err}`);
        }
    }

    public pause() {
        log('Pause: Stop and Clear (Native MVP)');
        this.stop(); // SAPI pause is complex via CLI, easier to just stop/clear
    }

    public stop() {
        if (this._nativeProcess) {
            try {
                log('Silencing Native Voice...');
                // Windows specific kill sequence
                child_process.exec(`taskkill /F /T /PID ${this._nativeProcess.pid}`);
                this._nativeProcess = null;
            } catch (err) {
                log(`STOP ERROR: ${err}`);
            }
        }
        this._view?.webview.postMessage({ command: 'stop' });
        this._panel?.webview.postMessage({ command: 'stop' });
    }
}

function stripMarkdown(md: string): string {
    return md
        .replace(/^#+\s+/gm, '') 
        .replace(/\*\*|__/g, '') 
        .replace(/\*|_/g, '') 
        .replace(/!\[.*?\]\(.*?\)/g, '') 
        .replace(/\[(.*?)\]\(.*?\)/g, '$1') 
        .replace(/`{3,}[\s\S]*?`{3,}/g, '') 
        .replace(/`(.+?)`/g, '$1') 
        .replace(/^\s*[-*+]\s+/gm, '') 
        .replace(/^\s*>\s+/gm, '') 
        .replace(/<[^>]*>/g, '') 
        .trim();
}

export function deactivate() {}
