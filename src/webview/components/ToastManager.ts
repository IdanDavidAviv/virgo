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
        
        toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
        this.container.appendChild(toast);

        // Auto-remove after 4s
        const t1 = setTimeout(() => {
            toast.classList.add('fade-out');
            const t2 = setTimeout(() => {
                toast.remove();
                this.activeTimeouts.delete(t2);
            }, 300);
            this.activeTimeouts.add(t2);
            this.activeTimeouts.delete(t1);
        }, 4000);
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
