/**
 * ToastManager: Simple logic for managing dashboard toast notifications.
 * Extracted from legacy dashboard.js to provide a clean API for components.
 */
export class ToastManager {
    private static container: HTMLElement | null = null;

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
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }
}
