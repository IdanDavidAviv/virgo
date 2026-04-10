import { BaseComponent } from '../core/BaseComponent';
import { WebviewStore, StoreState } from '../core/WebviewStore';
import { PlaybackController } from '../playbackController';
import { escapeHtml } from '../utils';
import { SnippetSession, SnippetEntry } from '../../common/types';

export interface SnippetLookupElements extends Record<string, HTMLElement | null | undefined> {
    container: HTMLElement;
}

/**
 * SnippetLookup: Renders the Antigravity snippet history.
 * Premium DNA: Glassmorphism, smooth accordion transitions.
 */
export class SnippetLookup extends BaseComponent<SnippetLookupElements> {
    private _selectedSessionId: string | null = null;
    private _lastHistory: any[] = [];

    constructor(elements: SnippetLookupElements) {
        super(elements);

        const update = () => {
            const state = this.store.getState();
            const history = state.snippetHistory || [];
            const activeSessionId = state.activeSessionId;
            const activeDocumentUri = state.activeDocumentUri;

            // [PRIVACY_SHIELD] Ensure 'brain' paths never leak to UI and limit to 10 most recent sessions
            const filteredHistory = history
                .filter((s: SnippetSession) => s && s.id && !s.id.toLowerCase().includes('brain'))
                .slice(0, 10) // [SSOT] Limit to 10 most recent non-brain sessions
                .map((s: SnippetSession) => ({
                    ...s,
                    snippets: (s.snippets || []).filter((sn: SnippetEntry) => sn && sn.fsPath && !sn.fsPath.toLowerCase().includes('brain'))
                }));
            this._lastHistory = filteredHistory;
            this.renderHistory(filteredHistory, activeSessionId, activeDocumentUri);
        };

        this.subscribe((state) => state.snippetHistory, update);
        this.subscribe((state) => state.activeSessionId, update);
        this.subscribe((state) => state.activeDocumentUri, update);

        // 2. Initial request if empty
        const store = WebviewStore.getInstance();
        const state = store.getState();
        if (state && !state.snippetHistory) {
            PlaybackController.getInstance().requestSnippetHistory();
        }
    }

    protected onMount(): void {
        const { container } = this.els;
        if (!container) {return;}

        // [SOVEREIGNTY] Event Delegation for everything in snippet lookup
        this.registerEventListener(container, 'click', (e: Event) => {
            const target = e.target as HTMLElement;

            // 1. Back button
            if (target.closest('.snippet-back-button')) {
                this._selectedSessionId = null;
                const state = this.store.getState();
                this.renderHistory(this._lastHistory, state.activeSessionId, state.activeDocumentUri);
                return;
            }

            // 2. Session Card
            const sessionCard = target.closest('.snippet-session-card') as HTMLElement;
            if (sessionCard) {
                this._selectedSessionId = sessionCard.dataset.session || null;
                const state = this.store.getState();
                this.renderHistory(this._lastHistory, state.activeSessionId, state.activeDocumentUri);
                return;
            }

            // 3. Snippet Item
            const snippetItem = target.closest('.snippet-item') as HTMLElement;
            if (snippetItem) {
                const path = snippetItem.dataset.path;
                if (path) {
                    PlaybackController.getInstance().loadSnippet(path);
                }
                return;
            }
        });
    }

    private renderHistory(history: any[], activeSessionId?: string, activeDocumentUri?: string | null): void {
        const container = this.els.container;
        if (!container) { return; }

        if (history.length === 0) {
            const state = this.store.getState();
            const sessionId = state.activeSessionId ? state.activeSessionId.split('-')[0] + '...' : 'current';
            container.innerHTML = `
                <div class="snippet-empty-container">
                    <div class="snippet-empty-icon">🛰️</div>
                    <div class="snippet-empty">No injected snippets found.</div>
                    <div class="snippet-empty-hint">
                        Snippets appear here when the MCP agent injects content into this session.
                        <br/>Session: <code>${sessionId}</code>
                    </div>
                </div>
            `;
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
            const isActive = session.id === activeSessionId;
            html += `
                <div class="snippet-session-card ${isActive ? 'is-active' : ''}" data-session="${escapeHtml(session.id)}">
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
    }

    private renderSnippetsLayer(history: any[], activeSessionId?: string, activeDocumentUri?: string | null): void {
        const session = history.find(s => s.id === this._selectedSessionId);
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
                    ${(session.snippets || []).map((s: any) => {
                        const turnMatch = s.name.match(/Turn_(\d+)$/i) || s.name.match(/^(\d+)_/);
                        const turnLabel = turnMatch ? `T${turnMatch[1].padStart(3, '0')}` : null;

                        return `
                            <div class="snippet-item ${s.uri === activeDocumentUri ? 'active-glow' : ''}" data-path="${escapeHtml(s.fsPath)}">
                                <span class="snippet-icon">📝</span>
                                <div class="snippet-info">
                                    <div class="snippet-name-row">
                                        <span class="snippet-name">${escapeHtml(s.name)}</span>
                                        ${turnLabel ? `<span class="turn-badge">${turnLabel}</span>` : ''}
                                    </div>
                                    <span class="snippet-date">${escapeHtml(new Date(s.timestamp).toLocaleTimeString())}</span>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;

        this.els.container.innerHTML = html;
    }

    public render(): void {
        // Rendered by subscription
    }
}
