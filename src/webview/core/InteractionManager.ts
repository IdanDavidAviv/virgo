import { MessageClient } from './MessageClient';
import { WebviewStore } from './WebviewStore';
import { OutgoingAction } from '../../common/types';
import { LayoutManager } from './LayoutManager';
import { WebviewAudioEngine } from './WebviewAudioEngine';
import { PlaybackController } from '../playbackController';

/**
 * InteractionManager: Orchestrates global webview events.
 * Handles keyboard shortcuts, link delegation, and focus-aware interaction guards.
 */
export class InteractionManager {
    private static instance: InteractionManager | null = null;
    private client: MessageClient;
    private store: WebviewStore;
    private layout: LayoutManager;
    private boundKeyDown: (e: KeyboardEvent) => void;
    private boundClick: (e: MouseEvent) => void;
    private lastNavTime = 0;
    private readonly NAV_THROTTLE = 100;

    private constructor() {
        this.client = MessageClient.getInstance();
        this.store = WebviewStore.getInstance();
        this.layout = LayoutManager.getInstance();
        this.boundKeyDown = this.handleKeyDown.bind(this);
        this.boundClick = this.handleGlobalClick.bind(this);
    }

    public static getInstance(): InteractionManager {
        if (!InteractionManager.instance) {
            InteractionManager.instance = new InteractionManager();
        }
        return InteractionManager.instance;
    }

    public static resetInstance(): void {
        if (InteractionManager.instance) {
            InteractionManager.instance.unmount();
        }
        InteractionManager.instance = null;
    }

    /**
     * Initializes global event listeners.
     */
    public mount(): void {
        window.addEventListener('keydown', this.boundKeyDown);
        document.addEventListener('click', this.boundClick);
        console.log('[INTERACTION] Global listeners mounted.');
    }

    /**
     * Disposes of global listeners.
     */
    public unmount(): void {
        window.removeEventListener('keydown', this.boundKeyDown);
        document.removeEventListener('click', this.boundClick);
    }

    /**
     * Centralized keyboard shortcut handler.
     */
    private handleKeyDown(event: KeyboardEvent): void {
        // Guard: Don't trigger shortcuts if user is typing in an input or textarea
        const activeElement = document.activeElement;
        const isInputFocused = activeElement instanceof HTMLInputElement || 
                              activeElement instanceof HTMLTextAreaElement ||
                              (activeElement instanceof HTMLElement && activeElement.isContentEditable);

        if (isInputFocused && event.code !== 'Escape') {
            return;
        }

        if (event.repeat) { return; }

        const now = Date.now();
        const isNavKey = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.code);
        
        if (isNavKey && (now - this.lastNavTime < this.NAV_THROTTLE)) {
            event.preventDefault();
            return;
        }

        const playback = PlaybackController.getInstance();

        switch (event.code) {
            case 'Space':
                event.preventDefault();
                playback.togglePlayPause();
                break;

            case 'ArrowLeft':
                event.preventDefault();
                this.lastNavTime = Date.now();
                playback.prevSentence();
                break;

            case 'ArrowRight':
                event.preventDefault();
                this.lastNavTime = Date.now();
                playback.nextSentence();
                break;

            case 'ArrowUp':
                event.preventDefault();
                this.lastNavTime = Date.now();
                playback.prevChapter();
                break;

            case 'ArrowDown':
                event.preventDefault();
                this.lastNavTime = Date.now();
                playback.nextChapter();
                break;

            case 'Escape':
                this.layout.closeOverlays();
                break;
                
            case 'KeyS':
                if (event.altKey || event.ctrlKey) {
                    event.preventDefault();
                    this.layout.showSettings();
                }
                break;
        }

        // [AUTOPLAY] Every keypress counts as a gesture to unlock the audio context
        WebviewAudioEngine.getInstance().ensureAudioContext();
    }

    /**
     * Delegates specific global clicks (like file links) to the extension.
     */
    private handleGlobalClick(event: MouseEvent): void {
        const target = event.target as HTMLElement;
        
        // 1. Legacy Parity: High-Integrity .file-link delegation
        const fileLink = target.closest('.file-link');
        if (fileLink instanceof HTMLElement && fileLink.dataset.uri) {
            event.preventDefault();
            this.client.postAction(OutgoingAction.OPEN_FILE, { uri: fileLink.dataset.uri });
            return;
        }

        // 2. Standard anchor delegation
        const link = target.closest('a');
        if (link instanceof HTMLAnchorElement) {
            const uri = link.dataset.uri || link.getAttribute('href');
            if (uri && (uri.startsWith('file://') || uri.startsWith('vscode-resource:'))) {
                event.preventDefault();
                this.client.postAction(OutgoingAction.OPEN_FILE, { uri: uri });
            }
        }

        // [AUTOPLAY] Every click counts as a gesture to unlock the audio context
        WebviewAudioEngine.getInstance().ensureAudioContext();
    }
}
