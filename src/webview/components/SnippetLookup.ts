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
    private _selectedSessionId: string | null = null;

    public mount(): void {
        super.mount();

        // 1. Subscribe to snippet history and active session
        this.subscribe((state) => ({
            history: state.snippetHistory || [],
            activeSessionId: state.activeSessionId,
            activeDocumentUri: state.state?.activeDocumentUri
        }), ({ history, activeSessionId, activeDocumentUri }) => {
            this.renderHistory(history, activeSessionId, activeDocumentUri);
        });

        // 2. Initial request if empty
        const store = WebviewStore.getInstance();
        const state = store.getState();
        if (state && !state.snippetHistory) {
            store.requestSnippetHistory();
        }
    }

    private renderHistory(history: any[], activeSessionId?: string, activeDocumentUri?: string | null): void {
        const container = this.els.container;
        if (!container) { return; }

        if (history.length === 0) {
            container.innerHTML = `<div class="snippet-empty">No snippets found in Antigravity Root.</div>`;
            return;
        }

        if (this._selectedSessionId) {
            this.renderSnippetsLayer(history, activeSessionId, activeDocumentUri);
        } else {
            this.renderSessionsLayer(history, activeSessionId);
        }
    }

    private renderSessionsLayer(history: any[], activeSessionId?: string): void {
        let html = '<div class="snippet-layer-sessions">';
        history.forEach((session) => {
            const isActive = session.sessionName === activeSessionId;
            html += `
                <div class="snippet-session-card ${isActive ? 'is-active' : ''}" data-session="${escapeHtml(session.sessionName)}">
                    <div class="session-header-ui">
                        <span class="session-icon">📁</span>
                        <div class="session-meta">
                            <span class="session-name">${escapeHtml(session.sessionName)}</span>
                            <span class="session-count">${session.snippets.length} snippets</span>
                        </div>
                        ${isActive ? '<span class="active-badge">ACTIVE</span>' : ''}
                        <span class="session-arrow">›</span>
                    </div>
                </div>
            `;
        });
        html += '</div>';

        this.els.container.innerHTML = html;

        // Add listeners
        this.els.container.querySelectorAll('.snippet-session-card').forEach(el => {
            (el as HTMLElement).onclick = () => {
                this._selectedSessionId = el.getAttribute('data-session');
                this.renderHistory(history, activeSessionId);
            };
        });
    }

    private renderSnippetsLayer(history: any[], activeSessionId?: string, activeDocumentUri?: string | null): void {
        const session = history.find(s => s.sessionName === this._selectedSessionId);
        if (!session) {
            this._selectedSessionId = null;
            this.renderSessionsLayer(history, activeSessionId);
            return;
        }

        let html = `
            <div class="snippet-layer-snippets">
                <div class="snippet-back-button">
                    <span class="back-icon">←</span> Back to Sessions
                </div>
                <div class="session-title-context">
                    <span class="title-icon">📁</span>
                    <span class="title-text">${escapeHtml(session.sessionName)}</span>
                </div>
                <div class="snippets-list">
                    ${session.snippets.map((s: any) => `
                        <div class="snippet-item ${s.uri === activeDocumentUri ? 'active-glow' : ''}" data-path="${escapeHtml(s.fsPath)}">
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

        this.els.container.innerHTML = html;

        // "Back" Button
        const backBtn = this.els.container.querySelector('.snippet-back-button');
        if (backBtn) {
            (backBtn as HTMLElement).onclick = () => {
                this._selectedSessionId = null;
                // Re-render
                const state = WebviewStore.getInstance().getState();
                this.renderHistory(history, activeSessionId, state?.state?.activeDocumentUri);
            };
        }

        // Snippet Items
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
