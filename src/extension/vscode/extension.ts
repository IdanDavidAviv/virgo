import * as vscode from 'vscode';
import { PlaybackEngine } from '@core/playbackEngine';
import * as path from 'path';
import * as fs from 'fs';
import { SpeechProvider } from '@vscode/speechProvider';
import { hydrateProtocols } from '@common/protocolHydrator';
import { findChapterAtLine, findSentenceAtLine, parseChapters } from '@core/documentParser';
import { McpBridge } from '../mcp/mcpBridge';

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

function resolveLatestSessionId(antigravityRoot: string, brainRoot?: string): string {
    const searchDirs = [antigravityRoot];
    if (brainRoot) { searchDirs.unshift(brainRoot); } // Brain is higher priority for "New" sessions

    for (const root of searchDirs) {
        if (!fs.existsSync(root)) { continue; }
        try {
            const sessions = fs.readdirSync(root)
                .filter(f => fs.statSync(path.join(root, f)).isDirectory())
                .map(f => ({ id: f, mtime: fs.statSync(path.join(root, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            
            if (sessions.length > 0) { return sessions[0].id; }
        } catch (e) {}
    }
    return 'default-session';
}

export async function activate(context: vscode.ExtensionContext) {
    // [Self-Healing Protocol] 100% Zero-Friction DNA Sync
    hydrateProtocols((msg) => log(msg));

    // Standardized log channel with dynamic version detection (Senior Protocol)
    if ('createLogOutputChannel' in (vscode.window as any)) {
        outputChannel = (vscode.window as any).createLogOutputChannel('Read Aloud Diagnostics');
    } else {
        outputChannel = vscode.window.createOutputChannel('Read Aloud Diagnostics');
        log('[SYSTEM] LogOutputChannel API not found. Falling back to standard OutputChannel.');
    }
    outputChannel.show(true); 
    
    logFilePath = path.join(context.extensionPath, 'diagnostics.log');
    try {
        fs.writeFileSync(logFilePath, `--- SESSION START: ${new Date().toLocaleString()} ---\n`);
    } catch (e) {
        console.error('Failed to init log file', e);
    }

    // [Onboarding & Repair] Environment Sanity Check
    const userProfile = process.env.USERPROFILE || process.env.HOME || '';
    const antigravityRoot = path.join(userProfile, '.gemini', 'antigravity', 'read_aloud');
    try {
        if (!fs.existsSync(antigravityRoot)) {
            fs.mkdirSync(antigravityRoot, { recursive: true });
        }
        // Test write permission
        const testFile = path.join(antigravityRoot, '.write_test');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
    } catch (err: any) {
        vscode.window.showErrorMessage(
            `Read Aloud Extension cannot write to its data directory: ${err.message}. Please check permissions for ${antigravityRoot}.`,
            'Repair Permissions'
        ).then(selection => {
            if (selection === 'Repair Permissions') {
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/IdanDavidAviv/readme-preview-read-aloud/wiki/Troubleshooting#permissions'));
            }
        });
    }

    log('--- BOOTING READ ALOUD ENGINE ---');

    // Single Consolidated Status Bar Item
    mainStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    mainStatusBarItem.command = 'readme-preview-read-aloud.show-quick-controls';
    mainStatusBarItem.text = '$(unmute) Read Aloud';
    mainStatusBarItem.tooltip = 'Click for Read Aloud Controls';
    mainStatusBarItem.show();

    // Standard path for high-integrity agent memory
    const brainRoot = path.join(userProfile, '.gemini', 'antigravity', 'brain');
    
    // Dynamic Session Discovery (Check brain first for real-time parity)
    const sessionId = resolveLatestSessionId(antigravityRoot, brainRoot); 
    const persistencePath = path.join(antigravityRoot, sessionId);

    speechProvider = new SpeechProvider(context, log, mainStatusBarItem, brainRoot, sessionId, () => syncSelection());
    log('--- PORTLESS SYNC ACTIVE (Filesystem Watcher) ---');
    log(`[ANTIGRAVITY] Session: ${sessionId}`);
    

    // --- MCP BRIDGE (Agentic Integration) ---
    const sessionPersistencePath = path.join(brainRoot, sessionId);
    const mcpBridge = new McpBridge(sessionPersistencePath, log, (outputChannel as any).logUri, logFilePath, context.extensionMode);
    context.subscriptions.push(mcpBridge);
    mcpBridge.start().catch((err: any) => {
        log(`[MCP_ERROR] Bridge failed to start: ${err.message}`);
    });

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
                mcpBridge.pivotSession(newSessionId);
            }, 500);
        }
    });
    context.subscriptions.push(brainWatcher);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'readme-preview-read-aloud.speech-engine',
            speechProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    context.subscriptions.push(
        mainStatusBarItem,
        
        vscode.commands.registerCommand('readme-preview-read-aloud.show-dashboard', () => {
            vscode.commands.executeCommand('readme-preview-read-aloud.speech-engine.focus');
            speechProvider.refresh();
        }),

        vscode.commands.registerCommand('readme-preview-read-aloud.show-quick-controls', async () => {
            const isPlaying = speechProvider.isPlaying();
            const isPaused = speechProvider.isPaused();

            if (!isPlaying) {
                // If not playing, just trigger play or show dashboard
                const action = await vscode.window.showQuickPick([
                    { label: '$(play) Start Reading', id: 'play' },
                    { label: '$(layout-sidebar-right) Open Dashboard', id: 'dashboard' }
                ], { placeHolder: 'Read Aloud Mission Control' });

                if (action?.id === 'play') { vscode.commands.executeCommand('readme-preview-read-aloud.play'); }
                if (action?.id === 'dashboard') { vscode.commands.executeCommand('readme-preview-read-aloud.show-dashboard'); }
                return;
            }

            const items = [
                { label: isPaused ? '$(play) Resume' : '$(debug-pause) Pause', id: 'toggle' },
                { label: '$(debug-stop) Stop Playback', id: 'stop' },
                { label: '$(layout-sidebar-right) Open Dashboard', id: 'dashboard' }
            ];

            const selection = await vscode.window.showQuickPick(items, {
                placeHolder: 'Read Aloud Controls'
            });

            if (selection?.id === 'toggle') {
                if (isPaused) { speechProvider.continue(); }
                else { speechProvider.pause(); }
            } else if (selection?.id === 'stop') {
                speechProvider.stop();
            } else if (selection?.id === 'dashboard') {
                vscode.commands.executeCommand('readme-preview-read-aloud.show-dashboard');
            }
        }),

        vscode.commands.registerCommand('readme-preview-read-aloud.play', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const text = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
                speechProvider.play(text, 0, editor.document.fileName);
            } else {
                vscode.window.showWarningMessage('No text found to read.');
            }
        }),

        vscode.commands.registerCommand('readme-preview-read-aloud.pause', () => speechProvider.pause()),
        vscode.commands.registerCommand('readme-preview-read-aloud.stop', () => speechProvider.stop()),
        vscode.commands.registerCommand('readme-preview-read-aloud.start-over', () => speechProvider.startOver()),
        vscode.commands.registerCommand('readme-preview-read-aloud.refresh-view', () => speechProvider.refreshView()),
        vscode.commands.registerCommand('readme-preview-read-aloud.next-chapter', () => speechProvider.nextChapter()),
        vscode.commands.registerCommand('readme-preview-read-aloud.prev-chapter', () => speechProvider.prevChapter()),
        vscode.commands.registerCommand('readme-preview-read-aloud.next-sentence', () => speechProvider.nextSentence()),
        vscode.commands.registerCommand('readme-preview-read-aloud.prev-sentence', () => speechProvider.prevSentence()),


        vscode.commands.registerCommand('readme-preview-read-aloud.read-from-cursor', async () => {
            const editor = vscode.window.activeTextEditor;
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

        vscode.commands.registerCommand('readme-preview-read-aloud.restart-mcp', async () => {
            log('[MCP] Manual bridge reconstruction requested.');
            try {
                await mcpBridge.reinitialize();
                vscode.window.showInformationMessage('Read Aloud: MCP Bridge Restarted Successfully.');
            } catch (err: any) {
                log(`[MCP_ERROR] Restart failed: ${err.message}`);
                vscode.window.showErrorMessage(`Read Aloud: MCP Bridge Restart Failed: ${err.message}`);
            }
        }),
        
        vscode.commands.registerCommand('readme-preview-read-aloud.restart-extension', async () => {
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
                // Fallback to visible editors if tab input yields nothing
                if (!uri && vscode.window.visibleTextEditors.length > 0) {
                    uri = vscode.window.visibleTextEditors[0].document.uri;
                }
            }

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

