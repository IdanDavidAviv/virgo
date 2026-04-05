/**
 * PathGuard: Security utility for MCP resource path sanitization.
 * Prevents "Path Traversal" attacks by strictly validating identifiers.
 */
export class PathGuard {
    /**
     * Validates an identifier (protocol, sessionId, etc.) against a strict whitelist.
     * Allowed: lowercase alphanumeric, hyphens, and underscores.
     * @throws Error if validation fails.
     */
    public static sanitize(id: string, label: string = 'Identifier'): string {
        if (!id) {
            throw new Error(`[PathGuard] ${label} is missing.`);
        }

        // Strict whitelist: small alphanumeric, hyphens, underscores
        const regex = /^[a-z0-9_-]+$/i;
        if (!regex.test(id)) {
            throw new Error(`[PathGuard] Invalid ${label}: '${id}'. Only alphanumeric, hyphens, and underscores are allowed (Security Breach Prevention).`);
        }

        return id;
    }

    /**
     * Safely joins valid parts into a path.
     * Ensures each part is sanitized first.
     */
    public static safeJoin(base: string, ...parts: string[]): string {
        const sanitizedParts = parts.map(p => this.sanitize(p));
        const path = require('path');
        return path.join(base, ...sanitizedParts);
    }
}
