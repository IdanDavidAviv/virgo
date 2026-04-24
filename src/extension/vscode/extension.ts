import * as vscode from 'vscode';
import { PlaybackEngine } from '@core/playbackEngine';
import * as path from 'path';
import * as fs from 'fs';
import { SpeechProvider } from '@vscode/speechProvider';
import { hydrateProtocols } from '@common/protocolHydrator';
import { findChapterAtLine, findSentenceAtLine, parseChapters } from '@core/documentParser';
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
    hydrateProtocols((msg) => log(msg));

    logFilePath = path.join(context.extensionPath, 'diagnostics_agent.log');
    try {
        fs.appendFileSync(logFilePath, `\n\n--- AGENT SESSION START: ${new Date().toLocaleString()} ---\n`);
    } catch (e) {
        console.error('Failed to init log file', e);
    }

    // Standardized log channel with dynamic version detection (Senior Protocol)
    if ('createLogOutputChannel' in (vscode.window as any)) {
        outputChannel = (vscode.window as any).createLogOutputChannel('Read Aloud Diagnostics');
    } else {
        outputChannel = vscode.window.createOutputChannel('Read Aloud Diagnostics');
        log('[SYSTEM] LogOutputChannel API not found. Falling back to standard OutputChannel.');
    }
    outputChannel.show(true); 

    // [Onboarding & Repair] Environment Sanity Check
    const userProfile = process.env.USERPROFILE || process.env.HOME || '';
    const readAloudRoot = path.join(userProfile, '.gemini', 'antigravity', 'read_aloud');
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
            `Read Aloud Extension cannot write to its data directory: ${err.message}. Please check permissions for ${sessionsRoot}.`,
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
    
    // [MP-001 T-015] Dynamic Session Discovery — brain takes priority for new agent sessions,
    // sessions/ is the canonical fallback for established sessions.
    const sessionId = resolveLatestSessionId(sessionsRoot, brainRoot); 

    // [MP-001 T-015] SpeechProvider receives sessionsRoot so McpWatcher and _getSnippetHistory
    // both scan read_aloud/sessions/ — the single canonical location for user-facing session data.
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
            'readme-preview-read-aloud.speech-engine',
            speechProvider,
            
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    context.subscriptions.push(
        mainStatusBarItem,
        
        vscode.commands.registerCommand('readme-preview-read-aloud.show-dashboard', () => {
            log('[CMD_RECV] readme-preview-read-aloud.show-dashboard');
            vscode.commands.executeCommand('readme-preview-read-aloud.speech-engine.focus');
            speechProvider.refresh();
        }),

        vscode.commands.registerCommand('readme-preview-read-aloud.refresh-voices', () => {
            log('[CMD_RECV] readme-preview-read-aloud.refresh-voices');
            speechProvider.refreshVoices();
        }),

        vscode.commands.registerCommand('readme-preview-read-aloud.show-quick-controls', async () => {
            log('[CMD_RECV] readme-preview-read-aloud.show-quick-controls');
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
            log(`[CMD_RECV] readme-preview-read-aloud.play | hasEditor: ${!!editor}`);
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

        vscode.commands.registerCommand('readme-preview-read-aloud.pause', () => {
            log('[CMD_RECV] readme-preview-read-aloud.pause');
            speechProvider.pause();
        }),
        vscode.commands.registerCommand('readme-preview-read-aloud.stop', () => {
            log('[CMD_RECV] readme-preview-read-aloud.stop');
            speechProvider.stop();
        }),
        vscode.commands.registerCommand('readme-preview-read-aloud.start-over', () => {
            log('[CMD_RECV] readme-preview-read-aloud.start-over');
            speechProvider.startOver();
        }),
        vscode.commands.registerCommand('readme-preview-read-aloud.refresh-view', () => {
            log('[CMD_RECV] readme-preview-read-aloud.refresh-view');
            speechProvider.refreshView();
        }),
        vscode.commands.registerCommand('readme-preview-read-aloud.next-chapter', () => {
            log('[CMD_RECV] readme-preview-read-aloud.next-chapter');
            speechProvider.nextChapter();
        }),
        vscode.commands.registerCommand('readme-preview-read-aloud.prev-chapter', () => {
            log('[CMD_RECV] readme-preview-read-aloud.prev-chapter');
            speechProvider.prevChapter();
        }),
        vscode.commands.registerCommand('readme-preview-read-aloud.next-sentence', () => {
            log('[CMD_RECV] readme-preview-read-aloud.next-sentence');
            speechProvider.nextSentence();
        }),
        vscode.commands.registerCommand('readme-preview-read-aloud.prev-sentence', () => {
            log('[CMD_RECV] readme-preview-read-aloud.prev-sentence');
            speechProvider.prevSentence();
        }),


        vscode.commands.registerCommand('readme-preview-read-aloud.read-from-cursor', async () => {
            const editor = vscode.window.activeTextEditor;
            log(`[CMD_RECV] readme-preview-read-aloud.read-from-cursor | hasEditor: ${!!editor}`);
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
            // [T-023] Bridge removed. MCP now runs as an external stdio process (mcp-standalone.js).
            // Reconnect via Gemini settings if needed.
            vscode.window.showInformationMessage('Read Aloud: MCP runs via standalone stdio server. Reconnect via Gemini MCP settings if needed.');
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

