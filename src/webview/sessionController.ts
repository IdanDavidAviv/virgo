import { WebviewStore } from './core/WebviewStore';
import { MessageClient } from './core/MessageClient';
import { OutgoingAction } from '../common/types';
import { LayoutManager } from './core/LayoutManager';

/**
 * SessionController: Sovereign manager for Document Sessions and UI Modes.
 * Handles FILE/SNIPPET transitions and loading state orchestration.
 */
export class SessionController {
    private static instance: SessionController;
    private loadingWatchdog: NodeJS.Timeout | null = null;
    private readonly LOADING_TIMEOUT_MS = 2000; // [STABILITY] Grant 2s for file loading

    private constructor() {}

    public static getInstance(): SessionController {
        if (typeof window !== 'undefined') {
            if (!(window as any).__SESSION_CONTROLLER__) {
                (window as any).__SESSION_CONTROLLER__ = new SessionController();
            }
            return (window as any).__SESSION_CONTROLLER__;
        }
        if (!this.instance) {
            this.instance = new SessionController();
        }
        return this.instance;
    }

    public static resetInstance(): void {
        const inst = this.getInstance();
        inst.clearWatchdog();
        if (typeof window !== 'undefined') {
            delete (window as any).__SESSION_CONTROLLER__;
        }
        (this as any).instance = null;
    }

    /**
     * loadDocument() - Orchestrates the loading of a document from the current selection.
     */
    public loadDocument(): void {
        console.log('[SessionController] 📄 loadDocument requested');
        const store = WebviewStore.getInstance();
        const intentId = store.resetPlaybackIntent();
        
        store.updateUIState({ 
            isAwaitingSync: true,
            activeMode: 'FILE'
        });
        
        MessageClient.getInstance().postAction(OutgoingAction.LOAD_DOCUMENT, { intentId });
        this.startWatchdog();
    }

    /**
     * setMode() - Atomic transition between FILE and SNIPPET modes.
     */
    public setMode(mode: 'FILE' | 'SNIPPET'): void {
        console.log(`[SessionController] 🔄 Switching mode to: ${mode}`);
        WebviewStore.getInstance().updateUIState({ activeMode: mode });
    }

    /**
     * loadSnippet() - Orchestrates snippet loading with UI locking.
     */
    public loadSnippet(path: string): void {
        console.log(`[SessionController] 🚀 loadSnippet requested: ${path}`);
        const store = WebviewStore.getInstance();
        const intentId = store.resetPlaybackIntent();
        
        store.updateUIState({ 
            isAwaitingSync: true,
            activeMode: 'SNIPPET'
        });
        
        MessageClient.getInstance().postAction(OutgoingAction.LOAD_SNIPPET, { path, intentId });
        this.startWatchdog();
    }

    /**
     * fetchSnippetHistory() - Refreshes the history list.
     */
    public fetchSnippetHistory(): void {
        MessageClient.getInstance().postAction(OutgoingAction.GET_ALL_SNIPPET_HISTORY);
    }

    /**
     * resetContext() - Snappy UI clearing.
     */
    public resetContext(): void {
        console.log('[SessionController] 🧹 resetContext requested');
        const store = WebviewStore.getInstance();
        const intentId = store.resetPlaybackIntent();
        
        store.updateState({
            activeMode: 'FILE',
            state: {
                ...store.getState()?.state,
                activeDocumentUri: null as any,
                activeFileName: null as any
            } as any
        });
        
        store.updateUIState({ isAwaitingSync: true });

        MessageClient.getInstance().postAction(OutgoingAction.RESET_CONTEXT, { intentId });
        this.startWatchdog();
    }

    private startWatchdog(): void {
        this.clearWatchdog();
        this.loadingWatchdog = setTimeout(() => {
            console.warn('[SessionController] ⏳ Loading Watchdog Fired: Releasing sync lock.');
            WebviewStore.getInstance().updateUIState({ isAwaitingSync: false });
        }, this.LOADING_TIMEOUT_MS);
    }

    private clearWatchdog(): void {
        if (this.loadingWatchdog) {
            clearTimeout(this.loadingWatchdog);
            this.loadingWatchdog = null;
        }
    }
}
