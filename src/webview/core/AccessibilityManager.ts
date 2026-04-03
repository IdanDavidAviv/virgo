import { MessageClient } from './MessageClient';
import { WebviewStore } from './WebviewStore';
import { OutgoingAction } from '../../common/types';

/**
 * AccessibilityManager: Restores legacy keyboard shortcut parity (Issue #35)
 * Handles global shortcuts (Space, Arrows) and delegated link clicks.
 */
export class AccessibilityManager {
    private static instance: AccessibilityManager;
    private lastNavTime: number = 0;
    private readonly NAV_THROTTLE = 150; // Slightly higher than legacy for stability

    private constructor() {}

    public static getInstance(): AccessibilityManager {
        if (!AccessibilityManager.instance) {
            AccessibilityManager.instance = new AccessibilityManager();
        }
        return AccessibilityManager.instance;
    }

    public init(): void {
        this.registerKeyboardShortcuts();
        this.registerGlobalClickListeners();
        this.registerErrorBoundaries();
        console.log('[Accessibility] 🎹 Global shortcuts and interactions initialized.');
    }

    private registerKeyboardShortcuts(): void {
        window.addEventListener('keydown', (e) => {
            const activeEl = document.activeElement;
            const isInput = activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement;
            
            // 1. Inputs & Repeat Guard
            if (isInput || e.repeat) { return; }

            const now = Date.now();
            const client = MessageClient.getInstance();
            const store = WebviewStore.getInstance();

            // 2. Navigation Throttling
            const isNavKey = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.code);
            if (isNavKey && (now - this.lastNavTime < this.NAV_THROTTLE)) {
                e.preventDefault();
                return;
            }

            switch (e.code) {
                case 'Space':
                    e.preventDefault();
                    const state = store.getState();
                    if (state?.isPlaying && !state?.isPaused) {
                        client.postAction(OutgoingAction.PAUSE);
                    } else {
                        client.postAction(OutgoingAction.PLAY);
                    }
                    break;

                case 'ArrowRight':
                    e.preventDefault();
                    this.lastNavTime = now;
                    client.postAction(OutgoingAction.NEXT_SENTENCE);
                    break;

                case 'ArrowLeft':
                    e.preventDefault();
                    this.lastNavTime = now;
                    client.postAction(OutgoingAction.PREV_SENTENCE);
                    break;

                case 'ArrowDown':
                    e.preventDefault();
                    this.lastNavTime = now;
                    client.postAction(OutgoingAction.NEXT_CHAPTER);
                    break;

                case 'ArrowUp':
                    e.preventDefault();
                    this.lastNavTime = now;
                    client.postAction(OutgoingAction.PREV_CHAPTER);
                    break;
            }
        });
    }

    private registerGlobalClickListeners(): void {
        document.body.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            const link = target.closest('.file-link') as HTMLElement;
            
            if (link && link.dataset.uri) {
                e.preventDefault();
                MessageClient.getInstance().postAction(OutgoingAction.OPEN_FILE, { 
                    uri: link.dataset.uri 
                });
            }
        });
    }

    private registerErrorBoundaries(): void {
        window.onerror = (msg, url, line, col, error) => {
            const detail = `[WEBVIEW_CRITICAL] ${msg} @ ${line}:${col}`;
            console.error(detail, error);
            MessageClient.getInstance().postAction(OutgoingAction.LOG, detail);
        };
    }
}
