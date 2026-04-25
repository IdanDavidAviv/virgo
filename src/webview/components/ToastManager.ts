/**
 * ToastManager: Simple logic for managing dashboard toast notifications.
 * Extracted from legacy dashboard.js to provide a clean API for components.
 */
export class ToastManager {
    private static container: HTMLElement | null = null;
    private static activeTimeouts: Set<NodeJS.Timeout> = new Set();

    /**
     * Set the container element for toasts.
     */
    public static setContainer(el: HTMLElement): void {
        this.container = el;
    }

    /**
     * Show a toast message.
     */
    public static show(message: string, type: 'info' | 'error' | 'warning' = 'info'): void {
        if (!this.container) {
            console.warn('[ToastManager] No container set, ignoring toast:', message);
            return;
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        let icon = 'ℹ️';
        if (type === 'error') { icon = '❌'; }
        if (type === 'warning') { icon = '⚠️'; }

        toast.innerHTML = `<span>${icon}</span><span class="toast-msg">${message}</span><button class="toast-dismiss" aria-label="Dismiss">✕</button>`;
        this.container.appendChild(toast);

        // Shared dismiss: clears auto-timer, fades out, then removes
        let t1: NodeJS.Timeout;
        const dismiss = () => {
            clearTimeout(t1);
            this.activeTimeouts.delete(t1);
            toast.classList.add('fade-out');
            const t2 = setTimeout(() => {
                toast.remove();
                this.activeTimeouts.delete(t2);
            }, 300);
            this.activeTimeouts.add(t2);
        };

        // Wire dismiss button — stopPropagation prevents bubbling to the document-level
        // InteractionManager handler which calls ensureAudioContext() and can trigger
        // a store re-render that wipes the toast DOM.
        const btn = toast.querySelector<HTMLButtonElement>('.toast-dismiss');
        btn?.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            dismiss();
        }, { once: true });

        // Auto-remove after 8s
        t1 = setTimeout(dismiss, 8000);
        this.activeTimeouts.add(t1);
    }

    /**
     * Clear all active timeouts (for testing cleanup).
     */
    public static clearAll(): void {
        this.activeTimeouts.forEach(t => clearTimeout(t));
        this.activeTimeouts.clear();
    }
}
