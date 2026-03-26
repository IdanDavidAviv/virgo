import * as vscode from 'vscode';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    console.log('Readme Preview Read Aloud is now active!');

    const speechManager = new SpeechManager(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('readme-preview-read-aloud.play', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'markdown') {
                const text = stripMarkdown(editor.document.getText());
                speechManager.play(text);
            }
        }),
        vscode.commands.registerCommand('readme-preview-read-aloud.pause', () => {
            speechManager.pause();
        }),
        vscode.commands.registerCommand('readme-preview-read-aloud.stop', () => {
            speechManager.stop();
        })
    );
}

class SpeechManager {
    private _panel: vscode.WebviewPanel | undefined;
    private _context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
    }

    private _ensurePanel() {
        if (this._panel) return;

        this._panel = vscode.window.createWebviewPanel(
            'readmeTTS',
            'TTS Engine',
            vscode.ViewColumn.Two, // We hide it by positioning it elsewhere or using visibility
            {
                enableScripts: true,
                localResourceRoots: [this._context.extensionUri]
            }
        );

        const htmlPath = vscode.Uri.file(path.join(this._context.extensionPath, 'media', 'speechEngine.html'));
        this._panel.webview.html = this._getHtmlContent(htmlPath);
        
        // Dispose when panel is closed
        this._panel.onDidDispose(() => {
            this._panel = undefined;
        });

        // Hide the panel from the user's focus
        // Note: VS Code doesn't have a truly 'hidden' panel, but we can minimize impact.
    }

    private _getHtmlContent(uri: vscode.Uri): string {
        const fs = require('fs');
        const content = fs.readFileSync(uri.fsPath, 'utf8');
        return content;
    }

    play(text: string) {
        this._ensurePanel();
        this._panel?.webview.postMessage({ command: 'play', text });
    }

    pause() {
        this._panel?.webview.postMessage({ command: 'pause' });
    }

    stop() {
        this._panel?.webview.postMessage({ command: 'stop' });
    }
}

function stripMarkdown(md: string): string {
    return md
        .replace(/^#+\s+/gm, '') // headings
        .replace(/\*\*|__/g, '') // bold
        .replace(/\*|_/g, '') // italic
        .replace(/!\[.*?\]\(.*?\)/g, '') // images
        .replace(/\[(.*?)\]\(.*?\)/g, '$1') // links
        .replace(/`{3,}[\s\S]*?`{3,}/g, '') // code blocks
        .replace(/`(.+?)`/g, '$1') // inline code
        .replace(/^\s*[-*+]\s+/gm, '') // list items
        .replace(/^\s*>\s+/gm, '') // blockquotes
        .replace(/<[^>]*>/g, '') // html tags
        .trim();
}

export function deactivate() {}
