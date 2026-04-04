import { BaseComponent } from '../core/BaseComponent';
import { WebviewStore } from '../core/WebviewStore';
import { escapeHtml } from '../utils';

export interface SnippetLookupElements extends Record<string, HTMLElement | null | undefined> {
    container: HTMLElement;
}

/**
 * SnippetLookup: Renders the Antigravity snippet history.
 * Premium DNA: Glassmorphism, smooth accordion transitions.
 */
export class SnippetLookup extends BaseComponent<SnippetLookupElements> {

    public mount(): void {
        super.mount();

        // 1. Subscribe to snippet history
        this.subscribe((state) => state.snippetHistory, (history) => {
            this.renderHistory(history || []);
        });

        // 2. Initial request if empty
        const store = WebviewStore.getInstance();
        const state = store.getState();
        if (state && !state.snippetHistory) {
            store.requestSnippetHistory();
        }
    }

    private renderHistory(history: any[]): void {
        const container = this.els.container;
        if (!container) {
            return;
        }

        if (history.length === 0) {
            this.els.container.innerHTML = `<div class="snippet-empty">No snippets found in Antigravity Root.</div>`;
            return;
        }

        let html = '';
        history.forEach((session, idx) => {
            const isLatest = idx === 0;
            html += `
                <div class="snippet-session ${isLatest ? 'expanded' : ''}">
                    <div class="session-header" onclick="this.parentElement.classList.toggle('expanded')">
                        <span class="session-icon">📁</span>
                        <span class="session-name">${escapeHtml(session.sessionName)}</span>
                        <span class="session-arrow">▾</span>
                    </div>
                    <div class="session-content">
                        ${session.snippets.map((s: any) => `
                            <div class="snippet-item" data-path="${escapeHtml(s.fsPath)}">
                                <span class="snippet-icon">📝</span>
                                <div class="snippet-info">
                                    <span class="snippet-name">${escapeHtml(s.name)}</span>
                                    <span class="snippet-date">${escapeHtml(new Date(s.timestamp).toLocaleTimeString())}</span>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        });

        this.els.container.innerHTML = html;

        // Add listeners
        this.els.container.querySelectorAll('.snippet-item').forEach(el => {
            (el as HTMLElement).onclick = () => {
                const path = el.getAttribute('data-path');
                if (path) {
                    WebviewStore.getInstance().loadSnippet(path);
                }
            };
        });
    }

    public render(): void {
        // Rendered by subscription
    }
}
