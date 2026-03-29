import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BridgeServer } from './bridgeServer';
import { SpeechProvider } from './speechProvider';
import { findChapterAtLine, findSentenceAtLine, parseChapters } from './documentParser';

let playBarItem: vscode.StatusBarItem;
let pauseBarItem: vscode.StatusBarItem;
let stopBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let logFilePath: string;
let bridgeServer: BridgeServer;

function log(msg: string) {
    const time = new Date().toLocaleTimeString();
    const formatted = `[${time}] ${msg}`;
    if (outputChannel) {outputChannel.appendLine(formatted);}
    if (logFilePath) {
        try { fs.appendFileSync(logFilePath, formatted + '\n'); } catch (e) {}
    }
}

export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Read Aloud Diagnostics');
    outputChannel.show(true); 
    
    logFilePath = path.join(context.extensionPath, 'diagnostics.log');
    try {
        fs.writeFileSync(logFilePath, `--- SESSION START: ${new Date().toLocaleString()} ---\n`);
    } catch (e) {
        console.error('Failed to init log file', e);
    }

    log('--- BOOTING READ ALOUD ENGINE ---');

    // Pre-initialize items for provider
    pauseBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    stopBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);

    const speechProvider = new SpeechProvider(context, log, {
        pause: pauseBarItem,
        stop: stopBarItem
    }, () => syncSelection());
    const config = vscode.workspace.getConfiguration('readAloud');
    const intendedPort = config.get<number>('bridgePort') || 3000;
    
    bridgeServer = new BridgeServer(path.join(context.extensionPath, 'dist', 'media'), log);
    log(`Initializing BridgeServer (Config: 127.0.0.1:${intendedPort})...`);
    
    bridgeServer.start(intendedPort).then(actualPort => {
        log(`BRIDGE ACTIVE on port ${actualPort}`);
        if (actualPort !== intendedPort) {
            vscode.window.showWarningMessage(`Read Aloud: Port ${intendedPort} occupied. Shifting to ${actualPort} to avoid conflict.`);
        }
        speechProvider.setBridge(bridgeServer);
    }).catch(err => {
        log(`BRIDGE FAILURE: ${err}`);
        vscode.window.showErrorMessage(`Read Aloud Bridge failed to start: ${err.message}`);
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'readme-preview-read-aloud.speech-engine',
            speechProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Status Bar Controls
    playBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    playBarItem.command = 'readme-preview-read-aloud.play';
    playBarItem.text = '$(play) Read Aloud';
    playBarItem.show();

    pauseBarItem.command = 'readme-preview-read-aloud.pause';
    pauseBarItem.text = '$(debug-pause)';
    // Provider will manage show/hide

    stopBarItem.command = 'readme-preview-read-aloud.stop';
    stopBarItem.text = '$(debug-stop)';
    // Provider will manage show/hide

    context.subscriptions.push(
        playBarItem, pauseBarItem, stopBarItem,
        
        vscode.commands.registerCommand('readme-preview-read-aloud.show-dashboard', () => {
            vscode.commands.executeCommand('readme-preview-read-aloud.speech-engine.focus');
            speechProvider.refresh();
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

            // Support .md, .markdown, .txt, .log and resolved artifacts (with versions)
            const artifactRegex = /\.(md|markdown|txt|log)(\.resolved)?([.\-].*)?$/i;
            
            if (uri && (artifactRegex.test(uri.path) || artifactRegex.test(uri.fsPath))) {
                speechProvider.setActiveEditor(uri);
            } else {
                // STRICT MODE: If it's a non-supported file (.js, .css) or no file, we CLEAR.
                // This informs the user (and the "LOAD FILE" button) that the current file is not readable.
                speechProvider.setActiveEditor(undefined);
            }
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

    return { 
        bridge: bridgeServer
    };
}

export function deactivate() {
    if (bridgeServer) {
        bridgeServer.stop();
    }
}

