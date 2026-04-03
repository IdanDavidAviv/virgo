/**
 * Common View-Model utilities for the Read Aloud Dashboard.
 */

/**
 * Basic HTML escaping to prevent XSS.
 */
export function escapeHtml(str: string): string {
    if (!str) { return ''; }
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Renders text with interactive file links: [label](file:///...) -> <a class="file-link">label</a>.
 */
export function renderWithLinks(text: string): string {
    if (!text) { return ''; }
    const html = escapeHtml(text);
    // Find [label](file:///...) and convert to <a>
    return html.replace(/\[([^\]]+)\]\((file:\/\/\/[^\s)]+)\)/g, (match, label, uri) => {
        return `<a class="file-link" data-uri="${uri}" title="Open in Editor">${label}</a>`;
    });
}

/**
 * High-performance debouncer for low-latency IPC throttling.
 */
export function debounce<T extends (...args: any[]) => any>(func: T, wait: number): (...args: Parameters<T>) => void {
    let timeout: any | null = null;
    return (...args: Parameters<T>) => {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => {
            func(...args);
        }, wait);
    };
}
