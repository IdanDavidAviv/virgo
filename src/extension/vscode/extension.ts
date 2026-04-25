import * as vscode from 'vscode';
import { PlaybackEngine } from '@core/playbackEngine';
import * as path from 'path';
import * as fs from 'fs';
import { SpeechProvider } from '@vscode/speechProvider';
import { hydrateProtocols } from '@common/protocolHydrator';
import { findChapterAtLine, findSentenceAtLine, parseChapters } from '@core/documentParser';
import { McpConfigurator } from '../mcp/mcpConfigurator';
// [T-023] McpBridge removed — MCP now runs via dist/mcp-standalone.js (stdio, no HTTP).

let mainStatusBarItem: vscode.StatusBarItem;
let outputChannel: any; // Using any to support LogOutputChannel on systems with older types
let logFilePath: string;
let speechProvider: SpeechProvider;

function log(msg: string) {
    const time = new Date().toLocaleTimeString();
    const formatted = `[${time}] ${msg}`;
    if (outputChannel) {outputChannel.appendLine(formatted);}
    if (logFilePath) {
        try { fs.appendFileSync(logFilePath, formatted + '\n'); } catch (e) {}
    }
}

function resolveLatestSessionId(readAloudRoot: string, brainRoot?: string): string {
    const searchDirs = [readAloudRoot];
    if (brainRoot) { searchDirs.unshift(brainRoot); } // Brain is higher priority for "New" sessions

    // [T-038] VS Code internal temp dirs that must never be treated as agent sessions
    const EXCLUDED_SESSION_DIRS = new Set(['tempmediaStorage', '.write_test']);

    for (const root of searchDirs) {
        if (!fs.existsSync(root)) { continue; }
        try {
            const sessions = fs.readdirSync(root)
                .filter(f => !EXCLUDED_SESSION_DIRS.has(f) && fs.statSync(path.join(root, f)).isDirectory())
                .map(f => ({ id: f, mtime: fs.statSync(path.join(root, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            
            if (sessions.length > 0) { return sessions[0].id; }
        } catch (e) {}
    }
    return 'default-session';
}

export async function activate(context: vscode.ExtensionContext) {
    // [Self-Healing Protocol] 100% Zero-Friction DNA Sync
    const virgoRootName = vscode.workspace.getConfiguration('virgo.system').get<string>('rootDirectory', 'virgo');
    hydrateProtocols((msg) => log(msg), virgoRootName);

    logFilePath = path.join(context.extensionPath, 'diagnostics_agent.log');
    try {
        fs.appendFileSync(logFilePath, `\n\n--- AGENT SESSION START: ${new Date().toLocaleString()} ---\n`);
    } catch (e) {
        console.error('Failed to init log file', e);
    }

    // Standardized log channel with dynamic version detection (Senior Protocol)
    if ('createLogOutputChannel' in (vscode.window as any)) {
        outputChannel = (vscode.window as any).createLogOutputChannel('Virgo Diagnostics');
    } else {
        outputChannel = vscode.window.createOutputChannel('Virgo Diagnostics');
        log('[SYSTEM] LogOutputChannel API not found. Falling back to standard OutputChannel.');
    }
    outputChannel.show(true); 

    // [Onboarding & Repair] Environment Sanity Check
    const userProfile = process.env.USERPROFILE || process.env.HOME || '';
    const readAloudRoot = path.join(userProfile, '.gemini', 'antigravity', virgoRootName);
    // [MP-001 T-015] Canonical session root — all session data lives under sessions/<id>/
    const sessionsRoot = path.join(readAloudRoot, 'sessions');
    try {
        if (!fs.existsSync(sessionsRoot)) {
            fs.mkdirSync(sessionsRoot, { recursive: true });
        }
        // Test write permission on the canonical sessions root
        const testFile = path.join(sessionsRoot, '.write_test');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
    } catch (err: any) {
        vscode.window.showErrorMessage(
            `Virgo cannot write to its data directory: ${err.message}. Please check permissions for ${sessionsRoot}.`,
            'Repair Permissions'
        ).then(selection => {
            if (selection === 'Repair Permissions') {
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/IdanDavidAviv/virgo/wiki/Troubleshooting#permissions'));

            }
        });
    }

    log('--- BOOTING VIRGO ENGINE ---');

    // Single Consolidated Status Bar Item
    mainStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    mainStatusBarItem.command = 'virgo.show-quick-controls';
    mainStatusBarItem.text = '$(unmute) Virgo';
    mainStatusBarItem.tooltip = 'Click for Virgo Controls';
    mainStatusBarItem.show();

    // Standard path for high-integrity agent memory
    const brainRoot = path.join(userProfile, '.gemini', 'antigravity', 'brain');
    
    // [MP-001 T-015] Dynamic Session Discovery — brain takes priority for new agent sessions,
    // sessions/ is the canonical fallback for established sessions.
    const sessionId = resolveLatestSessionId(sessionsRoot, brainRoot); 

    // [MP-001 T-015] SpeechProvider receives sessionsRoot so McpWatcher and _getSnippetHistory
    // both scan virgo/sessions/ — the single canonical location for user-facing session data.
    speechProvider = new SpeechProvider(context, log, mainStatusBarItem, sessionsRoot, sessionId, () => syncSelection());
    log('--- PORTLESS SYNC ACTIVE (Filesystem Watcher) ---');
    log(`[ANTIGRAVITY] Session: ${sessionId} | Root: ${sessionsRoot}`);
    

    // --- MCP (Agentic Integration) ---
    // [T-023] McpBridge removed. MCP runs via dist/mcp-standalone.js (pure stdio).
    // Snippet injection detected by McpWatcher (fs.watch on sessions/) → loadSnippet → play.
    log('[MCP] Standalone stdio server active. McpWatcher handles injection events.');

    // --- BRAIN SENSITIVITY PROTOCOL ---
    // Monitor for new session directories in the brain root
    const brainWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(brainRoot, '*')
    );

    brainWatcher.onDidCreate(async (uri) => {
        const stats = await vscode.workspace.fs.stat(uri);
        if (stats.type === vscode.FileType.Directory) {
            const newSessionId = path.basename(uri.fsPath);
            log(`[SYNC] PIVOTING: New session detected in brain: ${newSessionId}`);
            
            // Wait 500ms to ensure the agent has finished directory setup
            setTimeout(() => {
                speechProvider.pivotSession(newSessionId);
            }, 500);
        }
    });
    
    context.subscriptions.push(brainWatcher);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'virgo.speech-engine',
            speechProvider,
            
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    context.subscriptions.push(
        mainStatusBarItem,
        
        vscode.commands.registerCommand('virgo.show-dashboard', () => {
            log('[CMD_RECV] virgo.show-dashboard');
            vscode.commands.executeCommand('virgo.speech-engine.focus');
            speechProvider.refresh();
        }),

        vscode.commands.registerCommand('virgo.refresh-voices', () => {
            log('[CMD_RECV] virgo.refresh-voices');
            speechProvider.refreshVoices();
        }),

        vscode.commands.registerCommand('virgo.show-quick-controls', async () => {
            log('[CMD_RECV] virgo.show-quick-controls');
            const isPlaying = speechProvider.isPlaying();
            const isPaused = speechProvider.isPaused();

            if (!isPlaying) {
                // If not playing, just trigger play or show dashboard
                const action = await vscode.window.showQuickPick([
                    { label: '$(play) Start Reading', id: 'play' },
                    { label: '$(layout-sidebar-right) Open Dashboard', id: 'dashboard' }
                ], { placeHolder: 'Virgo Mission Control' });

                if (action?.id === 'play') { vscode.commands.executeCommand('virgo.play'); }
                if (action?.id === 'dashboard') { vscode.commands.executeCommand('virgo.show-dashboard'); }
                return;
            }

            const items = [
                { label: isPaused ? '$(play) Resume' : '$(debug-pause) Pause', id: 'toggle' },
                { label: '$(debug-stop) Stop Playback', id: 'stop' },
                { label: '$(layout-sidebar-right) Open Dashboard', id: 'dashboard' }
            ];

            const selection = await vscode.window.showQuickPick(items, {
                placeHolder: 'Virgo Controls'
            });

            if (selection?.id === 'toggle') {
                if (isPaused) { speechProvider.continue(); }
                else { speechProvider.pause(); }
            } else if (selection?.id === 'stop') {
                speechProvider.stop();
            } else if (selection?.id === 'dashboard') {
                vscode.commands.executeCommand('virgo.show-dashboard');
            }
        }),

        vscode.commands.registerCommand('virgo.play', async () => {
            const editor = vscode.window.activeTextEditor;
            log(`[CMD_RECV] virgo.play | hasEditor: ${!!editor}`);
            if (editor) {
                const text = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
                speechProvider.play(text, 0, editor.document.fileName);
            } else if (speechProvider.isHydrated()) {
                // [v2.3.2] Fallback: If no editor focus but UI has content, play/resume current state.
                speechProvider.continue();
            } else {
                vscode.window.showWarningMessage('No text found to read.');
            }
        }),

        vscode.commands.registerCommand('virgo.pause', () => {
            log('[CMD_RECV] virgo.pause');
            speechProvider.pause();
        }),
        vscode.commands.registerCommand('virgo.stop', () => {
            log('[CMD_RECV] virgo.stop');
            speechProvider.stop();
        }),
        vscode.commands.registerCommand('virgo.start-over', () => {
            log('[CMD_RECV] virgo.start-over');
            speechProvider.startOver();
        }),
        vscode.commands.registerCommand('virgo.refresh-view', () => {
            log('[CMD_RECV] virgo.refresh-view');
            speechProvider.refreshView();
        }),
        vscode.commands.registerCommand('virgo.next-chapter', () => {
            log('[CMD_RECV] virgo.next-chapter');
            speechProvider.nextChapter();
        }),
        vscode.commands.registerCommand('virgo.prev-chapter', () => {
            log('[CMD_RECV] virgo.prev-chapter');
            speechProvider.prevChapter();
        }),
        vscode.commands.registerCommand('virgo.next-sentence', () => {
            log('[CMD_RECV] virgo.next-sentence');
            speechProvider.nextSentence();
        }),
        vscode.commands.registerCommand('virgo.prev-sentence', () => {
            log('[CMD_RECV] virgo.prev-sentence');
            speechProvider.prevSentence();
        }),


        vscode.commands.registerCommand('virgo.read-from-cursor', async () => {
            const editor = vscode.window.activeTextEditor;
            log(`[CMD_RECV] virgo.read-from-cursor | hasEditor: ${!!editor}`);
            if (!editor) {return;}
            const text = editor.document.getText();
            const cursorLine = editor.selection.active.line;
            
            const chapters = parseChapters(text);
            const targetIndex = findChapterAtLine(chapters, cursorLine);
            
            if (targetIndex !== -1) {
                const chapter = chapters[targetIndex];
                const sentenceIndex = findSentenceAtLine(chapter, cursorLine);
                speechProvider.play(text, targetIndex, editor.document.fileName);
                // Force jump to exact sentence if needed
                if (sentenceIndex > 0) {
                    setTimeout(() => speechProvider.jumpToSentence(sentenceIndex), 300);
                }
            } else {
                speechProvider.play(text, 0, editor.document.fileName);
            }
        }),

        vscode.commands.registerCommand('virgo.manageMcp', async () => {
            log('[CMD_RECV] virgo.manageMcp');
            
            const agents = McpConfigurator.getAvailableAgents();
            const items: vscode.QuickPickItem[] = [];

            agents.forEach(agent => {
                if (agent.exists) {
                    items.push({
                        label: agent.hasVirgo ? `$(check) Update ${agent.name}` : `$(add) Install to ${agent.name}`,
                        description: agent.path,
                        // @ts-ignore: Custom property
                        agent: agent
                    });
                }
            });

            items.push({ label: '$(folder-opened) Select Custom Path...', description: 'Select an MCP settings JSON file' });
            items.push({ label: '$(clippy) Copy to Clipboard', description: 'Copy the raw JSON block' });

            const selection = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select where to install the Virgo MCP Server'
            });

            if (!selection) {return;}

            let targetPath: string | undefined;
            const customSelectionId = selection.label.includes('Copy to Clipboard') ? 'clipboard' : selection.label.includes('Custom Path') ? 'custom' : 'agent';

            if (customSelectionId === 'clipboard') {
                const scriptPath = path.join(context.extensionPath, 'dist', 'mcp-standalone.js').replace(/\\/g, '/');
                const currentRoot = vscode.workspace.getConfiguration('virgo.system').get<string>('rootDirectory', 'virgo');
                const snippet = JSON.stringify({
                    "mcpServers": {
                        "virgo": {
                            "command": "npx",
                            "args": ["-y", "virgo-mcp@latest"],
                            "env": {
                                "VIRGO_ROOT": currentRoot
                            }
                        }
                    }
                }, null, 2);
                vscode.env.clipboard.writeText(snippet);
                vscode.window.showInformationMessage('Virgo MCP configuration copied to clipboard.');
                return;
            } else if (customSelectionId === 'custom') {
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: { 'JSON': ['json'] }
                });
                if (uris && uris.length > 0) {
                    targetPath = uris[0].fsPath;
                } else {
                    return;
                }
            } else if ((selection as any).agent) {
                targetPath = (selection as any).agent.path;
            }

            if (targetPath) {
                const currentRoot = vscode.workspace.getConfiguration('virgo.system').get<string>('rootDirectory', 'virgo');
                
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Installing Virgo MCP Server...",
                    cancellable: false
                }, async (progress) => {
                    return new Promise<void>((resolve) => {
                        const { exec } = require('child_process');
                        exec('npm install -g virgo-mcp@latest', async (error: any, stdout: string, stderr: string) => {
                            if (error) {
                                console.error('[Virgo MCP] Failed to install npm package:', error.message || stderr);
                                
                                const errMsg = (error.message || '').toLowerCase();
                                if (errMsg.includes('is not recognized') || errMsg.includes('not found') || errMsg.includes('enoent')) {
                                    vscode.window.showErrorMessage(
                                        'Node.js and npm are required to use the Virgo MCP Server. Please install Node.js.', 
                                        'Download Node.js'
                                    ).then(selection => {
                                        if (selection === 'Download Node.js') {
                                            vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/'));
                                        }
                                    });
                                    resolve();
                                    return; // Abort configuration since npx won't work either
                                }
                                // We still proceed with injection even if global install fails for other reasons (e.g. permission)
                            }
                            
                            const success = await McpConfigurator.injectConfiguration(targetPath!, context.extensionPath, currentRoot);
                            if (success) {
                                vscode.window.showInformationMessage(`Successfully installed Virgo MCP to ${path.basename(targetPath!)}`);
                                speechProvider.refreshMcpStatus();
                            } else {
                                vscode.window.showErrorMessage(`Failed to install Virgo MCP to ${path.basename(targetPath!)}. See logs for details.`);
                            }
                            resolve();
                        });
                    });
                });
            }
        }),

        vscode.commands.registerCommand('virgo.restart-mcp', async () => {
            // [T-023] Bridge removed. MCP now runs as an external stdio process (mcp-standalone.js).
            // Reconnect via Gemini settings if needed.
            vscode.window.showInformationMessage('Virgo: MCP runs via standalone stdio server. Reconnect via Gemini MCP settings if needed.');
        }),
        
        vscode.commands.registerCommand('virgo.restart-extension', async () => {
            log('[EXTENSION] Full extension restart requested (Reloading Window).');
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        })
    );

    // --- Selection Sync Multiplexer ---
    // This ensures focus is updated reliably across multiple VS Code events without races.
    let syncTimer: NodeJS.Timeout | undefined;
    function syncSelection() {
        if (syncTimer) { clearTimeout(syncTimer); }
        syncTimer = setTimeout(async () => {
            let editor = vscode.window.activeTextEditor;
            let uri: vscode.Uri | undefined;

            if (editor) {
                uri = editor.document.uri;
            } else {
                // GHOST FOCUS: Sidebar is active, use the last active tab in the editor groups.
                const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
                if (tab) {
                    const input = tab.input as any;
                    uri = input?.uri || input?.resource || (input?.sourceUri && vscode.Uri.parse(input.sourceUri));
                }
            }
            
            log(`[SYNC_SEL] Resolved | uri=${uri?.fsPath ?? 'NONE'} | scheme=${uri?.scheme ?? 'NONE'}`);
            
            // Always call setActiveEditor so the Focused File slot is updated,
            // even for non-supported files.
            speechProvider.setActiveEditor(uri);
        }, 100);
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => syncSelection()),
        vscode.window.onDidChangeVisibleTextEditors(() => syncSelection()),
        vscode.window.tabGroups.onDidChangeTabs(() => syncSelection()),
        vscode.window.tabGroups.onDidChangeTabGroups(() => syncSelection())
    );

    // Initial trigger
    syncSelection();

    return {};
}

export function deactivate() {
    if (speechProvider) {
        speechProvider.dispose();
    }
}

