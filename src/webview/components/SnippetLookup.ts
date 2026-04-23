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
 * T-033: Accordion model — single expanded session, inline scrollable snippet list.
 */
export class SnippetLookup extends BaseComponent<SnippetLookupElements> {
    private _expandedSessionId: string | null = null;
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

        // Initial request if empty
        const store = WebviewStore.getInstance();
        const state = store.getState();
        if (state && !state.snippetHistory) {
            PlaybackController.getInstance().requestSnippetHistory();
        }
    }

    protected onMount(): void {
        const { container } = this.els;
        if (!container) { return; }

        // [SOVEREIGNTY] Event Delegation for everything in snippet lookup
        this.registerEventListener(container, 'click', (e: Event) => {
            const target = e.target as HTMLElement;

            // 1. Session Card header — toggle accordion
            const sessionCard = target.closest('.snippet-session-card') as HTMLElement;
            if (sessionCard && !target.closest('.snippet-item')) {
                const sessionId = sessionCard.dataset.session || null;
                // Toggle: collapse if already expanded, expand if different
                this._expandedSessionId = this._expandedSessionId === sessionId ? null : sessionId;
                const state = this.store.getState();
                this.renderHistory(this._lastHistory, state.activeSessionId, state.activeDocumentUri);
                return;
            }

            // 2. Snippet Item — load document
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

        let html = '';
        history.forEach((session) => {
            const isActive = session.id === activeSessionId;
            const isExpanded = session.id === this._expandedSessionId;
            const snippetCount = session.snippets.length;

            // Build snippet items for the inline list
            const snippetItemsHtml = (session.snippets || []).map((s: any) => {
                const snippetName = s.name || '';
                const turnMatch = snippetName.match(/Turn_(\d+)$/i) || snippetName.match(/^(\d+)_/);
                const turnLabel = turnMatch ? `T${turnMatch[1].padStart(3, '0')}` : null;
                const timeStr = escapeHtml(new Date(s.timestamp).toLocaleTimeString());

                return `
                    <div class="snippet-item ${s.uri === activeDocumentUri ? 'active-glow' : ''}" data-path="${escapeHtml(s.fsPath)}">
                        <span class="snippet-icon">📝</span>
                        <div class="snippet-info">
                            <div class="snippet-name-row">
                                <span class="snippet-name">${escapeHtml(snippetName)}</span>
                                ${turnLabel ? `<span class="turn-badge">${turnLabel}</span>` : ''}
                                <span class="snippet-date">${timeStr}</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            html += `
                <div class="snippet-session-card ${isActive ? 'is-active' : ''} ${isExpanded ? 'is-expanded' : ''}" data-session="${escapeHtml(session.id)}">
                    <div class="session-header-ui">
                        <span class="session-icon">📁</span>
                        <div class="session-meta">
                            <span class="session-name">${escapeHtml(session.sessionName)}</span>
                            <span class="session-count">${snippetCount} snippet${snippetCount !== 1 ? 's' : ''}</span>
                        </div>
                        ${isActive ? '<span class="active-badge">ACTIVE</span>' : ''}
                        <span class="session-arrow ${isExpanded ? 'is-expanded' : ''}">›</span>
                    </div>
                    <div class="snippet-inline-list">
                        ${snippetItemsHtml}
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    }

    public render(): void {
        // Rendered by subscription
    }
}
