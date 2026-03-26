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
            }),
            vscode.commands.registerCommand('readme-preview-read-aloud.show-dashboard', () => {
                try {
                    log('Forcing Dashboard Visibility...');
                    vscode.commands.executeCommand('workbench.view.extension.readme-read-aloud');
                } catch (err) {
                    log(`SHOW DASHBOARD ERROR: ${err}`);
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
    private _isReady: boolean = false;
    private _messageQueue: any[] = [];
    private _nativeProcess: child_process.ChildProcess | null = null;
    private _lastText: string = '';

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _extensionPath: string
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        log('--- ACTIVATING SIDEBAR SANCTUARY ---');
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        const html = this._getHtmlContent();
        log(`Sidebar: Injecting HTML (${html.length} chars)`);
        webviewView.webview.html = html;
        log('Sidebar: Waiting for Engine Ready signal...');

        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.command) {
                case 'log':
                    log(`[ENGINE] ${data.message}`);
                    break;
                case 'error':
                    log(`[ENGINE ERROR] ${data.message}`);
                    break;
                case 'ready':
                    log(`Engine Signal: READY (Level: ${data.final ? 'FINAL' : 'BOOT'}).`);
                    this._isReady = true;
                    this._flushQueue();
                    break;
                case 'onEnd':
                    log('Playback Finished.');
                    break;
            }
        });
    }

    private _getHtmlContent(): string {
        const htmlPath = path.join(this._extensionPath, 'media', 'speechEngine.html');
        log(`Sidebar: Searching for HTML at: ${htmlPath}`);
        try {
            const content = fs.readFileSync(htmlPath, 'utf8');
            // Visual Marker for rendering confirmation
            return `
                <div style="padding: 15px; color: #fff; background: #2ecc71; font-family: sans-serif; border-bottom: 2px solid #555; text-align: center; font-weight: bold; font-size: 16px;">
                    🟢 SYSTEM HEARTBEAT: ALIVE
                </div>
                <div style="padding: 10px; color: #fff; background: #333; font-family: sans-serif; border-bottom: 2px solid #555;">
                    📣 Read Aloud Engine Active
                </div>
                ${content}
            `;
        } catch (err) {
            log(`CRITICAL ERROR: Failed to read HTML file: ${err}`);
            return `<h1>Speech Engine Load Error</h1><p>${err}</p>`;
        }
    }

    private _flushQueue() {
        if (!this._view || !this._isReady) return;
        while (this._messageQueue.length > 0) {
            const msg = this._messageQueue.shift();
            this._view.webview.postMessage(msg);
        }
    }

    public play(text: string) {
        log(`PLAY REQUEST: ${text.substring(0, 30)}...`);
        this._lastText = text;

        // 1. Visual Sync (Sidebar)
        if (this._view && this._isReady) {
            this._view.webview.postMessage({ command: 'play', text });
        } else {
            log('Sidebar not ready for visual feedback. Continuing with Native audio...');
            if (this._view) {
                this._view.show?.(true); 
            }
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
