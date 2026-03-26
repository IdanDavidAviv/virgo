import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import { MissionControlPanel } from './missionControl';
import { BridgeServer } from './bridgeServer';

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

/**
 * Antigravity Platform Guard:
 * Ensures the internal UnleashProvider is ready before the extension begins its work.
 * This prevents the "UnleashProvider must be initialized first!" error in the host.
 */
async function waitForUnleashReady(log: (m: string) => void): Promise<boolean> {
    const MAX_RETRIES = 15; // Increased retries
    const RETRY_DELAY = 1000;
    
    log("Checking Antigravity Core state...");
    
    for (let i = 0; i < MAX_RETRIES; i++) {
        const agExt = vscode.extensions.getExtension('google.antigravity');
        
        if (agExt) {
            if (agExt.isActive) {
                log("Antigravity Core ACTIVE. Waiting 1s for service warm-up...");
                await new Promise(r => setTimeout(r, 1000)); // Extra safety buffer
                log("Antigravity Core ready. Proceeding.");
                return true;
            }
            log(`Antigravity Core found but INACTIVE (Attempt ${i+1}/${MAX_RETRIES})...`);
        } else {
            log(`Antigravity Core extension NOT FOUND (Attempt ${i+1}/${MAX_RETRIES})...`);
        }
        
        await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
    
    log("TIMED OUT waiting for Antigravity Core.");
    return false;
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
    
    // Wait for platform readiness
    await waitForUnleashReady(log);

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
                                } catch (err) {
                                    log(`TAB OPEN ERROR: ${err}`);
                                }
                            }
                        }
                    }

                    if (text) {
                        speechProvider.play(text);
                    } else {
                        vscode.window.showWarningMessage('No text found to read.');
                    }
                } catch (err) {
                    log(`PLAY COMMAND ERROR: ${err}`);
                }
            }),

            vscode.commands.registerCommand('readme-preview-read-aloud.pause', () => speechProvider.pause()),
            vscode.commands.registerCommand('readme-preview-read-aloud.stop', () => speechProvider.stop())
        );
    } catch (err) {
        log(`ACTIVATION ERROR: ${err}`);
    }

    // EXPORT: Provide the bridge to other modules (like MissionControl)
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

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _extensionPath: string
    ) {
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
        
        // Performance: Only send to webview if it is actually visible
        if (this._view && this._view.visible && this._isReady) {
            this._view.webview.postMessage({ command: 'voices', voices: this._voices });
        }
        if (this._panel && this._panel.visible && this._isPanelReady) {
            this._panel.webview.postMessage({ command: 'voices', voices: this._voices });
        }
        if (this._bridge) {
            this._bridge.broadcast({ command: 'voices', voices: this._voices });
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
                localResourceRoots: [
                    vscode.Uri.joinPath(this._extensionUri, 'media')
                ],
                retainContextWhenHidden: false
            }
        );

        // Synchronous Occupancy: Set HTML immediately to stabilize ServiceWorker
        const html = this._getHtmlContent(this._panel.webview);
        this._panel.webview.html = html;
        log('Dashboard Injected Synchronously.');

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
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media')
            ]
        };

        // Handshake: Listen for dashboard signals
        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.command) {
                case 'ready':
                    log('Sidebar Dashboard: READY.');
                    this._isReady = true;
                    this._broadcastVoices();
                    this._flushQueue();
                    break;
                case 'voiceChanged':
                    log(`User selected voice: ${data.voice}`);
                    // Future: this._selectedVoice = data.voice;
                    break;
                case 'log': 
                    log(`[SIDEBAR] ${data.message}`); 
                    break;
            }
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

    private _getHtmlContent(webview: vscode.Webview): string {
        if (!this._bridge) {
            return `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body { 
                            background: var(--vscode-sideBar-background); 
                            color: var(--vscode-sideBar-foreground); 
                            display: flex; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif;
                        }
                    </style>
                </head>
                <body>
                    <div style="text-align: center;">
                        <h3>Connecting to Bridge...</h3>
                        <p style="opacity: 0.6;">Establishing secure local loopback</p>
                    </div>
                </body>
                </html>
            `;
        }

        return this._bridge.getHtml(webview);
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

    public play(text: string) {
        log(`PLAY REQUEST: ${text.substring(0, 30)}...`);
        this._lastText = text;

        // 1. Visual Sync (UI) - Only if visible
        if (this._view && this._view.visible && this._isReady) {
            this._view.webview.postMessage({ command: 'play', text });
        }
        if (this._panel && this._panel.visible && this._isPanelReady) {
            this._panel.webview.postMessage({ command: 'play', text });
        }

        // Bridge Sync
        if (this._bridge) {
            this._bridge.broadcast({ command: 'play', text });
        }
        
        // Editor Sanctuary Sync
        if (MissionControlPanel.currentPanel) {
            MissionControlPanel.currentPanel.postMessage({ command: 'play', text });
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
            
            this._nativeProcess.on('error', (err: Error) => {
                log(`NATIVE ERROR: ${err.message}`);
            });

            this._nativeProcess.on('exit', (code: number | null) => {
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
        this._bridge?.broadcast({ command: 'stop' });
        
        // Editor Sanctuary Sync
        if (MissionControlPanel.currentPanel) {
            MissionControlPanel.currentPanel.postMessage({ command: 'stop' });
        }
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
